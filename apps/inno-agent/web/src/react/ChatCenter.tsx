import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Paperclip, X, SendHorizonal, Square, RotateCcw, Image, AlertTriangle, Search } from "lucide-react";
import type { ChatMessage } from "../types/chat.js";
import type { InlineImage } from "../api/chat.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import type { CreateSessionInput } from "../api/sessions.js";
import { listRemotePresets } from "../api/presets.js";
import type { PresetMeta } from "../types/presets.js";
import { uploadRawFile, type RawUploadResult } from "../api/uploads.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { groupByCategory, matchesQuery } from "../utils/category-grouping.js";
import { useStoreSnapshot } from "./hooks.js";
import { QuestionDialog } from "./QuestionDialog.js";
import "@earendil-works/pi-web-ui";

const CHANNEL_BADGE_CLASS: Record<string, string> = {
	cli: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]",
	web: "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]",
	feishu: "bg-emerald-50 text-emerald-500",
	scheduler: "bg-amber-50 text-amber-500",
	qq: "bg-cyan-50 text-cyan-500",
	wechat: "bg-lime-50 text-lime-500",
};

const CHANNEL_LABEL: Record<string, string> = {
	cli: "CLI",
	web: "Web",
	feishu: "Feishu",
	scheduler: "Job",
	qq: "QQ",
	wechat: "WeChat",
};

function ChannelBadge({ channel }: { channel: string }) {
	return (
		<span className={`inline-block rounded px-1.5 py-px text-[9px] font-medium leading-tight ring-1 ring-black/5 ${CHANNEL_BADGE_CLASS[channel] ?? "bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]"}`}>
			{CHANNEL_LABEL[channel] ?? channel}
		</span>
	);
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
			onClick={onClose}
		>
			<img
				src={src}
				alt="enlarged"
				className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			/>
			<button
				className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40"
				onClick={onClose}
			>
				<X size={16} />
			</button>
		</div>,
		document.body,
	);
}

/**
 * Collapsible red-tinted block for surfacing backend / model API errors
 * (e.g. HTTP 413 when the context is too long). Shows a short headline by
 * default and reveals the full backend message when expanded, so users know
 * something failed instead of seeing a silent dead end.
 */
function ErrorBlock({ error }: { error: string }) {
	const isLong = error.length > 80 || error.includes("\n");
	return (
		<details className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700" open={!isLong}>
			<summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
				<AlertTriangle size={13} className="shrink-0" />
				Request failed
				{isLong ? <span className="text-red-400">· click to expand</span> : null}
			</summary>
			<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-red-600">{error}</pre>
		</details>
	);
}

function MessageBubble({ message, showChannel }: { message: ChatMessage; showChannel?: boolean }) {
	const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

	if (message.role === "user") {
		return (
			<motion.div
				className="flex justify-end"
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.25, ease: "easeOut" }}
			>
				<div className="inno-message w-fit whitespace-pre-wrap break-words rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]" style={{ maxWidth: "min(70%, 38rem)" }}>
					{showChannel && message.channel ? (
						<div className="mb-1 flex justify-end"><ChannelBadge channel={message.channel} /></div>
					) : null}
					{message.images?.length ? (
						<div className="mb-2 flex flex-wrap gap-1.5">
							{message.images.map((img, i) => (
								<img
									key={i}
									src={img.previewUrl}
									alt="attached"
									className="max-h-48 max-w-full cursor-zoom-in rounded object-contain"
									onClick={() => setLightboxSrc(img.previewUrl)}
								/>
							))}
						</div>
					) : null}
					{lightboxSrc ? <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} /> : null}
					{message.content.trim()}
				</div>
			</motion.div>
		);
	}

	return (
		<motion.div
			className="flex justify-start"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
		>
			<div className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]">
				{showChannel && message.channel ? (
					<div className="mb-1"><ChannelBadge channel={message.channel} /></div>
				) : null}
				{message.thinking || message.tools?.length ? (
					<details className="mb-2 min-w-0 max-w-full overflow-hidden rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1.5 text-xs text-[var(--inno-text-muted)]">
						<summary className="cursor-pointer select-none break-words font-medium text-[var(--inno-text-muted)] [overflow-wrap:anywhere]">
							Thinking & tool calls
							{message.tools?.length ? ` · ${message.tools.length}` : ""}
						</summary>
						{message.thinking ? <pre className="mt-2 max-h-44 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{message.thinking}</pre> : null}
						{message.tools?.length ? (
							<div className="mt-2 grid min-w-0 max-w-full gap-1.5">
								{message.tools.map((tool) => (
									<details key={tool.toolCallId} className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1">
										<summary className={tool.isError ? "cursor-pointer break-words text-red-600 [overflow-wrap:anywhere]" : "cursor-pointer break-words text-[var(--inno-text-muted)] [overflow-wrap:anywhere]"}>
											{tool.toolName}
										</summary>
										<pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] [overflow-wrap:anywhere]">{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
									</details>
								))}
							</div>
						) : null}
					</details>
				) : null}
				<markdown-artifact content={normalizeMarkdownMath(message.content)} />
				{message.error ? (
					<div className={message.content.trim() ? "mt-2" : ""}>
						<ErrorBlock error={message.error} />
					</div>
				) : null}
			</div>
		</motion.div>
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
					? "border-blue-300 bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
					: "border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * Simple Mode preset grid: searchable, grouped by `category`, vertically
 * bounded so a long preset list doesn't push the composer off-screen.
 * The search input only appears when there are enough presets to make it
 * useful (≥ 4); the scroll container caps height at ~50vh.
 */
function PresetPicker({
	presets,
	openingPresetId,
	onOpen,
	query,
	onQueryChange,
	t,
}: {
	presets: PresetMeta[];
	openingPresetId: string | null;
	onOpen: (id: string) => void;
	query: string;
	onQueryChange: (v: string) => void;
	t: (key: string) => string;
}) {
	const uncategorizedLabel = t("presets.uncategorized");
	const groups = useMemo(
		() => groupByCategory(presets.filter((p) => matchesQuery(p, query)), uncategorizedLabel),
		[presets, query, uncategorizedLabel],
	);
	const totalMatched = useMemo(() => groups.reduce((sum, [, items]) => sum + items.length, 0), [groups]);
	const showSearch = presets.length >= 4;

	return (
		<div className="mt-5">
			<div className="mb-2 flex items-center gap-2">
				<div className="text-xs font-medium text-[var(--inno-text-muted)]">{t("presets.simpleModeHeader")}</div>
				<span className="text-[10px] text-[var(--inno-text-subtle)]">· {presets.length}</span>
			</div>

			{showSearch ? (
				<div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5">
					<Search size={13} className="shrink-0 text-[var(--inno-text-subtle)]" />
					<input
						type="text"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						placeholder={t("presets.searchPlaceholder")}
						className="min-w-0 flex-1 bg-transparent text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] focus:outline-none"
					/>
					{query ? (
						<button
							type="button"
							className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							onClick={() => onQueryChange("")}
						>
							<X size={12} />
						</button>
					) : null}
				</div>
			) : null}

			<div className="max-h-[50vh] overflow-y-auto rounded-md">
				{totalMatched === 0 ? (
					<div className="py-6 text-center text-xs text-[var(--inno-text-muted)]">{t("presets.noResults")}</div>
				) : (
					groups.map(([category, items]) => (
						<div key={category} className="mb-3 last:mb-0">
							{/* Only show the group header when at least one categorized group exists
							    AND there is more than one group — keeps the single-bucket flat layout
							    when nothing has been categorized yet. */}
							{groups.length > 1 ? (
								<div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
									{category} <span className="ml-1 text-[var(--inno-text-subtle)]">· {items.length}</span>
								</div>
							) : null}
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{items.map((preset) => (
									<button
										key={preset.id}
										type="button"
										disabled={openingPresetId !== null}
										onClick={() => onOpen(preset.id)}
										title={preset.description}
										className="group flex flex-col items-start rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2.5 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50"
									>
										<span className="text-sm font-medium text-[var(--inno-text)] group-hover:text-[var(--inno-accent)]">
											{preset.name}
										</span>
										{preset.description ? (
											<span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--inno-text-muted)]">
												{preset.description}
											</span>
										) : null}
										{openingPresetId === preset.id ? (
											<span className="mt-1 text-[10px] text-[var(--inno-accent)]">{t("presets.opening")}</span>
										) : null}
									</button>
								))}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}

export function ChatCenter() {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [uploads, setUploads] = useState<RawUploadResult[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [inlineImages, setInlineImages] = useState<(InlineImage & { name: string; previewUrl: string })[]>([]);

	// Inline workspace chooser state (welcome screen only). Seeded from the
	// user's last choice (P3) so a new chat resumes the workspace they were in
	// rather than always resetting to temp.
	const [wsMode, setWsMode] = useState<WsMode>(() => readLastWsMode());
	const [wsName, setWsName] = useState("");
	const [wsExistingId, setWsExistingId] = useState(() => readLastWsId());
	const [wsError, setWsError] = useState("");

	// Simple Mode surfaces preset workspaces for one-click start.
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const [presets, setPresets] = useState<PresetMeta[]>([]);
	const [openingPresetId, setOpeningPresetId] = useState<string | null>(null);
	const [togglingMode, setTogglingMode] = useState(false);
	const [presetQuery, setPresetQuery] = useState("");

	// Toggle between Simple and Normal mode from the welcome screen. The IA icon
	// plays a flip animation keyed on the resulting mode.
	const toggleMode = useCallback(() => {
		if (togglingMode) return;
		const next = !(settingsStore.settings?.simpleMode?.enabled === true);
		setTogglingMode(true);
		void settingsStore.saveSimpleMode(next).finally(() => setTogglingMode(false));
	}, [togglingMode]);

	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		isSending: chatStore.isSending,
		isLoadingHistory: chatStore.isLoadingHistory,
		streamingText: chatStore.streamingText,
		streamingThinking: chatStore.streamingThinking,
		streamingError: chatStore.streamingError,
		activeTools: chatStore.activeTools,
		completedTools: chatStore.completedTools,
		lastUserPrompt: chatStore.lastUserPrompt,
		pendingQuestion: chatStore.pendingQuestion,
	}));
	const sessions = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		preselectedWorkspaceId: sessionsStore.preselectedWorkspaceId,
		// Single source of truth for the welcome-vs-session view (see store).
		// Depends on chatStore too, but ChatCenter subscribes to chatStore via
		// the `chat` snapshot above, so this re-evaluates on chat changes.
		isWelcome: sessionsStore.isWelcomeView,
	}));
	const workspaces = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));

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
			if (appStore.workspaceMode === "collapsed") {
				appStore.setWorkspaceWidth(300);
				appStore.setWorkspaceMode("quarter");
			}
		}
	}, [isWelcome, wsMode, wsExistingId]);

	useEffect(() => {
		requestAnimationFrame(() => {
			const el = scrollRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
	}, [chat.messages, chat.streamingText, chat.streamingThinking, chat.activeTools.length, chat.completedTools.length, chat.pendingQuestion]);

	const handleInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
	}, []);

	const buildSessionInput = useCallback((): CreateSessionInput | { __error: string } => {
		// Simple Mode: no workspace chooser. Direct chat always goes to a temp
		// workspace; presets are opened via openPreset into their own workspace.
		if (simpleMode) return { newWorkspace: { isTemp: true } };
		if (wsMode === "temp") return { newWorkspace: { isTemp: true } };
		if (wsMode === "new") {
			const trimmed = wsName.trim();
			if (!trimmed) return { __error: "请填写工作区名称" };
			return { newWorkspace: { name: trimmed, isTemp: false } };
		}
		if (!wsExistingId) return { __error: "请选择一个工作区" };
		return { workspaceId: wsExistingId };
	}, [simpleMode, wsMode, wsName, wsExistingId]);

	// Load presets from the remote content hub once when the welcome screen is
	// shown in Simple Mode. Falls back to an empty list on failure (offline /
	// hub unreachable) so the composer still works.
	useEffect(() => {
		if (isWelcome && simpleMode && presets.length === 0) {
			void listRemotePresets().then(setPresets).catch(() => setPresets([]));
		}
	}, [isWelcome, simpleMode, presets.length]);

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
				setWsError(err instanceof Error ? err.message : "打开预设失败");
			} finally {
				setOpeningPresetId(null);
			}
		})();
	}, []);

	const handleSend = useCallback(() => {
		const input = inputRef.current?.value.trim() ?? "";
		if ((!input && uploads.length === 0 && inlineImages.length === 0) || chat.isSending || isUploading) return;

		const uploadNote = uploads.length > 0
			? `\n\n[已上传到 L2 raw 原始数据]\n${uploads.map((file: RawUploadResult) => `- ${file.fileName}: ${file.rawPath}`).join("\n")}`
			: "";
		const messageContent = `${input}${uploadNote}` || (inlineImages.length > 0 ? "请描述这张图片" : "");
		const imagesToSend = inlineImages.length > 0
			? inlineImages.map(({ data, mimeType }) => ({ data, mimeType }))
			: undefined;

		if (isWelcome) {
			const wsInput = buildSessionInput();
			if ("__error" in wsInput) {
				setWsError(wsInput.__error);
				return;
			}
			setWsError("");
			// Remember the workspace choice so the next new chat resumes it (P3).
			if (!simpleMode) rememberWsChoice(wsMode, wsExistingId);
			if (inputRef.current) {
				inputRef.current.value = "";
				inputRef.current.style.height = "auto";
			}
			setUploads([]);
			setInlineImages([]);
			void (async () => {
				try {
					await sessionsStore.createSessionWith(wsInput);
					void chatStore.send(messageContent, imagesToSend);
				} catch (err) {
					setWsError(err instanceof Error ? err.message : "创建会话失败");
				}
			})();
			return;
		}

		if (inputRef.current) {
			inputRef.current.value = "";
			inputRef.current.style.height = "auto";
		}
		setUploads([]);
		setInlineImages([]);
		void chatStore.send(messageContent, imagesToSend);
	}, [isWelcome, buildSessionInput, uploads, inlineImages, chat.isSending, isUploading, simpleMode, wsMode, wsExistingId]);

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

	const handleRetry = useCallback(() => {
		void chatStore.retry();
	}, []);

	const addImageFiles = useCallback((files: File[]) => {
		files.forEach((file) => {
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				const commaIdx = dataUrl.indexOf(",");
				const header = dataUrl.slice(0, commaIdx);
				const data = dataUrl.slice(commaIdx + 1);
				const mimeType = header.match(/:(.*?);/)?.[1] ?? file.type;
				setInlineImages((prev) => [...prev, { data, mimeType, name: file.name || "image", previewUrl: dataUrl }]);
			};
			reader.readAsDataURL(file);
		});
	}, []);

	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const imageItems = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/"));
		if (imageItems.length === 0) return;
		e.preventDefault();
		const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
		addImageFiles(files);
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
		setIsUploading(true);
		void (async () => {
			try {
				const uploaded = await Promise.all(files.map((file: File) => uploadRawFile(file)));
				setUploads((current: RawUploadResult[]) => [...current, ...uploaded]);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown upload error";
				setUploads((current: RawUploadResult[]) => [
					...current,
					{ fileName: "Upload failed", mimeType: "text/plain", size: 0, rawPath: message },
				]);
			} finally {
				setIsUploading(false);
				if (event.target) event.target.value = "";
			}
		})();
	}, []);

	const removeUpload = useCallback((index: number) => {
		setUploads((current: RawUploadResult[]) => current.filter((_, i: number) => i !== index));
	}, []);

	const renderUploadChips = () => (
		uploads.length > 0 ? (
			<div className="mb-2 flex flex-wrap gap-1.5">
				{uploads.map((file: RawUploadResult, index: number) => (
					<span key={`${file.rawPath}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-xs shadow-sm">
						<span className="max-w-[220px] truncate">{file.fileName}</span>
						<span className="text-[var(--inno-text-muted)]">{file.rawPath}</span>
						<button className="text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]" title="Remove upload" onClick={() => removeUpload(index)}>
							<X size={14} />
						</button>
					</span>
				))}
			</div>
		) : null
	);

	const renderInlineImagePreviews = () => (
		inlineImages.length > 0 ? (
			<div className="mb-2 flex flex-wrap gap-1.5">
				{inlineImages.map((img, index) => (
					<span key={`${img.name}-${index}`} className="relative inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-1 shadow-sm">
						<img src={img.previewUrl} alt={img.name} className="h-12 w-12 rounded object-cover" />
						<button
							className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] shadow-sm hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)]"
							title="Remove image"
							onClick={() => removeInlineImage(index)}
						>
							<X size={10} />
						</button>
					</span>
				))}
			</div>
		) : null
	);

	const renderComposer = (placeholder: string) => (
		<div className="inno-composer flex items-end gap-2 rounded-lg p-2">
			<input ref={fileInputRef} id="file-input" type="file" className="hidden" multiple onChange={handleFiles} />
			<input ref={imageInputRef} id="image-input" type="file" className="hidden" multiple accept="image/*" onChange={handleImageFiles} />
			<button className="inno-icon-button flex h-9 w-9 shrink-0 rounded-md disabled:opacity-50" title="Upload files to L2 raw" disabled={chat.isSending || isUploading} onClick={() => fileInputRef.current?.click()}>
				{isUploading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Paperclip size={18} />}
			</button>
			<button className="inno-icon-button flex h-9 w-9 shrink-0 rounded-md disabled:opacity-50" title="Attach image" disabled={chat.isSending} onClick={() => imageInputRef.current?.click()}>
				<Image size={18} />
			</button>
			<textarea
				ref={inputRef}
				id="chat-input"
				className="min-h-[36px] max-h-[140px] flex-1 resize-none overflow-hidden rounded-md border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
				placeholder={placeholder}
				rows={1}
				onKeyDown={handleKeyDown}
				onInput={handleInput}
				onPaste={handlePaste}
				disabled={chat.isSending || isUploading}
			/>
			{chat.isSending ? (
				<button
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red-600 text-white transition-colors hover:bg-red-700"
					title="Stop generation"
					onClick={handleStop}
				>
					<Square size={16} />
				</button>
			) : (
				<>
					{chat.lastUserPrompt ? (
						<button
							className="inno-icon-button flex h-9 w-9 shrink-0 rounded-md disabled:opacity-50"
							title="Retry last message"
							disabled={isUploading}
							onClick={handleRetry}
						>
							<RotateCcw size={16} />
						</button>
					) : null}
					<button
						className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${isUploading ? "cursor-not-allowed bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]" : "inno-primary-button"}`}
						title="Send"
						disabled={isUploading}
						onClick={handleSend}
					>
						<SendHorizonal size={18} />
					</button>
				</>
			)}
		</div>
	);

	/* ── Welcome layout: centered composer + inline workspace chooser ── */
	if (isWelcome) {
		return (
			<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
				<div className="inno-chat-grid flex flex-1 min-h-0 justify-center overflow-y-auto px-4">
					<div className="w-full max-w-2xl pt-[18vh] pb-12">
						<div className="mb-6 flex flex-col items-center text-center">
							<button
								type="button"
								onClick={toggleMode}
								disabled={togglingMode}
								title={simpleMode ? "当前:简单模式 · 点击切换到普通模式" : "当前:普通模式 · 点击切换到简单模式"}
								aria-label={simpleMode ? "切换到普通模式" : "切换到简单模式"}
								className="mb-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait"
								style={{ perspective: "600px" }}
							>
								<motion.div
									animate={{ rotateY: simpleMode ? 180 : 0 }}
									transition={{ type: "spring", stiffness: 320, damping: 22 }}
									style={{ transformStyle: "preserve-3d", position: "relative" }}
									className="flex h-12 w-12 items-center justify-center"
								>
									{/* Front — Normal mode */}
									<span
										className="absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-base font-semibold text-[var(--inno-accent)] shadow-sm transition-colors hover:border-blue-300"
										style={{ backfaceVisibility: "hidden" }}
									>
										IA
									</span>
									{/* Back — Simple mode */}
									<span
										className="absolute inset-0 flex items-center justify-center rounded-xl border border-blue-400 bg-[var(--inno-accent)] text-base font-semibold text-white shadow-sm"
										style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
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
								className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1 text-[11px] text-[var(--inno-text-muted)] transition-colors hover:border-blue-300 hover:text-[var(--inno-accent)] disabled:cursor-wait disabled:opacity-60"
							>
								<span className={`h-1.5 w-1.5 rounded-full ${simpleMode ? "bg-blue-500" : "bg-slate-300"}`} />
								{simpleMode ? "简单模式 · 切换到普通模式" : "普通模式 · 切换到简单模式"}
							</button>
						</div>

						{renderUploadChips()}
						{renderInlineImagePreviews()}
						{renderComposer("有什么想学习或实践的?发送消息开始…")}

						{simpleMode && presets.length > 0 ? (
							<PresetPicker
								presets={presets}
								openingPresetId={openingPresetId}
								onOpen={openPreset}
								query={presetQuery}
								onQueryChange={setPresetQuery}
								t={t}
							/>
						) : null}

						{simpleMode ? null : preselectedWs ? (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-[var(--inno-text-subtle)]">工作区</span>
								<span className="rounded-full bg-[var(--inno-accent-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--inno-accent)] ring-1 ring-blue-100">
									{preselectedWs.name}
								</span>
								<span className="text-[10px] text-[var(--inno-text-subtle)]">新对话将创建于此工作区</span>
							</div>
						) : (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-[var(--inno-text-subtle)]">工作区</span>
								<ModeChip selected={wsMode === "temp"} onClick={() => setWsMode("temp")}>临时·用完即弃</ModeChip>
								<ModeChip selected={wsMode === "new"} onClick={() => setWsMode("new")}>新建工作区</ModeChip>
								{selectableWorkspaces.length > 0 ? (
									<ModeChip selected={wsMode === "existing"} onClick={() => setWsMode("existing")}>已有工作区</ModeChip>
								) : null}
								{wsMode === "new" ? (
									<input
										type="text"
										placeholder="工作区名称,例如:pandas demo"
										value={wsName}
										onChange={(e) => setWsName(e.target.value)}
										className="ml-1 w-[200px] rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-px text-[10px] leading-tight outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
									/>
								) : null}
								{wsMode === "existing" ? (
									<select
										value={wsExistingId}
										onChange={(e) => setWsExistingId(e.target.value)}
										className="ml-1 max-w-[220px] rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-px text-[10px] leading-tight outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
									>
										<option value="">选择一个工作区…</option>
										{selectableWorkspaces.map((w) => (
											<option key={w.id} value={w.id}>{w.name}</option>
										))}
									</select>
								) : null}
							</div>
						)}

						{wsError ? <p className="mt-2 text-xs text-red-600">{wsError}</p> : null}
					</div>
				</div>
			</section>
		);
	}

	/* ── Normal layout: scrollable messages + bottom composer ── */
	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div
				ref={scrollRef}
				className="chat-scroll inno-chat-grid flex-1 min-h-0 overflow-y-auto px-4 py-4"
			>
				<div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
					{chat.isLoadingHistory && chat.messages.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center pt-20 text-[var(--inno-text-muted)]">
							<span className="mb-3 inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
							<p className="text-sm">Loading session…</p>
						</div>
					) : null}

					{(() => {
						const channels = new Set(chat.messages.map((m) => m.channel).filter(Boolean));
						const multiChannel = channels.size > 1;
						return chat.messages.map((message, index) => (
							<MessageBubble key={`${message.timestamp}-${index}`} message={message} showChannel={multiChannel} />
						));
					})()}

					{chat.activeTools.length > 0 ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-blue-100 bg-[var(--inno-accent-soft)] px-3 py-2 text-[13px]">
								{chat.activeTools.map((tool) => (
									<div key={tool.toolCallId} className="flex min-w-0 items-center gap-2 text-[var(--inno-text-muted)]">
										<span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
										<span className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.toolName}</span>
									</div>
								))}
							</div>
						</motion.div>
					) : null}

					{chat.streamingThinking ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
								<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Thinking...</summary>
								<pre className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{chat.streamingThinking}</pre>
							</details>
						</motion.div>
					) : null}

					{chat.completedTools.length > 0 ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.2 }}
						>
							<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
								<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Completed tool calls · {chat.completedTools.length}</summary>
								<div className="mt-2 grid min-w-0 max-w-full gap-1.5">
									{chat.completedTools.map((tool) => (
										<details key={tool.toolCallId} className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1">
											<summary className={tool.isError ? "cursor-pointer break-words text-red-600 [overflow-wrap:anywhere]" : "cursor-pointer break-words text-[var(--inno-text-muted)] [overflow-wrap:anywhere]"}>{tool.toolName}</summary>
											<pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] [overflow-wrap:anywhere]">{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
										</details>
									))}
								</div>
							</details>
						</motion.div>
					) : null}

					{chat.streamingText ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]">
								<markdown-artifact content={normalizeMarkdownMath(chat.streamingText)} />
							</div>
						</motion.div>
					) : null}

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

					{chat.isSending && !chat.pendingQuestion && !chat.streamingText && !chat.streamingError && chat.activeTools.length === 0 ? (
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

					{chat.pendingQuestion ? (
						<QuestionDialog pending={chat.pendingQuestion} />
					) : null}
				</div>
			</div>

			<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="mx-auto max-w-3xl">
					{renderUploadChips()}
					{renderInlineImagePreviews()}
					{renderComposer("Type a message...")}
				</div>
			</div>
		</section>
	);
}
