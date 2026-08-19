import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Paperclip, X, ArrowUp, Square, RotateCcw, Image, AlertTriangle, Search, Sparkles, FileText, Check, ChevronDown, Settings2 } from "lucide-react";
import { Spinner } from "./ui/Spinner.js";
import type { ChatMessage, ChatToolRecord } from "../types/chat.js";
import type { InnoModelInfo } from "../types/settings.js";
import type { InlineImage } from "../api/chat.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import type { CreateSessionInput } from "../api/sessions.js";
import { ApiError } from "../api/client.js";
import type { PresetMeta } from "../types/presets.js";
import { arrayBufferToBase64 } from "../api/uploads.js";
import { uploadWorkspaceFiles } from "../api/workspace.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { splitStreamingMarkdown } from "../utils/markdown-blocks.js";
import { fetchPresetList, readCachedPresets, removeCachedPreset } from "../utils/preset-cache.js";
import { answeredQuestionnaireFromTool, buildAnsweredQuestionnaireTimeline } from "../utils/questionnaire.js";
import type { AnsweredQuestionnaireView } from "../utils/questionnaire.js";
import { useStoreSnapshot } from "./hooks.js";
import { QuestionDialog } from "./QuestionDialog.js";
import { AnsweredQuestionCard } from "./chat/AnsweredQuestionCard.js";
import { buildConversationTurns, ConversationMinimap } from "./ConversationMinimap.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { ErrorBlock, MessageBubble, ToolRecordDetails } from "./chat/MessageBubble.js";
import { findPreset } from "./settings/provider-presets.js";
import { PresetPicker } from "./PresetPicker.js";

// Thresholds for showing a very large paste as a compact composer card. A
// paste crossing EITHER threshold is collapsed. The character threshold is
// only a paste-card safeguard; browser layout still determines text wrapping.
const PASTE_COLLAPSE_LINES = 20;
const PASTE_COLLAPSE_CHARS = 2000;
const COMPOSER_MIN_LINES = 2;
const COMPOSER_MAX_LINES = 8;

type PendingPasteBlock = {
	id: number;
	text: string;
};

type PresetRefreshStatus = "success" | "error";

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Brand asset when one exists; otherwise a recognizable custom AI mark. */
function ModelProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
	const preset = findPreset(provider);
	if (preset?.iconSrc) {
		return <img src={preset.iconSrc} alt="" aria-hidden="true" className="shrink-0 rounded object-contain" style={{ width: size, height: size }} />;
	}
	if (preset) return null;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 18 18"
			fill="none"
			aria-hidden="true"
			className="shrink-0"
		>
			<path d="M9 2.1v1.8" stroke="var(--inno-accent)" strokeWidth="1.15" strokeLinecap="round" />
			<circle cx="9" cy="1.8" r="1.05" fill="var(--inno-accent)" />
			<rect x="2" y="4" width="14" height="11.5" rx="3.5" fill="var(--inno-accent)" />
			<path d="M2 8.5H.9M16 8.5h1.1" stroke="var(--inno-accent)" strokeWidth="1.15" strokeLinecap="round" />
			<circle cx="6.3" cy="9.2" r="1.05" fill="white" />
			<circle cx="11.7" cy="9.2" r="1.05" fill="white" />
			<path d="M6.2 12.2h5.6" stroke="white" strokeWidth="1.25" strokeLinecap="round" />
		</svg>
	);
}

function resizeComposerTextarea(el: HTMLTextAreaElement): number {
	const styles = window.getComputedStyle(el);
	const fontSize = parseCssPixels(styles.fontSize) || 14;
	const lineHeight = parseCssPixels(styles.lineHeight) || fontSize * 1.25;
	const verticalPadding = parseCssPixels(styles.paddingTop) + parseCssPixels(styles.paddingBottom);
	const verticalBorder = parseCssPixels(styles.borderTopWidth) + parseCssPixels(styles.borderBottomWidth);
	const minHeight = Math.ceil(lineHeight * COMPOSER_MIN_LINES + verticalPadding + verticalBorder);
	const maxHeight = Math.ceil(lineHeight * COMPOSER_MAX_LINES + verticalPadding + verticalBorder);
	const selectionStart = el.selectionStart;
	const selectionEnd = el.selectionEnd;

	// Reset before measuring so shrinking after delete/cut/undo is symmetrical
	// with growth. scrollHeight is the browser's actual wrapped-text height.
	el.style.height = "auto";
	const contentHeight = el.scrollHeight + verticalBorder;
	const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
	el.style.height = `${nextHeight}px`;
	el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
	el.style.overflowX = "hidden";

	// Re-applying the existing selection lets the browser keep the caret in
	// view after the textarea changes between intrinsic and scrollable height.
	if (document.activeElement === el && selectionStart >= 0 && selectionEnd >= 0) {
		const restoreSelection = () => {
			if (document.activeElement === el) el.setSelectionRange(selectionStart, selectionEnd);
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(restoreSelection);
		else restoreSelection();
	}

	return minHeight;
}

// Inline chat images are sent to the provider as base64 inside the JSON body.
// Full-resolution photos (3–10 MB, +33% once base64-encoded) blow past the
// body-size limit of reverse proxies in front of providers (nginx defaults to
// 1 MB) and come back as HTTP 413, silently demoting the turn to the OCR
// fallback. Downscale/re-encode before sending so native vision turns
// actually reach the model. The target is deliberately well under 1 MB:
// base64 inflates ~4/3 and the body also carries the system prompt and
// conversation history.
const INLINE_IMAGE_MAX_DIMENSION = 1280;
const INLINE_IMAGE_TARGET_BYTES = 380 * 1024;
const INLINE_IMAGE_MAX_BYTES = 500 * 1024;

type PreparedInlineImage = InlineImage & { name: string; previewUrl: string };

function rawInlineImage(file: File, dataUrl: string): PreparedInlineImage {
	const commaIdx = dataUrl.indexOf(",");
	const header = dataUrl.slice(0, commaIdx);
	return {
		data: dataUrl.slice(commaIdx + 1),
		mimeType: header.match(/:(.*?);/)?.[1] ?? file.type,
		name: file.name || "image",
		previewUrl: dataUrl,
	};
}

/** Binary size estimate of a base64 data URL payload. */
function dataUrlBytes(dataUrl: string): number {
	return Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
}

/**
 * Re-encode as JPEG, shrinking quality first and then dimensions until the
 * payload fits INLINE_IMAGE_TARGET_BYTES. Returns the smallest result even
 * when the target can't be reached.
 */
function downscaleToFit(img: HTMLImageElement): string | undefined {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	let scale = Math.min(1, INLINE_IMAGE_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
	let quality = 0.8;
	let best: string | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
		// Flatten alpha onto white — JPEG has no transparency.
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		const outUrl = canvas.toDataURL("image/jpeg", quality);
		if (!best || outUrl.length < best.length) best = outUrl;
		if (dataUrlBytes(outUrl) <= INLINE_IMAGE_TARGET_BYTES) break;
		if (quality > 0.5) {
			quality -= 0.15;
		} else {
			scale *= 0.75;
			quality = 0.7;
		}
	}
	return best;
}

async function prepareInlineImage(file: File): Promise<PreparedInlineImage> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const passthrough = () => rawInlineImage(file, dataUrl);
	if (file.size <= INLINE_IMAGE_MAX_BYTES) return passthrough();
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			// `Image` the DOM constructor is shadowed by the lucide icon import.
			const el = document.createElement("img");
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("image decode failed"));
			el.src = dataUrl;
		});
		const outUrl = downscaleToFit(img);
		// Keep the original if re-encoding failed or produced a larger payload.
		if (!outUrl || outUrl.length >= dataUrl.length) return passthrough();
		return {
			data: outUrl.slice(outUrl.indexOf(",") + 1),
			mimeType: "image/jpeg",
			name: file.name || "image",
			previewUrl: outUrl,
		};
	} catch {
		return passthrough();
	}
}

interface PendingUpload {
	fileName: string;
	path: string;
	file: File;
}

/**
 * Memoized artifact for one closed block of a streaming reply. Closed blocks
 * never change, so they are parsed by marked/KaTeX exactly once and never
 * re-render — which also keeps the bubble's height monotonically growing
 * (no re-parse shrink that could yank the scroll position upwards).
 */
const StableStreamingMarkdown = memo(function StableStreamingMarkdown({ content }: { content: string }) {
	return <MarkdownArtifact content={content} />;
});

/**
 * Live-stream bubbles (thinking + reply text). Subscribes to the chat store
 * independently so the high-frequency text flushes re-render only this small
 * subtree, not the whole message list.
 */
function CompletedToolRecords({ tools }: { tools: ChatToolRecord[] }) {
	const views = tools.map((tool) => ({ tool, questionnaire: answeredQuestionnaireFromTool(tool) }));
	const regularTools = views.filter((item) => item.questionnaire === null).map((item) => item.tool);

	return regularTools.length ? (
				<motion.div
					className="flex justify-start"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.2 }}
				>
					<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
						<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Completed tool calls · {regularTools.length}</summary>
						<div className="mt-2 grid min-w-0 max-w-full gap-1.5">
							{regularTools.map((tool) => (
								<ToolRecordDetails key={tool.toolCallId} tool={tool} className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1" />
							))}
						</div>
					</details>
				</motion.div>
	) : null;
}

function StreamingBubbles() {
	const { t } = useTranslation();
	const stream = useStoreSnapshot(chatStore, () => ({
		text: chatStore.streamingText,
		thinking: chatStore.streamingThinking,
		target: chatStore.streamingTarget,
		// Low-frequency fields for the "waiting" dots — included here (rather
		// than read off ChatCenter's snapshot) so the dots live in the same
		// subtree that knows whether reply text has started.
		isSending: chatStore.isSending,
		hasError: chatStore.streamingError !== "",
		hasPendingQuestion: chatStore.pendingQuestion !== null,
		activeToolCount: chatStore.activeTools.length,
		completedTools: chatStore.completedTools,
	}));

	const questionnaires = useMemo(() => stream.completedTools.flatMap((tool): AnsweredQuestionnaireView[] => {
		const questionnaire = answeredQuestionnaireFromTool(tool);
		return questionnaire ? [{ tool, questionnaire }] : [];
	}), [stream.completedTools]);
	const timeline = useMemo(
		() => buildAnsweredQuestionnaireTimeline(stream.text, questionnaires),
		[stream.text, questionnaires],
	);
	const normalized = useMemo(() => normalizeMarkdownMath(timeline.tail), [timeline.tail]);
	const { blocks, tail } = useMemo(() => splitStreamingMarkdown(normalized), [normalized]);

	// Shrink guard: while a reply streams, the tail <markdown-artifact> re-parses
	// on every flush — code fences open and close as characters arrive, tables
	// snap into being when their separator row lands — and its height briefly
	// shrinks before settling taller. The stick-to-bottom pin faithfully
	// amplifies each transient shrink into a visible yank. Hold the bubble at
	// the tallest height seen so far (via min-height) so re-parse shrinks are
	// absorbed as blank space inside the bubble instead of moving the layout.
	// The callback ref re-arms per bubble mount, so each turn starts fresh.
	const heightWatermarkRef = useRef(0);
	const bubbleObserverRef = useRef<ResizeObserver | null>(null);
	const streamingBubbleRef = useCallback((el: HTMLDivElement | null) => {
		bubbleObserverRef.current?.disconnect();
		bubbleObserverRef.current = null;
		if (!el) return;
		heightWatermarkRef.current = 0;
		el.style.minHeight = "";
		const observer = new ResizeObserver(() => {
			const height = el.offsetHeight;
			if (height > heightWatermarkRef.current) heightWatermarkRef.current = height;
			const minHeight = `${heightWatermarkRef.current}px`;
			if (el.style.minHeight !== minHeight) el.style.minHeight = minHeight;
		});
		observer.observe(el);
		bubbleObserverRef.current = observer;
	}, []);

	return (
		<>
			{stream.thinking ? (
				<motion.div
					className="flex justify-start"
					initial={{ opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
						<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Thinking...</summary>
						<pre className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{stream.thinking}</pre>
					</details>
				</motion.div>
			) : null}

			{stream.text && stream.target === "workspace" ? (
				<motion.div
					key="workspace-streaming-status"
					className="flex justify-start"
					initial={{ opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] text-[var(--inno-text-muted)]">
						<div className="flex min-w-0 items-center gap-2">
							<span className="inno-stream-status-dot is-streaming shrink-0" />
							<span className="min-w-0 break-words [overflow-wrap:anywhere]">{t("chat.streamingInWorkspace", "长内容正在右侧文件区生成")}</span>
						</div>
					</div>
				</motion.div>
			) : stream.text || questionnaires.length ? (
				<motion.div
					key="chat-streaming-bubble"
					className="flex justify-start"
					initial={{ opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<div ref={streamingBubbleRef} className={`inno-message inno-streaming-blocks ${questionnaires.length > 0 ? "w-full max-w-[76%]" : "max-w-[78%]"} rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]`}>
						{timeline.entries.map(({ tool, questionnaire, before }) => (
							<Fragment key={tool.toolCallId}>
								{before.trim() ? <StableStreamingMarkdown content={normalizeMarkdownMath(before.trim())} /> : null}
								<div className="my-2">
									<AnsweredQuestionCard questionnaire={questionnaire} />
								</div>
							</Fragment>
						))}
						{blocks.map((block, index) => (
							<StableStreamingMarkdown key={index} content={block} />
						))}
						{/* Always mounted while text streams (even when the tail is
						    momentarily empty) so the DOM node — and the height below the
						    stable blocks — never churns mid-stream. */}
						<MarkdownArtifact content={tail} />
					</div>
				</motion.div>
			) : null}

			{stream.isSending && !stream.hasPendingQuestion && !stream.text && questionnaires.length === 0 && !stream.hasError && stream.activeToolCount === 0 ? (
				<motion.div
					className="flex justify-start"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.15 }}
				>
					<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2 text-sm text-[var(--inno-text-muted)]">
						<span className="inline-flex gap-1">
							<span className="animate-bounce">·</span>
							<span className="animate-bounce" style={{ animationDelay: "150ms" }}>·</span>
							<span className="animate-bounce" style={{ animationDelay: "300ms" }}>·</span>
						</span>
					</div>
				</motion.div>
			) : null}
		</>
	);
}

type WsMode = "temp" | "new" | "existing";

// Remember the user's last workspace choice for a new chat so the bottom
// "新建对话" button doesn't always reset to temp (P3). Persisted to localStorage
// rather than the backend — it's a per-device UI preference, not agent state.
const LAST_WS_MODE_KEY = "inno.lastWorkspaceMode";
const LAST_WS_ID_KEY = "inno.lastWorkspaceId";

function readLastWsMode(): WsMode {
	if (typeof window === "undefined") return "temp";
	const v = window.localStorage.getItem(LAST_WS_MODE_KEY);
	return v === "new" || v === "existing" ? v : "temp";
}

function readLastWsId(): string {
	if (typeof window === "undefined") return "";
	return window.localStorage.getItem(LAST_WS_ID_KEY) ?? "";
}

function rememberWsChoice(mode: WsMode, existingId: string): void {
	if (typeof window === "undefined") return;
	// Only "existing" is worth resuming verbatim; temp/new are fresh each time.
	window.localStorage.setItem(LAST_WS_MODE_KEY, mode === "existing" ? "existing" : "temp");
	if (mode === "existing" && existingId) {
		window.localStorage.setItem(LAST_WS_ID_KEY, existingId);
	}
}

function ModeChip({ selected, onClick, disabled, children }: { selected: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`rounded-full border px-1.5 py-px text-[10px] leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				selected
					? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
					: "border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
			}`}
		>
			{children}
		</button>
	);
}

export function ChatCenter() {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const welcomeLayoutRef = useRef<HTMLDivElement | null>(null);
	const welcomeComposerBaseHeightRef = useRef<number | null>(null);
	const draftRef = useRef("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const modelPickerRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const [uploads, setUploads] = useState<PendingUpload[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [inlineImages, setInlineImages] = useState<(InlineImage & { name: string; previewUrl: string })[]>([]);
	const [draftValue, setDraftValue] = useState(draftRef.current);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	// Very large text pastes are kept outside the textarea so they do not make
	// the composer enormous. Each paste keeps its own card and can be removed or
	// explicitly expanded back into the textarea at the current caret position.
	const [pasteBlocks, setPasteBlocks] = useState<PendingPasteBlock[]>([]);
	const pasteBlockIdRef = useRef(0);

	// Inline workspace chooser state (welcome screen only). Seeded from the
	// user's last choice (P3) so a new chat resumes the workspace they were in
	// rather than always resetting to temp.
	const [wsMode, setWsMode] = useState<WsMode>(() => readLastWsMode());
	const [wsName, setWsName] = useState("");
	const [wsExistingId, setWsExistingId] = useState(() => readLastWsId());
	const [wsError, setWsError] = useState("");

	// Simple Mode surfaces preset workspaces for one-click start.
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	// Model data is shared with the settings screen. Switching a model here uses
	// the same backend default-model endpoint, so the next message and the
	// settings screen stay in sync.
	const modelState = useStoreSnapshot(settingsStore, () => {
		const settings = settingsStore.settings;
		const models = settings?.availableModels ?? settings?.configuredModels ?? [];
		const current = models.find((model) => model.provider === settings?.defaultProvider && model.id === settings?.defaultModel);
		return {
			models,
			defaultProvider: settings?.defaultProvider ?? "",
			defaultModel: settings?.defaultModel ?? "",
			currentModelSupportsNativeImages: current?.input.includes("image") ?? true,
			isSavingModel: settingsStore.isSavingModel,
		};
	});
	const modelOptions = useMemo(() => {
		const seen = new Set<string>();
		return modelState.models.filter((model) => {
			const key = `${model.provider}:${model.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}, [modelState.models]);
	const currentModel = modelOptions.find((model) => model.provider === modelState.defaultProvider && model.id === modelState.defaultModel);
	const currentModelLabel = currentModel?.name || currentModel?.id || modelState.defaultModel || t("chat.modelUnavailable");
	const [presets, setPresets] = useState<PresetMeta[]>(() => readCachedPresets() ?? []);
	const [presetsLoaded, setPresetsLoaded] = useState(() => readCachedPresets() !== null);
	const [isLoadingPresets, setIsLoadingPresets] = useState(() => readCachedPresets() === null);
	const [isRefreshingPresets, setIsRefreshingPresets] = useState(false);
	const [presetsRefreshError, setPresetsRefreshError] = useState<string | null>(null);
	const [presetRefreshStatus, setPresetRefreshStatus] = useState<PresetRefreshStatus | null>(null);
	const presetRefreshStatusTimerRef = useRef<number | null>(null);
	const presetAutoRefreshStartedRef = useRef(false);
	const [openingPresetId, setOpeningPresetId] = useState<string | null>(null);
	const [togglingMode, setTogglingMode] = useState(false);
	const [presetQuery, setPresetQuery] = useState("");

	const cancelPresetRefreshStatusTimer = useCallback(() => {
		if (presetRefreshStatusTimerRef.current === null) return;
		window.clearTimeout(presetRefreshStatusTimerRef.current);
		presetRefreshStatusTimerRef.current = null;
	}, []);

	const showPresetRefreshStatus = useCallback((status: PresetRefreshStatus) => {
		cancelPresetRefreshStatusTimer();
		setPresetRefreshStatus(status);
		// Keep the failure marker visible until the next refresh attempt. A
		// successful refresh remains a transient confirmation for five seconds.
		if (status !== "success") return;
		presetRefreshStatusTimerRef.current = window.setTimeout(() => {
			setPresetRefreshStatus(null);
			presetRefreshStatusTimerRef.current = null;
		}, 5_000);
	}, [cancelPresetRefreshStatusTimer]);

	useEffect(() => () => cancelPresetRefreshStatusTimer(), [cancelPresetRefreshStatusTimer]);

	// Toggle between Simple and Normal mode from the welcome screen. The IA icon
	// plays a flip animation keyed on the resulting mode.
	const toggleMode = useCallback(() => {
		if (togglingMode) return;
		const next = !(settingsStore.settings?.simpleMode?.enabled === true);
		setTogglingMode(true);
		void settingsStore.saveSimpleMode(next).finally(() => setTogglingMode(false));
	}, [togglingMode]);

	const handleModelSelect = useCallback((model: InnoModelInfo) => {
		setModelPickerOpen(false);
		if (model.provider === modelState.defaultProvider && model.id === modelState.defaultModel) return;
		void settingsStore.switchModel(model.provider, model.id);
	}, [modelState.defaultModel, modelState.defaultProvider]);

	const openModelSettings = useCallback(() => {
		setModelPickerOpen(false);
		appStore.openSettings("models");
	}, []);

	useEffect(() => {
		if (!modelPickerOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!modelPickerRef.current?.contains(event.target as Node)) setModelPickerOpen(false);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setModelPickerOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [modelPickerOpen]);

	// NOTE: high-frequency streaming fields (streamingText / streamingThinking
	// / streamingTarget) are deliberately excluded — they flush every 40ms and
	// are subscribed to by StreamingBubbles instead, so token growth re-renders
	// only that subtree. Combined with the shallow-equal guard in
	// useStoreSnapshot, streaming emits no longer re-render ChatCenter at all.
	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		isSending: chatStore.isSending,
		isLoadingHistory: chatStore.isLoadingHistory,
		streamingActivity: chatStore.streamingActivity,
		streamingActivityDetail: chatStore.streamingActivityDetail,
		streamingError: chatStore.streamingError,
		canReconnect: chatStore.canReconnect,
		activeTools: chatStore.activeTools,
		completedTools: chatStore.completedTools,
		lastUserPrompt: chatStore.lastUserPrompt,
		pendingQuestion: chatStore.pendingQuestion,
	}));
	const sessions = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		preselectedWorkspaceId: sessionsStore.preselectedWorkspaceId,
		busyBlocker: sessionsStore.busyBlocker,
		// Single source of truth for the welcome-vs-session view (see store).
		// Depends on chatStore too, but ChatCenter subscribes to chatStore via
		// the `chat` snapshot above, so this re-evaluates on chat changes.
		isWelcome: sessionsStore.isWelcomeView,
	}));
	const workspaces = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));
	const loadedPresetIds = useMemo(
		() => new Set(
			workspaces.list
				.filter((workspace) => workspace.id.startsWith("preset-"))
				.map((workspace) => workspace.id.slice("preset-".length)),
		),
		[workspaces.list],
	);
	// Active workspace for the current session — drives upload target + button
	// availability. Synced by sessionsStore on openSession/createSession, and
	// pre-seeded by the useEffect below when the welcome screen's "existing"
	// workspace picker selects one.
	const activeWorkspaceId = useStoreSnapshot(workspaceStore, () => workspaceStore.activeWorkspaceId);

	// Workspace preselected from the sidebar ("+ 新建对话" on a group), if any.
	const preselectedWs = useMemo(
		() => sessions.preselectedWorkspaceId
			? workspaces.list.find((w) => w.id === sessions.preselectedWorkspaceId) ?? null
			: null,
		[sessions.preselectedWorkspaceId, workspaces.list],
	);

	// User project workspaces the user can pick for a new chat — excludes the
	// shared temp workspace and the channel-native workspaces (feishu/wechat/cli),
	// matching the sidebar's grouping. Lets the bottom "新建对话" button reach an
	// existing workspace instead of being forced into temp/new.
	const selectableWorkspaces = useMemo(
		() => workspaces.list.filter((w) => !w.isTemp && !w.id.startsWith("channel-")),
		[workspaces.list],
	);

	// Welcome state: derived once in the sessions store (single source of truth).
	const isWelcome = sessions.isWelcome;
	// Workspace that will receive pending attachments when Send is clicked.
	// File selection itself never writes to this workspace, so attachments may
	// safely follow the composer across session switches.
	const uploadWorkspaceId: string | undefined | null = isWelcome
		? (simpleMode || wsMode === "temp"
			? undefined
			: wsMode === "existing" && wsExistingId
				? wsExistingId
				: null)
		: activeWorkspaceId;
	const hasSendableContent = Boolean(
		draftValue.trim()
		|| pasteBlocks.some((block) => block.text.trim())
		|| uploads.length > 0
		|| inlineImages.length > 0,
	);
	const turnIndexByStartMessage = useMemo(
		() => new Map(buildConversationTurns(chat.messages).map((turn) => [turn.startMessageIndex, turn.index])),
		[chat.messages],
	);

	useEffect(() => {
		if (isWelcome && workspaces.list.length === 0) {
			void workspacesStore.load();
		}
	}, [isWelcome, workspaces.list.length]);

	// A remembered "existing" workspace id may point at a since-deleted
	// workspace. Once the list loads, fall back to temp if it's gone so the
	// chooser never sticks on an invalid selection (P3).
	useEffect(() => {
		if (wsMode === "existing" && wsExistingId && workspaces.list.length > 0) {
			const stillExists = selectableWorkspaces.some((w) => w.id === wsExistingId);
			if (!stillExists) {
				setWsMode("temp");
				setWsExistingId("");
			}
		}
	}, [wsMode, wsExistingId, workspaces.list.length, selectableWorkspaces]);

	// A workspace preselected from the sidebar drives the chooser to "existing"
	// mode bound to that workspace (and previews it in quarter mode).
	useEffect(() => {
		if (sessions.preselectedWorkspaceId) {
			setWsMode("existing");
			setWsExistingId(sessions.preselectedWorkspaceId);
		}
	}, [sessions.preselectedWorkspaceId]);

	// When a workspace is preselected for a new chat, preview it immediately
	// (before the first message) in quarter mode so the file tree shows.
	useEffect(() => {
		if (isWelcome && wsMode === "existing" && wsExistingId) {
			void workspaceStore.setActiveWorkspace(wsExistingId);
			appStore.setRightPanelTab("preview");
			if (
				appStore.workspaceMode === "collapsed"
				&& sessions.preselectedWorkspaceId === wsExistingId
			) {
				appStore.setWorkspaceWidth(300);
				appStore.setWorkspaceMode("quarter");
			}
		}
	}, [isWelcome, wsMode, wsExistingId, sessions.preselectedWorkspaceId]);

	// Stick-to-bottom scrolling, driven by a ResizeObserver on the content
	// column: any height change — streaming flushes, Lit's async markdown
	// renders, KaTeX, code highlighting, images — re-pins the scroll position
	// in the same frame the growth happens. (The previous effect-based rAF
	// scroll only fired when specific React state changed, so async renders
	// between flushes left the view behind; combined with transient height
	// shrink during re-parses, the pinned scrollTop got clamped and the view
	// jumped back up towards the question.)
	//
	// The sticky flag is updated ONLY in response to genuine user gestures
	// (wheel / touch / scrollbar drag / keyboard). Scroll-position changes also
	// come from our own pins, from browser clamping after transient content
	// shrink, and from CSS scroll anchoring during markdown re-renders — all of
	// which fire scroll events whose distance-from-bottom says nothing about
	// user intent. Treating those as "user scrolled away" wrongly disengaged
	// sticking, and the view ended up back near the question at turn end.
	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.querySelector<HTMLElement>("[data-conversation-content]");
		if (!el || !content) return;
		const observer = new ResizeObserver(() => {
			if (!shouldStickToBottomRef.current) return;
			el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [sessions.currentSessionId]);

	useEffect(() => {
		shouldStickToBottomRef.current = true;
	}, [sessions.currentSessionId]);

	const userScrollGestureRef = useRef(false);
	const markUserScrollGesture = useCallback(() => {
		userScrollGestureRef.current = true;
	}, []);
	// Only presses on the scrollbar track (right edge) count as scroll gestures —
	// plain content clicks (text selection, links, buttons) must not, or the next
	// programmatic/anchoring scroll event would be mistaken for user intent.
	const handleScrollerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const el = scrollRef.current;
		if (!el) return;
		if (event.clientX >= el.getBoundingClientRect().right - 24) markUserScrollGesture();
	}, [markUserScrollGesture]);

	const handleChatScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		// Reaching the bottom always re-engages sticking, no matter how the
		// scroll was initiated (user gesture, smooth-scroll button, or a pin).
		if (distanceFromBottom < 96) {
			shouldStickToBottomRef.current = true;
			userScrollGestureRef.current = false;
			return;
		}
		// Away from the bottom: only a real user gesture may disengage sticking.
		// Echoes of programmatic pins, clamping, and scroll-anchoring shifts are
		// ignored — see the comment above the observer.
		if (!userScrollGestureRef.current) return;
		userScrollGestureRef.current = false;
		shouldStickToBottomRef.current = false;
	}, []);

	const pauseAutoScroll = useCallback(() => {
		shouldStickToBottomRef.current = false;
	}, []);

	const resizeInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;

		const minHeight = resizeComposerTextarea(el);
		const welcomeLayout = welcomeLayoutRef.current;
		if (!welcomeLayout) return;
		const composer = el.closest<HTMLElement>(".inno-composer");
		if (!composer) return;

		// Use the whole composer height instead of only the textarea height. This
		// includes image rows and the large-paste card, so wrapping an attachment
		// also moves the upper welcome block by half of the added height.
		const textareaHeight = el.getBoundingClientRect().height;
		const composerHeight = composer.getBoundingClientRect().height;
		if (welcomeComposerBaseHeightRef.current === null) {
			welcomeComposerBaseHeightRef.current = composerHeight - textareaHeight + minHeight;
		}
		const composerGrowth = Math.max(0, composerHeight - welcomeComposerBaseHeightRef.current);
		const requestedHalfGrowth = composerGrowth / 2;
		// Move the upper welcome block up with the composer. The lower preset
		// content stays in normal flow and is pushed down by the expansion.
		welcomeLayout.style.setProperty("--inno-welcome-composer-half-growth", `${requestedHalfGrowth}px`);
	}, []);

	useEffect(() => {
		welcomeComposerBaseHeightRef.current = null;
		const el = inputRef.current;
		if (!el) return;
		resizeInput();
		if (typeof ResizeObserver === "undefined") return;

		let lastWidth = Math.round(el.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			const nextWidth = Math.round(entry.contentRect.width);
			if (nextWidth === lastWidth) return;
			lastWidth = nextWidth;
			resizeInput();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [isWelcome, resizeInput]);

	// Attachment rows and the large-paste card change the composer's block size
	// after React commits; measure again so welcome positioning stays centered.
	useEffect(() => {
		if (isWelcome) resizeInput();
	}, [isWelcome, inlineImages, pasteBlocks, resizeInput]);

	const handleInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		draftRef.current = el.value;
		setDraftValue(el.value);
		resizeInput();
	}, [resizeInput]);

	const buildSessionInput = useCallback((): CreateSessionInput | { __error: string } => {
		// Simple Mode: no workspace chooser. Direct chat always goes to a temp
		// workspace; presets are opened via openPreset into their own workspace.
		if (simpleMode) return { newWorkspace: { isTemp: true } };
		if (wsMode === "temp") return { newWorkspace: { isTemp: true } };
		if (wsMode === "new") {
			const trimmed = wsName.trim();
			if (!trimmed) return { __error: t("chat.errWsName") };
			return { newWorkspace: { name: trimmed, isTemp: false } };
		}
		if (!wsExistingId) return { __error: t("chat.errWsSelect") };
		return { workspaceId: wsExistingId };
	}, [simpleMode, wsMode, wsName, wsExistingId, t]);

	const loadPresets = useCallback(async (forceRefresh = false) => {
		setPresetsRefreshError(null);
		if (forceRefresh) {
			cancelPresetRefreshStatusTimer();
			setPresetRefreshStatus(null);
		}
		if (!forceRefresh) {
			const cached = readCachedPresets();
			if (cached !== null) {
				setPresets(cached);
				setPresetsLoaded(true);
				setIsLoadingPresets(false);
				return;
			}
		}
		if (forceRefresh) {
			setIsRefreshingPresets(true);
		} else {
			setIsLoadingPresets(true);
		}
		try {
			const next = await fetchPresetList(forceRefresh);
			setPresets(next);
			setPresetsLoaded(true);
			if (forceRefresh) {
				showPresetRefreshStatus("success");
			}
		} catch {
			// Keep the last successful list visible and avoid leaking transport
			// details such as the English "fetch failed" into the localized UI.
			setPresetsRefreshError(t("presets.refreshFailed"));
			showPresetRefreshStatus("error");
		} finally {
			setIsLoadingPresets(false);
			setIsRefreshingPresets(false);
		}
	}, [cancelPresetRefreshStatusTimer, showPresetRefreshStatus, t]);

	// Refresh the preset catalog once when the app first opens in Simple Mode.
	// ChatCenter stays mounted across session changes, so this also works when
	// the app restores an existing session instead of showing the welcome view.
	// Cached cards render immediately; the forced request updates them in the
	// background and reuses the same success/error indicator as manual refresh.
	useEffect(() => {
		if (!simpleMode || presetAutoRefreshStartedRef.current) return;
		presetAutoRefreshStartedRef.current = true;
		void loadPresets(true);
	}, [simpleMode, loadPresets]);

	// One-click open: instantiate the preset into a fresh workspace + session and
	// reveal it in the right panel.
	const openPreset = useCallback((presetId: string) => {
		setWsError("");
		setOpeningPresetId(presetId);
		void (async () => {
			try {
				await sessionsStore.createSessionWith({ presetId });
				appStore.setRightPanelTab("preview");
				appStore.setWorkspaceWidth(560);
				appStore.setWorkspaceMode("half");
			} catch (err) {
				const unavailable = err instanceof ApiError
					&& err.status === 404
					&& err.data?.code === "PRESET_UNAVAILABLE";
				if (unavailable) {
					setPresets((current) => current.filter((preset) => preset.id !== presetId));
					removeCachedPreset(presetId);
				} else {
					setWsError(err instanceof Error ? err.message : t("chat.errOpenPreset"));
				}
			} finally {
				setOpeningPresetId(null);
			}
		})();
	}, [t]);

	const handleSend = useCallback(() => {
		const rawValue = inputRef.current?.value ?? draftValue;
		const input = [
			rawValue.trim(),
			...pasteBlocks.map((block) => block.text.trim()),
		]
			.filter(Boolean)
			.join("\n\n");
		if ((!input && uploads.length === 0 && inlineImages.length === 0) || chat.isSending || isUploading) return;
		shouldStickToBottomRef.current = true;
		const pendingUploads = [...uploads];
		const pendingImages = [...inlineImages];

		const resetComposer = () => {
			draftRef.current = "";
			setDraftValue("");
			if (inputRef.current) {
				inputRef.current.value = "";
				resizeInput();
			}
			setPasteBlocks([]);
		};

		void (async () => {
			setIsUploading(true);
			try {
				let targetSessionId = sessions.currentSessionId;
				if (isWelcome) {
					const wsInput = buildSessionInput();
					if ("__error" in wsInput) {
						setWsError(wsInput.__error);
						return;
					}
					setWsError("");
					// Remember the workspace choice so the next new chat resumes it (P3).
					if (!simpleMode) rememberWsChoice(wsMode, wsExistingId);
					await sessionsStore.createSessionWith(wsInput);
					targetSessionId = sessionsStore.currentSessionId;
				}

				const targetWorkspaceId = workspaceStore.activeWorkspaceId
					?? (isWelcome ? undefined : uploadWorkspaceId ?? undefined);
				if (pendingUploads.length > 0 && targetWorkspaceId === undefined) {
					throw new Error(t("chat.uploadHint"));
				}

				let uploadedFiles: Array<{ fileName: string; path: string }> = [];
				if (pendingUploads.length > 0) {
					const uploadItems = await Promise.all(
						pendingUploads.map(async ({ path, file }) => ({
							path,
							dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
						})),
					);
					const result = await uploadWorkspaceFiles(
						uploadItems,
						targetWorkspaceId,
					);
					uploadedFiles = (result.uploaded ?? []).map((node) => ({
						fileName: node.name,
						path: node.path,
					}));
					appStore.setRightPanelTab("preview");
					if (appStore.workspaceMode === "collapsed") appStore.setWorkspaceMode("quarter");
					if (workspaceStore.activeWorkspaceId !== targetWorkspaceId) {
						await workspaceStore.setActiveWorkspace(targetWorkspaceId ?? null);
					} else {
						await workspaceStore.loadTree();
					}
				}

				const uploadNote = uploadedFiles.length > 0
					? `\n\n${t("chat.uploadedToWorkspace")}\n${uploadedFiles.map((file) => `- ${file.fileName}: ${file.path}`).join("\n")}`
					: "";
				const messageContent = `${input}${uploadNote}` || (pendingImages.length > 0 ? t("chat.describeImage") : "");
				const imagesToSend = pendingImages.length > 0
					? pendingImages.map(({ data, mimeType }) => ({ data, mimeType }))
					: undefined;

				resetComposer();
				setUploads([]);
				setInlineImages([]);
				setWsError("");
				void chatStore.send(messageContent, imagesToSend, targetSessionId);
			} catch (err) {
				setWsError(err instanceof Error ? err.message : t("chat.errCreateSession"));
			} finally {
				setIsUploading(false);
			}
		})();
	}, [isWelcome, buildSessionInput, uploads, inlineImages, chat.isSending, isUploading, simpleMode, wsMode, wsExistingId, uploadWorkspaceId, pasteBlocks, draftValue, sessions.currentSessionId, resizeInput, t]);

	const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Don't fire Send while the user is composing with an IME (e.g. picking
		// a Chinese / Japanese candidate). The Enter that selects a candidate
		// reports keyCode 229 and / or `isComposing = true` and must not be
		// treated as "submit".
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
	}, [handleSend]);

	const handleStop = useCallback(() => {
		chatStore.cancel();
	}, []);

	const handleReconnect = useCallback(() => {
		void chatStore.reconnect();
	}, []);

	const handleRetry = useCallback(() => {
		shouldStickToBottomRef.current = true;
		void chatStore.retry();
	}, []);

	const addImageFiles = useCallback((files: File[]) => {
		files.forEach((file) => {
			void prepareInlineImage(file).then((prepared) => {
				setInlineImages((prev) => [...prev, prepared]);
			});
		});
	}, []);

	const showPasteInTextField = useCallback((blockId: number) => {
		const el = inputRef.current;
		const block = pasteBlocks.find((item) => item.id === blockId);
		if (!block || !el) return;
		// Browsers retain a textarea's selection after it loses focus to the
		// card button, so use that last caret/selection rather than appending
		// blindly to the end.
		const start = Math.min(el.selectionStart, el.value.length);
		const end = Math.min(el.selectionEnd, el.value.length);
		el.focus();
		el.setRangeText(block.text, start, end, "end");
		draftRef.current = el.value;
		setDraftValue(el.value);
		setPasteBlocks((prev) => prev.filter((item) => item.id !== blockId));
		resizeInput();
	}, [pasteBlocks, resizeInput]);

	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		// Image paste: keep existing behavior.
		const imageItems = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/"));
		if (imageItems.length > 0) {
			e.preventDefault();
			const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
			addImageFiles(files);
			return;
		}
		// Large text paste: keep the real content in a compact card outside the
		// textarea. The text only enters the textarea when the user asks to show
		// it there, at which point normal browser sizing and scrolling apply.
		const text = e.clipboardData.getData("text/plain");
		if (text) {
			const lineCount = text.split(/\r\n|\r|\n/).length;
			const charCount = text.length;
			if (lineCount > PASTE_COLLAPSE_LINES || charCount > PASTE_COLLAPSE_CHARS) {
				e.preventDefault();
				const id = pasteBlockIdRef.current++;
				setPasteBlocks((prev) => [...prev, { id, text }]);
			}
		}
	}, [addImageFiles]);

	const handleImageFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []).filter((f) => f.type.startsWith("image/"));
		if (files.length === 0) return;
		addImageFiles(files);
		if (event.target) event.target.value = "";
	}, [addImageFiles]);

	const removeInlineImage = useCallback((index: number) => {
		setInlineImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		if (files.length === 0) return;
		setWsError("");
		const items = files.map((file) => ({
			fileName: file.name,
			path: file.name.replace(/[\\/?%*:|"<>]/g, "_").trim() || `upload-${Date.now()}`,
			file,
		}));
		setUploads((current) => [...current, ...items]);
		if (event.target) event.target.value = "";
	}, []);

	const removeUpload = useCallback((index: number) => {
		setUploads((current) => current.filter((_, i: number) => i !== index));
	}, []);

	const renderUploadChips = () => (
		uploads.length > 0 ? (
			<div className="mb-2 flex flex-wrap gap-1.5">
				{uploads.map((file, index: number) => (
					<span key={`${file.path}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-xs shadow-sm">
						<span className="max-w-[220px] truncate">{file.fileName}</span>
						<span className="text-[var(--inno-text-muted)]">{file.path}</span>
						<button className="text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]" title={t("chat.removeUpload")} onClick={() => removeUpload(index)}>
							<X size={14} />
						</button>
					</span>
				))}
			</div>
		) : null
	);

	const renderInlineImagePreviews = () => (
		inlineImages.length > 0 ? (
			<div className="flex flex-wrap gap-1.5">
				{inlineImages.map((img, index) => (
					<span key={`${img.name}-${index}`} className="relative inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-1 shadow-sm">
						<img src={img.previewUrl} alt={img.name} className="h-12 w-12 rounded object-cover" />
						<button
							className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] shadow-sm hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)]"
							title={t("chat.removeImage")}
							onClick={() => removeInlineImage(index)}
						>
							<X size={12} />
						</button>
					</span>
				))}
			</div>
		) : null
	);

	const renderPasteBlock = (block: PendingPasteBlock) => {
		const preview = block.text.split(/\r\n|\r|\n/)[0].trim() || t("common.pasteCardTitle");
		return (
			<div className="inno-paste-card" role="group" aria-label={t("common.pasteCardTitle")}>
				<span className="inno-paste-card-icon" aria-hidden="true">
					<FileText size={16} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs text-[var(--inno-text)]" title={preview}>{preview}</div>
					<div className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--inno-text-muted)]">
						<button
							type="button"
							className="inno-paste-card-action"
							onClick={() => showPasteInTextField(block.id)}
						>
							{t("common.pasteCardShowInTextField")}
						</button>
						<span aria-hidden="true">›</span>
					</div>
				</div>
				<button
					type="button"
					className="inno-paste-card-remove"
					title={t("common.pasteCardRemove")}
					aria-label={t("common.pasteCardRemove")}
					onClick={() => setPasteBlocks((prev) => prev.filter((item) => item.id !== block.id))}
				>
					<X size={14} />
				</button>
			</div>
		);
	};

	const renderComposerAttachments = () => (
		inlineImages.length > 0 || pasteBlocks.length > 0 ? (
			<div className="inno-composer-attachments mb-1 flex min-w-0 flex-wrap items-start gap-2">
				{renderInlineImagePreviews()}
				{pasteBlocks.map((block) => (
					<Fragment key={block.id}>
						{renderPasteBlock(block)}
					</Fragment>
				))}
			</div>
		) : null
	);

	const renderModelPicker = () => (
		<div ref={modelPickerRef} className="inno-composer-model-picker relative ml-auto shrink-0">
			<button
				type="button"
				className="inno-composer-model-trigger flex h-8 shrink-0 items-center gap-1 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
				title={t("chat.selectModel")}
				aria-label={t("chat.selectModel")}
				aria-haspopup="menu"
				aria-expanded={modelPickerOpen}
				disabled={modelOptions.length === 0 || modelState.isSavingModel || chat.isSending}
				onClick={() => setModelPickerOpen((open) => !open)}
			>
								{modelState.defaultProvider ? <ModelProviderIcon provider={currentModel?.provider ?? modelState.defaultProvider} /> : null}
				<span className="whitespace-nowrap">{currentModelLabel}</span>
				<ChevronDown size={13} className="shrink-0" />
			</button>
			{modelPickerOpen && modelOptions.length > 0 ? (
				<div className="inno-composer-model-menu" role="menu" aria-label={t("chat.selectModel")}>
					{modelOptions.map((model) => {
						const selected = model.provider === modelState.defaultProvider && model.id === modelState.defaultModel;
						return (
							<button
								key={`${model.provider}:${model.id}`}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								className={`inno-composer-model-option ${selected ? "is-selected" : ""}`}
								disabled={modelState.isSavingModel || chat.isSending}
								onClick={() => handleModelSelect(model)}
									title={model.id}
							>
								<span className="flex min-w-0 items-center gap-2">
									<ModelProviderIcon provider={model.provider} />
									<span className="min-w-0 truncate">{model.name || model.id}</span>
								</span>
								{selected ? <Check size={14} className="shrink-0" /> : null}
							</button>
						);
					})}
					<div className="inno-composer-model-menu-footer">
						<button type="button" className="inno-composer-model-manage" role="menuitem" onClick={openModelSettings}>
							<Settings2 size={14} />
							<span>{t("chat.manageModels")}</span>
						</button>
					</div>
				</div>
			) : null}
		</div>
	);

	const renderQuestionHint = () => (
		chat.pendingQuestion ? (
			<div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-accent-soft)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)]">
				<AlertTriangle size={14} className="shrink-0 text-[var(--inno-warning)]" />
				<span>{t("common.questionPending")}</span>
				<button
					className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-[var(--inno-warning)] hover:bg-[var(--inno-surface-muted)]"
					onClick={() => {
						const el = scrollRef.current;
						if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
					}}
				>
					{t("common.questionPendingJump")}
				</button>
			</div>
		) : null
	);

	const renderBusyBlocker = () => (
		sessions.busyBlocker ? (
			<div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-accent-soft)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)]">
				<AlertTriangle size={14} className="shrink-0 text-[var(--inno-warning)]" />
				<span>{t(sessions.busyBlocker.questionPending ? "common.sessionBusyQuestion" : "common.sessionBusy")}</span>
				<button
					className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-[var(--inno-warning)] hover:bg-[var(--inno-surface-muted)]"
					onClick={() => void sessionsStore.stopBusyBlockerAndRetry()}
				>
					{t("common.sessionBusyStop")}
				</button>
				<button
					className="shrink-0 rounded px-2 py-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)]"
					onClick={() => sessionsStore.dismissBusyBlocker()}
				>
					{t("common.sessionBusyDismiss")}
				</button>
			</div>
		) : null
	);

	const renderComposer = (placeholder: string) => {
		const sendDisabled = !hasSendableContent || isUploading;
		return (
			<div className="inno-composer rounded-2xl p-2">
				<input ref={fileInputRef} id="file-input" type="file" className="hidden" multiple onChange={handleFiles} />
				<input ref={imageInputRef} id="image-input" type="file" className="hidden" multiple accept="image/*" onChange={handleImageFiles} />
				{renderComposerAttachments()}
				<textarea
					ref={inputRef}
					id="chat-input"
					defaultValue={draftRef.current}
					className="inno-composer-textarea w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
					placeholder={placeholder}
					rows={2}
					onKeyDown={handleKeyDown}
					onInput={handleInput}
					onPaste={handlePaste}
					disabled={chat.isSending || isUploading || !!chat.pendingQuestion}
				/>
				<div className="inno-composer-toolbar flex shrink-0 items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
							title={t("chat.uploadFiles")}
							disabled={chat.isSending || isUploading}
							onClick={() => fileInputRef.current?.click()}
						>
							{isUploading ? <Spinner size={16} /> : <Paperclip size={16} />}
						</button>
						<button
							type="button"
							className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
							title={modelState.currentModelSupportsNativeImages ? t("chat.attachImage") : t("chat.attachImageViaOcr")}
							disabled={chat.isSending || isUploading}
								onClick={() => imageInputRef.current?.click()}
						>
							<Image size={16} />
						</button>
					</div>
					{renderModelPicker()}
					<div className="flex shrink-0 items-center gap-1">
						{chat.isSending ? (
							<>
								{chat.canReconnect ? (
									<button
										type="button"
										className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full"
										title={t("chat.reconnect", "重新连接")}
										onClick={handleReconnect}
									>
										<RotateCcw size={16} />
									</button>
								) : null}
								<button
									type="button"
									className="inno-composer-stop flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-opacity hover:opacity-90 active:scale-[0.97]"
									title={t("chat.stopGeneration")}
									onClick={handleStop}
								>
									<Square size={15} />
								</button>
							</>
						) : (
							<>
								{chat.lastUserPrompt ? (
									<button
										type="button"
										className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
										title={t("chat.retryLast")}
										disabled={isUploading}
										onClick={handleRetry}
									>
										<RotateCcw size={16} />
									</button>
								) : null}
								<button
									type="button"
									className={`inno-composer-send flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${sendDisabled ? "is-disabled" : ""}`}
									title={t("chat.send")}
									disabled={sendDisabled}
									onClick={handleSend}
								>
									<ArrowUp size={16} strokeWidth={2} />
								</button>
							</>
						)}
					</div>
				</div>
			</div>
		);
	};

	/* ── Welcome layout: centered composer + inline workspace chooser ── */
	if (isWelcome) {
		return (
			<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
				<div className="inno-chat-grid flex flex-1 min-h-0 justify-center overflow-y-auto px-4">
					<div ref={welcomeLayoutRef} className="inno-welcome-layout w-full max-w-2xl pt-[18vh] pb-12">
						<div className="inno-welcome-upper">
						<div className="mb-6 flex flex-col items-center text-center">
							<button
								type="button"
								onClick={toggleMode}
								disabled={togglingMode}
								title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.currentNormalClickSimple")}
								aria-label={simpleMode ? t("mode.switchToNormal") : t("mode.switchToSimple")}
								className="flip-card-scene mb-3 rounded-xl outline-none focus-visible:shadow-[var(--inno-ring)] disabled:cursor-wait"
							>
								<motion.div
									animate={{ rotateY: simpleMode ? 180 : 0 }}
									transition={{ type: "spring", stiffness: 320, damping: 22 }}
									className="flip-card flex h-12 w-12 items-center justify-center"
								>
									{/* Front — Normal mode */}
									<span
										className="flip-card-face absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-base font-semibold text-[var(--inno-accent)] shadow-sm transition-colors hover:border-[var(--inno-accent)]"
									>
										IA
									</span>
									{/* Back — Simple mode */}
									<span
										className="flip-card-back absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--inno-accent)] bg-[var(--inno-accent)] text-base font-semibold text-white shadow-sm"
									>
										IA
									</span>
								</motion.div>
							</button>
							<h2 className="text-lg font-medium text-[var(--inno-text)]">Inno Agent</h2>
							{/* Explicit, labeled mode switch (P4): the flip logo above is a nice
							    secondary affordance, but a worded pill makes the toggle
							    discoverable instead of hidden behind an icon click. */}
							<button
								type="button"
								onClick={toggleMode}
								disabled={togglingMode}
								className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1 text-[11px] text-[var(--inno-text-muted)] transition-colors hover:border-[var(--inno-accent)] hover:text-[var(--inno-accent)] disabled:cursor-wait disabled:opacity-60"
							>
								<span className={`h-1.5 w-1.5 rounded-full ${simpleMode ? "bg-[var(--inno-accent)]" : "bg-[var(--inno-border-strong)]"}`} />
								{simpleMode ? t("mode.simpleShort") : t("mode.normalShort")}
							</button>
						</div>

						{renderUploadChips()}
						{renderQuestionHint()}
						{renderBusyBlocker()}
						</div>
						<div className="inno-welcome-composer-shell">
							{renderComposer(t("chat.welcomePlaceholder"))}
						</div>

						{simpleMode && (presets.length > 0 || presetsLoaded || isLoadingPresets || presetsRefreshError) ? (
							<PresetPicker
								presets={presets}
								loadedPresetIds={loadedPresetIds}
								isLoading={isLoadingPresets}
								isRefreshing={isRefreshingPresets}
								refreshStatus={presetRefreshStatus}
								openingPresetId={openingPresetId}
								onOpen={openPreset}
								onRefresh={() => void loadPresets(true)}
								query={presetQuery}
								onQueryChange={setPresetQuery}
								t={t}
							/>
						) : null}

						{simpleMode ? null : preselectedWs ? (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-[var(--inno-text-subtle)]">{t("workspace.title")}</span>
								<span className="rounded-full bg-[var(--inno-accent-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--inno-accent)]">
									{preselectedWs.name}
								</span>
								<span className="text-[10px] text-[var(--inno-text-subtle)]">{t("chat.newChatHere")}</span>
							</div>
						) : (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-[var(--inno-text-subtle)]">{t("workspace.title")}</span>
								<ModeChip selected={wsMode === "temp"} onClick={() => setWsMode("temp")}>{t("chat.wsTemp")}</ModeChip>
								<ModeChip selected={wsMode === "new"} onClick={() => setWsMode("new")}>{t("chat.wsNew")}</ModeChip>
								{selectableWorkspaces.length > 0 ? (
									<ModeChip selected={wsMode === "existing"} onClick={() => setWsMode("existing")}>{t("chat.wsExisting")}</ModeChip>
								) : null}
								{wsMode === "new" ? (
									<input
										type="text"
										placeholder={t("chat.wsNamePlaceholder")}
										value={wsName}
										onChange={(e) => setWsName(e.target.value)}
										className="ml-1 w-[200px] rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-px text-[10px] leading-tight outline-none focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									/>
								) : null}
								{wsMode === "existing" ? (
									<select
										value={wsExistingId}
										onChange={(e) => setWsExistingId(e.target.value)}
										className="ml-1 max-w-[220px] rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-px text-[10px] leading-tight outline-none focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									>
										<option value="">{t("chat.wsSelectPlaceholder")}</option>
										{selectableWorkspaces.map((w) => (
											<option key={w.id} value={w.id}>{w.name}</option>
										))}
									</select>
								) : null}
							</div>
						)}

						{wsError ? <p className="mt-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
					</div>
				</div>
			</section>
		);
	}

	/* ── Normal layout: scrollable messages + bottom composer ── */
	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="conversation-stage relative flex-1 min-h-0">
				<div
					ref={scrollRef}
					onScroll={handleChatScroll}
					onWheel={markUserScrollGesture}
					onTouchStart={markUserScrollGesture}
					onPointerDown={handleScrollerPointerDown}
					className="chat-scroll inno-chat-grid h-full min-h-0 overflow-y-auto px-4 py-4"
				>
					<div data-conversation-content className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
					{chat.isLoadingHistory && chat.messages.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center pt-20 text-[var(--inno-text-muted)]">
							<Spinner size={20} className="mb-3 text-[var(--inno-border-strong)]" />
							<p className="text-sm">{t("chat.loadingSession")}</p>
						</div>
					) : null}

					{!chat.isLoadingHistory && chat.messages.length === 0 && !chat.isSending ? (
						<div className="flex flex-col items-center justify-center pt-20 text-center text-[var(--inno-text-muted)]">
							<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]">
								<Sparkles size={18} />
							</div>
							<p className="text-sm font-medium text-[var(--inno-text)]">{t("chat.emptySessionTitle")}</p>
							<p className="mt-1 text-xs">{t("chat.emptySessionHint")}</p>
						</div>
					) : null}

					{(() => {
						const channels = new Set(chat.messages.map((m) => m.channel).filter(Boolean));
						const multiChannel = channels.size > 1;
						return chat.messages.map((message, index) => {
							const turnIndex = turnIndexByStartMessage.get(index);
							return (
								<div
									key={`${message.timestamp}-${index}`}
									data-conversation-turn={turnIndex}
								>
									<MessageBubble message={message} showChannel={multiChannel} />
								</div>
							);
						});
					})()}

					{chat.isSending && chat.streamingActivity ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message min-w-0 max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] text-[var(--inno-text-muted)] shadow-sm">
								<div className="flex min-w-0 items-center gap-2">
									<span className="inno-stream-status-dot is-streaming shrink-0" />
									<Sparkles size={14} className="shrink-0 text-[var(--inno-accent)]" />
									<span className="min-w-0 font-medium text-[var(--inno-text)]">{chat.streamingActivity}</span>
									{chat.streamingActivityDetail ? (
										<span className="min-w-0 truncate text-xs text-[var(--inno-text-subtle)]">{chat.streamingActivityDetail}</span>
									) : null}
								</div>
							</div>
						</motion.div>
					) : null}

					{chat.activeTools.length > 0 ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)] px-3 py-2 text-[13px]">
								{chat.activeTools.map((tool) => (
									<div key={tool.toolCallId} className="flex min-w-0 items-center gap-2 text-[var(--inno-text-muted)]">
										<Spinner size={12} className="shrink-0" />
										<span className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.toolName}</span>
									</div>
								))}
							</div>
						</motion.div>
					) : null}

					{chat.completedTools.length > 0 ? <CompletedToolRecords tools={chat.completedTools} /> : null}

					{/* Thinking + reply text bubbles — own store subscription, see above */}
					<StreamingBubbles />

					{chat.streamingError ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message max-w-[78%]">
								<ErrorBlock error={chat.streamingError} />
							</div>
						</motion.div>
					) : null}

					{chat.pendingQuestion ? (
						<QuestionDialog pending={chat.pendingQuestion} />
					) : null}
					</div>
				</div>
				<ConversationMinimap
					messages={chat.messages}
					scrollContainerRef={scrollRef}
					onNavigateStart={pauseAutoScroll}
				/>
			</div>

			<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="mx-auto max-w-3xl">
					{renderUploadChips()}
					{renderQuestionHint()}
					{renderBusyBlocker()}
					{wsError ? <p className="mb-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
					{renderComposer(t("chat.composerPlaceholder"))}
				</div>
			</div>
		</section>
	);
}
