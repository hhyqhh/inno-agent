import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { InnoModelInfo, SmartInputSettings } from "../types/settings.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import { skillsStore } from "../stores/skills-store.js";
import { branchSessionBeforeMessage, type CreateSessionInput } from "../api/sessions.js";
import { bindSessionWorkspace } from "../api/workspaces.js";
import { ApiError } from "../api/client.js";
import type { PresetMeta } from "../types/presets.js";
import { arrayBufferToBase64 } from "../api/uploads.js";
import { uploadWorkspaceFileWithProgress } from "../api/workspace.js";
import type { AttachmentRef, ChatMessage } from "../types/chat.js";
import { fetchPresetList, readCachedPresets, removeCachedPreset } from "../utils/preset-cache.js";
import { useStoreSnapshot } from "./hooks.js";
import { ChatComposer } from "./chat/ChatComposer.js";
import { ChatConversation } from "./chat/ChatConversation.js";
import { BusyBlocker, QuestionHint } from "./chat/ChatStatusBanners.js";
import { ChatUploadChips } from "./chat/ChatUploadChips.js";
import { ChatWelcome } from "./chat/ChatWelcome.js";
import { SmartInputControl } from "./chat/SmartInputControl.js";
import { SlashCommandPalette } from "./chat/SlashCommandPalette.js";
import {
	buildSlashPaletteEntries,
	slashQueryFromDraft,
	type SlashPaletteAction,
	type SlashPaletteEntry,
} from "./chat/slash-palette-utils.js";
import { fetchSlashCommands, type SlashCommandItem } from "../api/commands.js";
import { WorkspaceContext } from "./chat/WorkspaceContext.js";
import type { WorkspaceChoice } from "./WorkspaceSwitcher.js";
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_LABEL, getOversizedFiles } from "../utils/upload-limits.js";
import {
	flattenWorkspaceFiles,
	isLargeTextPaste,
	localPendingUpload,
	pendingUploadId,
	prepareInlineImage,
	resizeComposerTextarea,
	workspacePendingUpload,
	type PendingPasteBlock,
	type PendingUpload,
	type PreparedInlineImage,
} from "./chat/composer-utils.js";
import { kindFromName } from "./chat/smart-input/kinds.js";
import type { EngineAttachmentItem } from "./chat/smart-input/engine.js";
import type { KwRange } from "./chat/smart-input/rules.js";
import { useSmartInput } from "./chat/smart-input/useSmartInput.js";
import { SmartInputOverlay, type SmartPanelState } from "./chat/smart-input/SmartInputOverlay.js";
import { skillMessageFromContent } from "./chat/skill-message-collapse.js";
import { parseAgentCommandMessage } from "./chat/agent-command-message.js";

type PresetRefreshStatus = "success" | "error";


type WsMode = "temp" | "new" | "existing";

// Remember the user's last workspace choice for a new chat so the bottom
// "新建对话" button doesn't always reset to temp.
const LAST_WS_MODE_KEY = "inno.lastWorkspaceMode";
const LAST_WS_ID_KEY = "inno.lastWorkspaceId";

interface ChatCenterProps {
	onOpenPresetPanels: () => void | Promise<void>;
	onOpenRightPanel: (tab: "notebook" | "profile" | "skills" | "jobs") => void | Promise<void>;
	onPreviewFile: (minimumWidth: number) => void | Promise<void>;
}

function readLastWsMode(): WsMode {
	if (typeof window === "undefined") return "temp";
	const value = window.localStorage.getItem(LAST_WS_MODE_KEY);
	return value === "new" || value === "existing" ? value : "temp";
}

function readLastWsId(): string {
	if (typeof window === "undefined") return "";
	return window.localStorage.getItem(LAST_WS_ID_KEY) ?? "";
}

function rememberWsChoice(mode: WsMode, existingId: string): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(LAST_WS_MODE_KEY, mode === "existing" ? "existing" : "temp");
	if (mode === "existing" && existingId) window.localStorage.setItem(LAST_WS_ID_KEY, existingId);
}

const SMART_FILE_PREVIEW_WIDTH = 560;
const SMART_HOVER_OPEN_MS = 250;
// Keep the copy/time action row below the last message above the composer mask.
const CONVERSATION_ACTION_ROW_RESERVE = 40;

function pendingUploadsFromRefs(refs: AttachmentRef[]): PendingUpload[] {
	const seen = new Set<string>();
	return refs.flatMap((file) => {
		if (!file.path || seen.has(file.path)) return [];
		seen.add(file.path);
		// Sent files already live in the session workspace, regardless of whether
		// they originally came from the workspace or a local upload.
		return [workspacePendingUpload(file.path)];
	});
}

export function ChatCenter({ onOpenPresetPanels, onOpenRightPanel, onPreviewFile }: ChatCenterProps) {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const welcomeLayoutRef = useRef<HTMLDivElement | null>(null);
	const resizeFrameRef = useRef<number | null>(null);
	const draftRef = useRef("");
	const editTargetRef = useRef<{ sessionId: string; entryId: string } | null>(null);
	const [draftValue, setDraftValue] = useState(draftRef.current);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const userScrollGestureRef = useRef(false);
	const [showLatestButton, setShowLatestButton] = useState(false);
	const pasteBlockIdRef = useRef(0);
	const [uploads, setUploads] = useState<PendingUpload[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [attachMenuOpen, setAttachMenuOpen] = useState(false);
	const [smartToast, setSmartToast] = useState<{ message: string; error?: boolean } | null>(null);
	const [smartHasSlots, setSmartHasSlots] = useState(false);
	const [smartPanel, setSmartPanel] = useState<SmartPanelState | null>(null);
	const smartPanelRef = useRef<SmartPanelState | null>(null);
	const [smartPanelRefresh, setSmartPanelRefresh] = useState(0);
	const smartBoundFileCountRef = useRef(0);
	const smartToastTimer = useRef<number | null>(null);
	const smartHoverTimer = useRef<number | null>(null);
	const smartHoverCloseTimer = useRef<number | null>(null);
	const mirrorRef = useRef<HTMLDivElement | null>(null);
	const hitRef = useRef<HTMLDivElement | null>(null);
	const uploadsRef = useRef<PendingUpload[]>([]);
	uploadsRef.current = uploads;
	smartPanelRef.current = smartPanel;
	const [inlineImages, setInlineImages] = useState<PreparedInlineImage[]>([]);
	const [draftHasContent, setDraftHasContent] = useState(() => Boolean(draftRef.current.trim()));
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [pasteBlocks, setPasteBlocks] = useState<PendingPasteBlock[]>([]);

	// Slash-command palette (Codex-style): opens while the draft is a bare
	// "/query". App actions (new chat, model picker) run locally; Agent
	// commands come from GET /api/commands and become atomic bubbles when the
	// feature is enabled, while the backend still receives their slash form.
	const [slashCommands, setSlashCommands] = useState<SlashCommandItem[]>([]);
	const [slashActiveIndex, setSlashActiveIndex] = useState(0);
	const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchSlashCommands()
			.then((items) => { if (!cancelled) setSlashCommands(items); })
			.catch(() => { /* palette simply stays limited to app actions */ });
		return () => { cancelled = true; };
	}, []);

	// New-chat workspace selection is draft state until the first message creates
	// a session. The active session path is bound in handleWorkspaceChange.
	const [wsMode, setWsMode] = useState<WsMode>(() => readLastWsMode());
	const [wsName, setWsName] = useState("");
	const [wsExistingId, setWsExistingId] = useState(() => readLastWsId());
	const [wsError, setWsError] = useState("");
	const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);

	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
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

	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		isSending: chatStore.isSending,
		isLoadingHistory: chatStore.isLoadingHistory,
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
	const workspaceTree = useStoreSnapshot(workspaceStore, () => workspaceStore.tree);
	const workspaceTreeLoading = useStoreSnapshot(workspaceStore, () => workspaceStore.isLoadingTree);
	const workspaceTreeError = useStoreSnapshot(workspaceStore, () => workspaceStore.error);
	const workspaceFiles = useMemo(() => workspaceTree ? flattenWorkspaceFiles(workspaceTree) : [], [workspaceTree]);
	const isWelcome = sessions.isWelcome;
	const hasConversationStatus = Boolean(chat.pendingQuestion || sessions.busyBlocker);
	// Sidebar/workspace layout shifts (e.g. after desktop window expansion) move
	// the composer by translation without resizing it, so neither window resize
	// nor ResizeObserver fires. Track the layout values that shift the chat
	// column and use them to nudge the floating panel to re-anchor.
	const appLayout = useStoreSnapshot(appStore, () => ({
		sidebarCollapsed: appStore.sidebarCollapsed,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));
	useEffect(() => {
		setSmartPanelRefresh((value) => value + 1);
	}, [appLayout]);

	const selectableWorkspaces = useMemo(
		() => workspaces.list.filter((workspace) => !workspace.isTemp && !workspace.id.startsWith("channel-")),
		[workspaces.list],
	);

	const toggleMode = useCallback(() => {
		if (togglingMode) return;
		const next = !(settingsStore.settings?.simpleMode?.enabled === true);
		setTogglingMode(true);
		void settingsStore.saveSimpleMode(next).finally(() => setTogglingMode(false));
	}, [togglingMode]);

	const closeModelPicker = useCallback(() => setModelPickerOpen(false), []);
	const toggleModelPicker = useCallback(() => setModelPickerOpen((open) => !open), []);
	const handleModelSelect = useCallback((model: InnoModelInfo) => {
		setModelPickerOpen(false);
		if (model.provider === modelState.defaultProvider && model.id === modelState.defaultModel) return;
		void settingsStore.switchModel(model.provider, model.id);
	}, [modelState.defaultModel, modelState.defaultProvider]);
	const openModelSettings = useCallback(() => {
		setModelPickerOpen(false);
		appStore.openSettings("models");
	}, []);

	const handleWorkspaceChange = useCallback(async (choice: WorkspaceChoice) => {
		setWsError("");
		if (isWelcome) {
			if (choice.kind === "temp") {
				setWsMode("temp");
				setWsName("");
				setWsExistingId("");
				// The welcome-page choice is draft state, but the workspace panel
				// should still preview the same workspace before a session exists.
				// Without this, switching back to temp leaves the last session's
				// workspace visible in the file area.
				const tempWorkspace = workspaces.list.find((workspace) => workspace.isTemp);
				void workspaceStore.setActiveWorkspace(tempWorkspace?.id ?? null);
			} else if (choice.kind === "workspace") {
				setWsMode("existing");
				setWsExistingId(choice.workspaceId);
				setWsName("");
			} else {
				setWsMode("new");
				setWsName(choice.name);
				setWsExistingId("");
			}
			return;
		}

		const sessionId = sessions.currentSessionId;
		if (!sessionId) return;
		if (chat.isSending || isUploading) {
			setWsError(t("chat.workspaceBusy"));
			return;
		}

		setIsSwitchingWorkspace(true);
		try {
			let workspaceId: string;
			if (choice.kind === "workspace") {
				workspaceId = choice.workspaceId;
			} else if (choice.kind === "new") {
				workspaceId = (await workspacesStore.create({ name: choice.name, isTemp: false })).id;
			} else {
				const tempWorkspace = workspaces.list.find((workspace) => workspace.isTemp);
				if (!tempWorkspace) throw new Error(t("chat.workspaceUnavailable"));
				workspaceId = tempWorkspace.id;
			}

			if (workspaceId !== activeWorkspaceId) {
				await bindSessionWorkspace(sessionId, workspaceId);
				await workspaceStore.setActiveWorkspace(workspaceId);
			}
			await workspacesStore.load();
		} catch (error) {
			setWsError(error instanceof Error ? error.message : t("chat.workspaceSwitchFailed"));
		} finally {
			setIsSwitchingWorkspace(false);
		}
	}, [activeWorkspaceId, chat.isSending, isUploading, isWelcome, sessions.currentSessionId, t, workspaces.list]);

	// Import a workspace from a .zip archive: upload first, then route the
	// freshly created workspace through the normal selection flow (welcome
	// draft state or session binding).
	const handleWorkspaceImport = useCallback(async (file: File) => {
		setWsError("");
		if (!isWelcome && !sessions.currentSessionId) return;
		if (chat.isSending || isUploading) {
			setWsError(t("chat.workspaceBusy"));
			return;
		}
		setIsSwitchingWorkspace(true);
		try {
			const ws = await workspacesStore.importFromZip(file);
			await handleWorkspaceChange({ kind: "workspace", workspaceId: ws.id });
		} catch (error) {
			setWsError(error instanceof Error ? error.message : t("chat.workspaceSwitchFailed"));
		} finally {
			setIsSwitchingWorkspace(false);
		}
	}, [chat.isSending, handleWorkspaceChange, isUploading, isWelcome, sessions.currentSessionId, t]);

	const tempWorkspaceId = workspaces.list.find((workspace) => workspace.isTemp)?.id;
	const uploadWorkspaceId: string | undefined | null = isWelcome
		? (simpleMode || wsMode === "temp"
			? tempWorkspaceId
			: wsMode === "existing" && wsExistingId
				? wsExistingId
				: null)
		: activeWorkspaceId;

	const hasSendableContent = Boolean(
		draftHasContent
			|| pasteBlocks.some((block) => block.text.trim())
			|| uploads.some((upload) => upload.status !== "failed")
			|| inlineImages.length > 0
			|| smartHasSlots,
	);

	useEffect(() => {
		if (isWelcome && workspaces.list.length === 0) void workspacesStore.load();
	}, [isWelcome, workspaces.list.length]);

	useEffect(() => {
		if (wsMode === "existing" && wsExistingId && workspaces.list.length > 0) {
			if (!selectableWorkspaces.some((workspace) => workspace.id === wsExistingId)) {
				setWsMode("temp");
				setWsExistingId("");
			}
		}
	}, [wsMode, wsExistingId, workspaces.list.length, selectableWorkspaces]);

	useEffect(() => {
		if (sessions.preselectedWorkspaceId) {
			setWsMode("existing");
			setWsExistingId(sessions.preselectedWorkspaceId);
		}
	}, [sessions.preselectedWorkspaceId]);

	useEffect(() => {
		if (isWelcome && wsMode === "existing" && wsExistingId) {
			void workspaceStore.setActiveWorkspace(wsExistingId);
			appStore.setRightPanelTab("preview");
			if (appStore.workspaceMode === "collapsed" && sessions.preselectedWorkspaceId === wsExistingId) {
				appStore.setWorkspaceWidth(300);
				appStore.setWorkspaceMode("quarter");
			}
		}
	}, [isWelcome, wsMode, wsExistingId, sessions.preselectedWorkspaceId]);

	const stickToBottomNow = useCallback(() => {
		if (chat.isLoadingHistory || !shouldStickToBottomRef.current) return;
		const scroll = scrollRef.current;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	}, [chat.isLoadingHistory]);

	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.querySelector<HTMLElement>("[data-conversation-content]");
		if (!el || !content) return;
		const observer = new ResizeObserver(stickToBottomNow);
		observer.observe(content);
		return () => observer.disconnect();
	}, [stickToBottomNow, sessions.currentSessionId]);

	useLayoutEffect(() => {
		shouldStickToBottomRef.current = true;
		setShowLatestButton(false);
		editTargetRef.current = null;
	}, [sessions.currentSessionId]);

	useLayoutEffect(() => {
		if (chat.isLoadingHistory || !shouldStickToBottomRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chat.isLoadingHistory, chat.messages.length, sessions.currentSessionId]);

	const markUserScrollGesture = useCallback(() => {
		userScrollGestureRef.current = true;
	}, []);
	const handleScrollerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		const el = scrollRef.current;
		if (el && event.clientX >= el.getBoundingClientRect().right - 24) markUserScrollGesture();
	}, [markUserScrollGesture]);
	const handleChatScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 96) {
			shouldStickToBottomRef.current = true;
			userScrollGestureRef.current = false;
			setShowLatestButton(false);
			return;
		}
		if (!userScrollGestureRef.current) return;
		userScrollGestureRef.current = false;
		shouldStickToBottomRef.current = false;
		setShowLatestButton(true);
	}, []);
	const pauseAutoScroll = useCallback(() => {
		shouldStickToBottomRef.current = false;
		setShowLatestButton(true);
	}, []);
	const jumpToLatest = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		shouldStickToBottomRef.current = true;
		userScrollGestureRef.current = false;
		setShowLatestButton(false);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, []);

	const resizeInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		const minHeight = resizeComposerTextarea(el);
		const composer = el.closest<HTMLElement>(".inno-composer");
		if (!composer) return;
		const textareaHeight = el.getBoundingClientRect().height;
		const composerHeight = composer.getBoundingClientRect().height;
		const attachmentRow = composer.querySelector<HTMLElement>(".inno-composer-attachments");
		const attachmentHeight = attachmentRow
			? attachmentRow.getBoundingClientRect().height
				+ Number.parseFloat(window.getComputedStyle(attachmentRow).marginTop || "0")
				+ Number.parseFloat(window.getComputedStyle(attachmentRow).marginBottom || "0")
			: 0;
		const composerContent = composer.closest<HTMLElement>(".inno-conversation-composer-content");
		const overlayBeforeComposerHeight = composerContent
			? Math.max(0, composerContent.getBoundingClientRect().height - composerHeight)
			: 0;
		const scroll = scrollRef.current;
		if (scroll) {
			// Attachments grow from the top of the composer. The center mask only
			// accounts for half of that row, so add the other half to keep the
			// conversation body moving up by the attachment's full height. Status
			// banners and the gap above the composer are also overlaid, so reserve
			// the whole area before the composer to keep the last message visible.
			const nextBottomSpace = `${composerHeight / 2 + attachmentHeight / 2 + 12 + CONVERSATION_ACTION_ROW_RESERVE + overlayBeforeComposerHeight}px`;
			if (scroll.style.getPropertyValue("--inno-conversation-scroll-bottom-space") !== nextBottomSpace) {
				scroll.style.setProperty("--inno-conversation-scroll-bottom-space", nextBottomSpace);
				stickToBottomNow();
			}
		}
		const welcomeLayout = welcomeLayoutRef.current;
		if (!welcomeLayout) return;
		// The attachment row is an independent, variable-height block above the
		// textarea. Exclude it from the baseline so adding/removing a file cannot
		// leave a stale welcome-page offset behind when a bubble is rebuilt.
		const baseComposerHeight = composerHeight - textareaHeight - attachmentHeight + minHeight;
		const composerGrowth = Math.max(0, composerHeight - baseComposerHeight);
		welcomeLayout.style.setProperty("--inno-welcome-composer-half-growth", `${composerGrowth / 2}px`);
	}, [stickToBottomNow]);

	// Coalesce layout reads/writes while the user types or deletes rapidly.
	// The textarea value and caret stay native and immediate; only the visual
	// height adjustment waits until the next frame.
	const scheduleResizeInput = useCallback(() => {
		if (resizeFrameRef.current !== null) return;
		if (typeof requestAnimationFrame !== "function") {
			resizeInput();
			return;
		}
		resizeFrameRef.current = requestAnimationFrame(() => {
			resizeFrameRef.current = null;
			resizeInput();
		});
	}, [resizeInput]);

	useEffect(() => () => {
		if (resizeFrameRef.current === null) return;
		cancelAnimationFrame(resizeFrameRef.current);
		resizeFrameRef.current = null;
	}, []);

	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		resizeInput();
		const composer = el.closest<HTMLElement>(".inno-composer");
		if (!composer) return;
		if (typeof ResizeObserver === "undefined") return;
		// Observe the composer and its overlay lane: attachment rows, smart
		// bubbles, and status banners can change the covered area independently.
		const observer = new ResizeObserver(() => resizeInput());
		observer.observe(composer);
		const composerContent = composer.closest<HTMLElement>(".inno-conversation-composer-content");
		if (composerContent) observer.observe(composerContent);
		return () => observer.disconnect();
	}, [isWelcome, resizeInput]);

	useEffect(() => {
		resizeInput();
	}, [isWelcome, inlineImages, pasteBlocks, uploads, hasConversationStatus, resizeInput]);

	const isComposingRef = useRef(false);

	const handleInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		draftRef.current = el.value;
		setDraftValue(el.value);
		setDraftHasContent(el.value.trim().length > 0);
		// Safari drops in-progress IME composition (e.g. Chinese/Japanese input)
		// when the textarea's height/overflow/selection is mutated mid-composition,
		// which is what resizeInput does. Defer the resize until compositionend.
		if (isComposingRef.current) return;
		scheduleResizeInput();
	}, [scheduleResizeInput]);

	const handleCompositionStart = useCallback(() => {
		isComposingRef.current = true;
	}, []);

	const handleCompositionEnd = useCallback(() => {
		isComposingRef.current = false;
		scheduleResizeInput();
	}, [scheduleResizeInput]);

	// ── Smart input engine (便捷输入) ─────────────────────────────────────
	const smartInputState = useStoreSnapshot(settingsStore, () => ({
		smartInput: settingsStore.settings?.smartInput,
		isSavingSmartInput: settingsStore.isSavingSmartInput,
	}));
	const smartSettings = smartInputState.smartInput;
	const smartInputEnabled = smartSettings?.enabled === true;

	const openSmartInputSettings = useCallback(() => {
		appStore.openSettings("lab");
	}, []);

	const showSmartToast = useCallback((message: string, error?: boolean) => {
		setSmartToast({ message, error });
		if (smartToastTimer.current !== null) window.clearTimeout(smartToastTimer.current);
		smartToastTimer.current = window.setTimeout(() => setSmartToast(null), 2200);
	}, []);
	const notifyUploadLimitExceeded = useCallback((count: number) => {
		showSmartToast(t("chat.uploadTooLarge", "有 {{count}} 个文件超过 {{limit}} 上限，未添加。", {
			count,
			limit: DEFAULT_UPLOAD_MAX_LABEL,
		}), true);
	}, [showSmartToast, t]);
	const filterUploadFiles = useCallback((files: File[]): File[] => {
		const oversized = getOversizedFiles(files);
		if (oversized.length > 0) notifyUploadLimitExceeded(oversized.length);
		return files.filter((file) => file.size <= DEFAULT_UPLOAD_MAX_BYTES);
	}, [notifyUploadLimitExceeded]);
	const saveSmartInput = useCallback((next: SmartInputSettings) => {
		void settingsStore.saveSmartInput(next).catch(() => {
			showSmartToast(t("settings.smartInput.saveFailed", "便捷输入设置保存失败"), true);
		});
	}, [showSmartToast, t]);
	const toggleSmartInput = useCallback(() => {
		if (!smartSettings || settingsStore.isSavingSmartInput) return;
		saveSmartInput({ ...smartSettings, enabled: !smartSettings.enabled });
	}, [saveSmartInput, smartSettings]);
	const toggleSmartInputRule = useCallback((ruleId: string) => {
		if (!smartSettings || settingsStore.isSavingSmartInput) return;
		const rule = smartSettings.rules.find((entry) => entry.id === ruleId);
		if (!rule) return;
		const rules = smartSettings.rules.map((entry) =>
			entry.id === ruleId ? { ...entry, enabled: !entry.enabled } : entry,
		);
		saveSmartInput({ ...smartSettings, rules });
	}, [saveSmartInput, smartSettings]);
	useEffect(() => () => {
		if (smartToastTimer.current !== null) window.clearTimeout(smartToastTimer.current);
	}, []);

	const takeAttachment = useCallback((path: string): EngineAttachmentItem | undefined => {
		const item = uploadsRef.current.find((entry) => entry.path === path || entry.fileName === path);
		if (!item) return undefined;
		setUploads((current) => current.filter((entry) => entry !== item));
		return { name: item.fileName, path: item.path, source: item.source, file: item.file };
	}, []);

	const returnAttachment = useCallback((item: EngineAttachmentItem) => {
		setUploads((current) => {
			if (current.some((entry) => entry.path === item.path && entry.source === item.source)) return current;
			return [...current, item.source === "workspace"
				? workspacePendingUpload(item.path)
				: { id: pendingUploadId(), fileName: item.name, path: item.path, source: "local", status: "ready", pct: 0, file: item.file }];
		});
	}, []);

	const handleSmartChange = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		draftRef.current = el.value;
		setDraftValue(el.value);
		setDraftHasContent(el.value.trim().length > 0);
		scheduleResizeInput();
	}, [scheduleResizeInput]);

	const rectOfChip = (chip: HTMLElement): SmartPanelState["anchor"] => {
		const rect = chip.getBoundingClientRect();
		return { left: rect.left, bottom: rect.bottom };
	};

	const updateSmartPanel = useCallback((next: SmartPanelState | null) => {
		smartPanelRef.current = next;
		setSmartPanel(next);
	}, []);

	const openSmartPanel = useCallback((kind: SmartPanelState["kind"], slot: { id: number }, chip: HTMLElement) => {
		// A delayed chip click/hover callback must not replace an already-open
		// context menu. Menu actions switch panels through updateSmartPanel
		// explicitly, so this guard only blocks stale source-bubble callbacks.
		if (smartPanelRef.current?.kind === "menu" || document.querySelector(".inno-smart-menu")) return;
		// The workspace browser is not mounted on a cold welcome screen, so its
		// first tree request may not have started yet. Opening the fill menu is a
		// valid request for the same data; kick it off here instead of treating the
		// initial null tree as a real empty workspace.
		if (kind === "fill" && workspaceStore.tree === null && !workspaceStore.isLoadingTree) void workspaceStore.loadTree();
		updateSmartPanel({ kind, slotId: slot.id, anchor: rectOfChip(chip) });
	}, [updateSmartPanel]);

	const openSmartAgentPanel = useCallback((anchor: HTMLElement, target: Pick<SmartPanelState, "slotId" | "agentKeyword">) => {
		if (!smartInputEnabled || smartSettings?.allowAgentCommands !== true) return;
		if (smartPanelRef.current?.kind === "menu" || document.querySelector(".inno-smart-menu")) return;
		const rect = anchor.getBoundingClientRect();
		updateSmartPanel({
			kind: "agent",
			anchor: { left: rect.left, bottom: rect.bottom },
			...target,
		});
	}, [smartInputEnabled, smartSettings?.allowAgentCommands, updateSmartPanel]);

	const openSmartAgentPicker = useCallback((keyword: KwRange, anchor: HTMLElement) => {
		openSmartAgentPanel(anchor, { agentKeyword: keyword });
	}, [openSmartAgentPanel]);

	const openSmartAgentBubblePicker = useCallback((slot: { id: number; agentCommand?: string }, anchor: HTMLElement) => {
		if (!slot.agentCommand?.startsWith("skill:")) return;
		openSmartAgentPanel(anchor, { slotId: slot.id });
	}, [openSmartAgentPanel]);

	const openSkillPanel = useCallback((skillName: string) => {
		void skillsStore.selectSkill(skillName);
		void onOpenRightPanel("skills");
	}, [onOpenRightPanel]);

	const cancelSmartHoverTimers = useCallback(() => {
		if (smartHoverTimer.current !== null) {
			window.clearTimeout(smartHoverTimer.current);
			smartHoverTimer.current = null;
		}
		if (smartHoverCloseTimer.current !== null) {
			window.clearTimeout(smartHoverCloseTimer.current);
			smartHoverCloseTimer.current = null;
		}
	}, []);

	const handleChipHover = useCallback((slot: { id: number; files: unknown[] }, chip: HTMLElement, entering: boolean) => {
		cancelSmartHoverTimers();
		if (entering) {
			smartHoverTimer.current = window.setTimeout(() => {
				smartHoverTimer.current = null;
				// A context menu is an explicit interaction. It must win over a
				// hover callback that was already queued before the right-click.
				if (smartPanelRef.current?.kind === "menu" || document.querySelector(".inno-smart-menu")) return;
				// The engine rebuilds hit-layer chips on sync; the captured chip
				// element may be detached by now. Re-query the live chip so the
				// anchor rect is not (0, 0).
				const liveChip = document.querySelector<HTMLElement>(`.inno-smart-chip[data-slot-id="${slot.id}"]`) ?? chip;
				openSmartPanel("status", slot, liveChip);
			}, SMART_HOVER_OPEN_MS);
			return;
		}
		// Left the chip: if the status panel for this slot is open but the
		// pointer did not move onto it, close it shortly (panel parity).
		smartHoverCloseTimer.current = window.setTimeout(() => {
			smartHoverCloseTimer.current = null;
			const currentPanel = smartPanelRef.current;
			// Do not let a chip mouseleave timer dismiss a context menu. Checking
			// the menu state/DOM is more reliable than `:hover` while the portal is
			// being mounted or while the pointer is still over the source chip.
			if (currentPanel?.kind === "menu" || document.querySelector(".inno-smart-menu")) return;
			if (currentPanel?.slotId !== slot.id) return;
			const overPanel = document.querySelector(".inno-smart-panel:hover");
			const overChip = document.querySelector(".inno-smart-chip:hover");
			if (!overPanel && !overChip) updateSmartPanel(null);
		}, 260);
	}, [cancelSmartHoverTimers, openSmartPanel, updateSmartPanel]);

	const highlightWorkspace = useCallback((paths: string[] | null) => {
		window.dispatchEvent(new CustomEvent("inno-smart-highlight", { detail: paths }));
	}, []);
	const openSmartFilePreview = useCallback((path: string) => {
		appStore.setRightPanelTab("preview");
		workspaceStore.clearStreamingPreview();
		void workspaceStore.selectFile(path);
		void onPreviewFile(SMART_FILE_PREVIEW_WIDTH);
	}, [onPreviewFile]);
	const openChatAttachmentPreview = useCallback((file: AttachmentRef) => {
		openSmartFilePreview(file.path);
	}, [openSmartFilePreview]);

	const engineRef = useSmartInput({
		enabled: smartInputEnabled,
		remountKey: isWelcome ? "welcome" : "session",
		textareaRef: inputRef,
		mirrorRef,
		hitRef,
		getSettings: () => smartSettings,
		takeAttachment,
		returnAttachment,
		onChange: handleSmartChange,
		onSnapshot: (snapshot) => {
			setSmartHasSlots(snapshot.slotCount > 0);
			if (smartBoundFileCountRef.current !== snapshot.boundFileCount) {
				smartBoundFileCountRef.current = snapshot.boundFileCount;
				setSmartPanelRefresh((value) => value + 1);
			}
		},
		onOpenStatusPanel: (slot, chip) => openSmartPanel("status", slot, chip),
		onOpenFillMenu: (slot, chip) => openSmartPanel("fill", slot, chip),
		onOpenAgentPicker: openSmartAgentPicker,
		onAgentBubbleClick: openSmartAgentBubblePicker,
		onBubbleContextMenu: (event, slot, chip) => {
			// Right-clicking a filled bubble can race with the hover open/close
			// timers. A context menu is an explicit interaction and must not be
			// replaced by the hover status panel or dismissed by its timer.
			cancelSmartHoverTimers();
			const rect = chip.getBoundingClientRect();
			updateSmartPanel({ kind: "menu", slotId: slot.id, anchor: { left: rect.left, bottom: rect.bottom }, x: event.clientX, y: event.clientY });
		},
		onBubbleClose: (slot) => {
			cancelSmartHoverTimers();
			if (smartPanelRef.current?.slotId === slot.id) updateSmartPanel(null);
		},
		onChipHover: handleChipHover,
		onUploadLimitExceeded: notifyUploadLimitExceeded,
		onWorkspaceHighlight: highlightWorkspace,
	});

	// Rule toggles are persisted without remounting the composer. Refresh the
	// mirror immediately so a keyword already present in the draft reflects the
	// new rule state as soon as the save response arrives.
	useEffect(() => {
		engineRef.current?.syncNow();
	}, [smartSettings]);

	const buildSessionInput = useCallback((): CreateSessionInput | { __error: string } => {
		if (simpleMode || wsMode === "temp") return { newWorkspace: { isTemp: true } };
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

	const openPreset = useCallback((presetId: string) => {
		setWsError("");
		setOpeningPresetId(presetId);
		void (async () => {
			try {
				await Promise.all([
					sessionsStore.createSessionWith({ presetId }),
					onOpenPresetPanels(),
				]);
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
	}, [onOpenPresetPanels, t]);

	const handleSend = useCallback(() => {
		const engine = engineRef.current;
		const outgoing = engine ? engine.buildOutgoing() : null;
		// Smart input active → the visible text already has tokens restored to
		// their plain words; word indices were computed against exactly this text.
		const rawValue = outgoing ? outgoing.visibleText : inputRef.current?.value ?? draftRef.current;
		const input = [rawValue.trim(), ...pasteBlocks.map((block) => block.text.trim())].filter(Boolean).join("\n\n");
		if ((!input && uploads.length === 0 && inlineImages.length === 0) || chat.isSending || isUploading) return;
		shouldStickToBottomRef.current = true;
		const pendingUploads = [...uploads];
		const pendingImages = [...inlineImages];

		const resetComposer = () => {
			draftRef.current = "";
			setDraftValue("");
			setDraftHasContent(false);
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
					if (!simpleMode) rememberWsChoice(wsMode, wsExistingId);
					await sessionsStore.createSessionWith(wsInput);
					targetSessionId = sessionsStore.currentSessionId;
				}

				const targetWorkspaceId = workspaceStore.activeWorkspaceId ?? uploadWorkspaceId ?? undefined;
				const toUpload = pendingUploads.filter((item) => item.source === "local" && item.status !== "failed" && item.file);
				const enginePending = outgoing?.pendingFiles ?? [];
				if ((toUpload.length > 0 || enginePending.length > 0) && targetWorkspaceId === undefined) throw new Error(t("chat.uploadHint"));

				// Local files upload one-by-one only after send; failures stay in the
				// attachment row as retryable instead of blocking the message.
				// Workspace files are already on the server — no upload.
				const loose: AttachmentRef[] = [];
				const failedNames: string[] = [];
				for (const item of pendingUploads) {
					if (item.source === "workspace") {
						loose.push({ path: item.path, kind: kindFromName(item.path), source: "workspace" });
						continue;
					}
					if (!item.file || item.status === "failed") {
						if (item.status === "failed") failedNames.push(item.fileName);
						continue;
					}
					const key = item.path;
					const patch = (patchItem: Partial<PendingUpload>) => setUploads((current) =>
						current.map((entry) => entry.path === key && entry.source === "local" ? { ...entry, ...patchItem } : entry));
					patch({ status: "uploading", pct: 0 });
					try {
						const dataBase64 = arrayBufferToBase64(await item.file.arrayBuffer());
						const node = await uploadWorkspaceFileWithProgress(
							{ path: item.path, dataBase64 },
							targetWorkspaceId,
							(loaded, total) => patch({ pct: total > 0 ? Math.min(100, (loaded / total) * 100) : 0 }),
						);
						loose.push({ path: node.path, kind: kindFromName(node.path), source: "upload" });
						patch({ status: "ready", pct: 100, path: node.path });
					} catch {
						patch({ status: "failed", pct: 0 });
						failedNames.push(item.fileName);
					}
				}

				// Local files bound to keyword bubbles upload through the same
				// per-file pipeline; successes fold back into their bindings,
				// failures stay retryable and skip this message.
				const uploadedForBindings: Array<{ word: string; wordIndex: number; uid: number; path: string }> = [];
				let engineSkipped = 0;
				if (engine && outgoing) {
					for (const pending of outgoing.pendingFiles) {
						const uid = pending.file.uid;
						engine.setUploadProgress(uid, 0);
						try {
							const dataBase64 = arrayBufferToBase64(await pending.file.file.arrayBuffer());
							const node = await uploadWorkspaceFileWithProgress(
								{ path: pending.file.path, dataBase64 },
								targetWorkspaceId,
								(loaded, total) => engine.setUploadProgress(uid, total > 0 ? Math.min(100, (loaded / total) * 100) : 0),
							);
							engine.completeUpload(uid, node.path);
							uploadedForBindings.push({ word: pending.word, wordIndex: pending.wordIndex, uid, path: node.path });
						} catch {
							engine.failUpload(uid);
							engineSkipped++;
						}
					}
				}

				if (loose.length > 0 || pendingUploads.some((item) => item.source === "workspace") || uploadedForBindings.length > 0) {
					appStore.setRightPanelTab("preview");
					if (appStore.workspaceMode === "collapsed") appStore.setWorkspaceMode("quarter");
					if (workspaceStore.activeWorkspaceId !== targetWorkspaceId) await workspaceStore.setActiveWorkspace(targetWorkspaceId ?? null);
					else await workspaceStore.loadTree();
				}

				const imagesToSend = pendingImages.length > 0 ? pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;
				const bindings = engine && outgoing
					? engine.finalizeBindings(outgoing.readyBindings, uploadedForBindings)
					: [];
				const attachments = bindings.length > 0 || loose.length > 0 ? { bindings, loose } : undefined;
				const hasAttachments = Boolean(
					attachments && (
						attachments.loose.length > 0
						|| attachments.bindings.some((binding) => binding.files.length > 0)
					),
				);
				const messageContent = input || (
					pendingImages.length > 0
						? t("chat.describeImage")
						: hasAttachments
							? t("chat.describeAttachment")
							: ""
				);

				const editTarget = editTargetRef.current;
				if (editTarget && editTarget.sessionId === targetSessionId) {
					if (!chatStore.messages.some((message) => message.entryId === editTarget.entryId && message.role === "user")) {
						throw new Error(t("chat.editTargetMissing"));
					}
					await branchSessionBeforeMessage(editTarget.sessionId, editTarget.entryId);
					if (!chatStore.branchBefore(editTarget.entryId)) throw new Error(t("chat.editTargetMissing"));
					editTargetRef.current = null;
				} else if (editTarget) {
					editTargetRef.current = null;
				}

				resetComposer();
				// Creating a session can remount the composer (welcome → chat), so
				// the engine captured before the async work may no longer own the
				// visible mirror. Clean up the currently mounted engine instead.
				engineRef.current?.postSendCleanup();
				setUploads((current) => current.filter((entry) => entry.status === "failed"));
				setInlineImages([]);
				setWsError("");
				const skippedTotal = failedNames.length + engineSkipped;
				if (skippedTotal > 0) {
					showSmartToast(t("chat.smartInput.uploadSkippedCount", "有 {{count}} 个文件未上传成功，未随消息发送，已回到附件栏可重试", { count: skippedTotal }), true);
				}
				void chatStore.send(messageContent, imagesToSend, targetSessionId, attachments);
			} catch (error) {
				setWsError(error instanceof Error ? error.message : t("chat.errCreateSession"));
			} finally {
				setIsUploading(false);
			}
		})();
	}, [
		buildSessionInput,
		chat.isSending,
		inlineImages,
		isUploading,
		isWelcome,
		pasteBlocks,
		resizeInput,
		sessions.currentSessionId,
		showSmartToast,
		simpleMode,
		t,
		uploadWorkspaceId,
		uploads,
		wsExistingId,
		wsMode,
	]);

	const setComposerText = useCallback((text: string) => {
		draftRef.current = text;
		setDraftValue(text);
		const el = inputRef.current;
		if (el) {
			el.value = text;
			el.focus();
			// Programmatic value assignment fires no input event, and while smart
			// input is enabled the textarea's own text is transparent — without an
			// explicit sync the mirror stays stale and the draft renders invisible
			// until the next click/selection.
			engineRef.current?.syncNow();
			resizeInput();
		}
	}, [engineRef, resizeInput]);

	const handleEditMessage = useCallback((message: ChatMessage) => {
		if (chat.isSending || isUploading) return;
		const sessionId = sessions.currentSessionId;
		if (!sessionId || !message.entryId) return;
		const content = message.content.trim();
		const attachments = message.attachments;
		const bindingFiles = attachments?.bindings.flatMap((binding) => binding.files) ?? [];
		const hasAttachments = bindingFiles.length > 0 || Boolean(attachments?.loose.length);
		if (!content && !hasAttachments) return;
		const collapsedSkill = skillMessageFromContent(content);
		const command = collapsedSkill
			? { command: `skill:${collapsedSkill.skillName}`, args: collapsedSkill.args }
			: parseAgentCommandMessage(content);
		const editableText = command ? (command.args ? ` ${command.args}` : "") : content;
		const currentDraft = inputRef.current?.value ?? draftRef.current;
		if (currentDraft.trim() && currentDraft.trim() !== editableText.trim() && !window.confirm(t("chat.replaceDraftConfirm"))) return;
		editTargetRef.current = { sessionId, entryId: message.entryId };
		setInlineImages([]);
		setPasteBlocks([]);

		if (command) {
			setComposerText(editableText);
			const engine = engineRef.current;
			const useAgentBubble = Boolean(engine && smartInputEnabled && smartSettings?.allowAgentCommands === true);
			if (!useAgentBubble || !engine || !engine.insertAgentCommandAsBubble(command.command, 0, 0)) {
				setComposerText(`/${command.command}${command.args ? ` ${command.args}` : ""}`);
			}
		} else {
			setComposerText(content);
			const engine = smartInputEnabled ? engineRef.current : null;
			const unplacedBindings = engine?.restoreBindings(attachments?.bindings ?? []) ?? bindingFiles;
			const looseFiles = engine ? [...(attachments?.loose ?? []), ...unplacedBindings] : [...bindingFiles, ...(attachments?.loose ?? [])];
			setUploads(pendingUploadsFromRefs(looseFiles));
		}

		if (command) {
			// Agent command bubbles cannot own files, so keep any unusual mixed
			// command/file message editable by returning every file to the loose row.
			setUploads(pendingUploadsFromRefs([...bindingFiles, ...(attachments?.loose ?? [])]));
		}
		showSmartToast(t("chat.editLoaded"));
	}, [chat.isSending, isUploading, sessions.currentSessionId, setComposerText, showSmartToast, smartInputEnabled, smartSettings?.allowAgentCommands, t]);

	const slashQuery = slashQueryFromDraft(draftValue);
	const slashPaletteOpen = slashQuery !== null && slashDismissedFor !== draftValue && !chat.isSending;

	const slashAppActions = useMemo(() => {
		const actions: Array<{ action: SlashPaletteAction; name: string; description: string }> = [];
		// On the welcome screen the composer is already a fresh session draft,
		// so "new chat" would be a no-op.
		if (!isWelcome) actions.push({ action: "new-chat", name: "new", description: t("chat.slashPalette.newChatDesc") });
		actions.push({ action: "model", name: "model", description: t("chat.slashPalette.modelDesc") });
		// Simple Mode hides the Notebook/Profile surfaces, so don't offer them.
		if (!simpleMode) {
			actions.push({ action: "profile", name: "profile", description: t("chat.slashPalette.profileDesc") });
		}
		actions.push({ action: "jobs", name: "jobs", description: t("chat.slashPalette.jobsDesc") });
		actions.push({ action: "skills", name: "skills", description: t("chat.slashPalette.skillsDesc") });
		actions.push({ action: "settings", name: "settings", description: t("chat.slashPalette.settingsDesc") });
		return actions;
	}, [isWelcome, simpleMode, t]);

	const slashEntries = useMemo(() => {
		if (slashQuery === null) return [];
		// Bundled plugins' extension commands (rpiv-todo, pi-web-access, MCP
		// adapter) are TUI overlays gated on ctx.hasUI — they no-op server-side,
		// so only Inno's own webSafe commands are offered alongside skills and
		// prompt templates (both expand into a normal turn).
		const agentCommands = slashCommands.filter((command) => command.source !== "extension" || command.webSafe === true);
		return buildSlashPaletteEntries(slashAppActions, agentCommands, slashQuery);
	}, [slashAppActions, slashCommands, slashQuery]);

	// Restart keyboard navigation from the top whenever the query changes.
	useEffect(() => {
		setSlashActiveIndex(0);
	}, [slashQuery]);

	const handleSlashSelect = useCallback((entry: SlashPaletteEntry) => {
		if (entry.group === "app") {
			setComposerText("");
			const openRightPanelTab = (tab: "notebook" | "profile" | "skills" | "jobs") => {
				appStore.setRightPanelTab(tab);
				if (appStore.workspaceMode === "collapsed") appStore.setWorkspaceMode("quarter");
			};
			switch (entry.action) {
				case "new-chat": {
					const workspaceId = workspaceStore.activeWorkspaceId;
					if (workspaceId) sessionsStore.beginNewSessionIn(workspaceId);
					else sessionsStore.beginNewSession();
					break;
				}
				case "model":
					setModelPickerOpen(true);
					break;
				case "profile":
					openRightPanelTab("profile");
					break;
				case "jobs":
					openRightPanelTab("jobs");
					break;
				case "skills":
					openRightPanelTab("skills");
					break;
				case "settings":
					appStore.openSettings();
					break;
			}
			return;
		}
		if (smartInputEnabled && smartSettings?.allowAgentCommands === true) {
			// The slash palette owns the command selection. Replace its bare
			// `/query` draft with an atomic Agent bubble and leave a normal space
			// after it for command arguments.
			if (engineRef.current?.insertAgentCommandAsBubble(entry.name)) return;
		}
		// Feature off (or an engine that is not mounted): preserve the existing
		// behavior and stage "/name " so the user can add arguments.
		setComposerText(`/${entry.name} `);
	}, [engineRef, setComposerText, smartInputEnabled, smartSettings?.allowAgentCommands]);

	const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (slashPaletteOpen) {
			if (event.key === "Escape") {
				event.preventDefault();
				setSlashDismissedFor(draftValue);
				return;
			}
			if (slashEntries.length > 0) {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					setSlashActiveIndex((index) => (index + 1) % slashEntries.length);
					return;
				}
				if (event.key === "ArrowUp") {
					event.preventDefault();
					setSlashActiveIndex((index) => (index - 1 + slashEntries.length) % slashEntries.length);
					return;
				}
				if (event.key === "Enter" || event.key === "Tab") {
					event.preventDefault();
					handleSlashSelect(slashEntries[Math.min(slashActiveIndex, slashEntries.length - 1)]);
					return;
				}
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
	}, [handleSend, slashPaletteOpen, slashEntries, slashActiveIndex, draftValue, handleSlashSelect]);

	const handleStop = useCallback(() => chatStore.cancel(), []);
	const handleReconnect = useCallback(() => void chatStore.reconnect(), []);
	const handleRetry = useCallback(() => {
		shouldStickToBottomRef.current = true;
		void chatStore.retry();
	}, []);

	const addImageFiles = useCallback((files: File[]) => {
		filterUploadFiles(files).forEach((file) => {
			void prepareInlineImage(file).then((prepared) => setInlineImages((prev) => [...prev, prepared]));
		});
	}, [filterUploadFiles]);

	const addLocalFiles = useCallback((files: File[]) => {
		const accepted = filterUploadFiles(files);
		if (accepted.length === 0) return;
		setWsError("");
		setUploads((current) => [...current, ...accepted.map(localPendingUpload)]);
	}, [filterUploadFiles]);

	const showPasteInTextField = useCallback((blockId: number) => {
		const el = inputRef.current;
		const block = pasteBlocks.find((item) => item.id === blockId);
		if (!block || !el) return;
		const start = Math.min(el.selectionStart, el.value.length);
		const end = Math.min(el.selectionEnd, el.value.length);
		el.focus();
		el.setRangeText(block.text, start, end, "end");
		draftRef.current = el.value;
		setDraftValue(el.value);
		setDraftHasContent(el.value.trim().length > 0);
		setPasteBlocks((prev) => prev.filter((item) => item.id !== blockId));
		resizeInput();
		// setRangeText is a programmatic edit, so do not wait for the normal
		// typing debounce before refreshing the transparent smart-input mirror.
		engineRef.current?.syncNow();
		// setRangeText can update scrollTop without emitting a native scroll
		// event; keep the smart-input mirror aligned with the textarea viewport.
		el.dispatchEvent(new Event("scroll"));
	}, [pasteBlocks, resizeInput]);

	const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
		// SmartInputEngine handles its private clipboard format before React's
		// delegated paste listener. Do not also create a plain-text paste block.
		if (event.defaultPrevented) return;
		// Files copied from Finder/the desktop arrive through the clipboard as
		// DataTransfer files. Treat them exactly like files dropped onto the
		// composer: stage them in the attachment row above the textarea instead
		// of letting smart input turn a copied path into an inline bubble.
		const clipboardFiles = Array.from(event.clipboardData.files ?? []);
		if (clipboardFiles.length === 0) {
			for (const item of Array.from(event.clipboardData.items)) {
				if (item.kind !== "file") continue;
				const file = item.getAsFile();
				if (file) clipboardFiles.push(file);
			}
		}
		if (clipboardFiles.length > 0) {
			event.preventDefault();
			addLocalFiles(clipboardFiles);
			return;
		}
		const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
		if (imageItems.length > 0) {
			event.preventDefault();
			const files = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
			addImageFiles(files);
			return;
		}
		const text = event.clipboardData.getData("text/plain");
		if (text && isLargeTextPaste(text)) {
			event.preventDefault();
			const id = pasteBlockIdRef.current++;
			setPasteBlocks((prev) => [...prev, { id, text }]);
		}
	}, [addImageFiles, addLocalFiles]);

	const handleImageFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return;
		addImageFiles(files);
		event.target.value = "";
	}, [addImageFiles]);
	const removeInlineImage = useCallback((index: number) => {
		setInlineImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
	}, []);

	const handleFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		if (files.length === 0) return;
		addLocalFiles(files);
		event.target.value = "";
	}, [addLocalFiles]);

	const pickWorkspaceFiles = useCallback((paths: string[]) => {
		const uniquePaths = [...new Set(paths.filter(Boolean))];
		if (uniquePaths.length === 0) return;
		setWsError("");
		setUploads((current) => {
			const existing = new Set(current.filter((item) => item.source === "workspace").map((item) => item.path));
			const additions = uniquePaths
				.filter((path) => !existing.has(path))
				.map((path) => workspacePendingUpload(path));
			return additions.length > 0 ? [...current, ...additions] : current;
		});
	}, []);

	const retryUpload = useCallback((index: number) => {
		setUploads((current) => current.map((item, currentIndex) =>
			currentIndex === index && item.status === "failed" ? { ...item, status: "ready", pct: 0 } : item));
	}, []);

	const removeUpload = useCallback((index: number) => {
		setUploads((current) => current.filter((_, currentIndex) => currentIndex !== index));
	}, []);

	const renderComposer = (placeholder: string) => {
		// ChatUploadChips renders null on an empty list.
		const uploadChips = (
			<ChatUploadChips
				uploads={uploads}
				onRemove={removeUpload}
				onRetry={retryUpload}
				onInsertAsBubble={smartInputEnabled && smartSettings?.allowRightClick !== false
					? (path) => {
						const item = takeAttachment(path);
							if (item) engineRef.current?.insertAttachmentAsBubble(item);
						}
						: undefined}
				rules={smartSettings?.rules}
				workspaceId={activeWorkspaceId ?? uploadWorkspaceId ?? undefined}
				onOpenWorkspaceFile={openSmartFilePreview}
			/>
		);
		return (
			<ChatComposer
			inputRef={inputRef}
			fileInputRef={fileInputRef}
			imageInputRef={imageInputRef}
			placeholder={placeholder}
			defaultValue={draftRef.current}
			inlineImages={inlineImages}
			pasteBlocks={pasteBlocks}
			uploadChips={uploadChips}
			modelState={modelState}
			modelOptions={modelOptions}
			currentModel={currentModel}
			smartInputControl={((isWelcome && simpleMode) || (!isWelcome && !simpleMode)) ? (
				<SmartInputControl
					smartInputSettings={smartSettings}
					onToggleSmartInput={toggleSmartInput}
					onToggleSmartInputRule={toggleSmartInputRule}
					smartInputSaving={smartInputState.isSavingSmartInput}
					onOpenSmartInputSettings={openSmartInputSettings}
					compact
				/>
			) : null}
			modelPickerOpen={modelPickerOpen}
			attachMenuOpen={attachMenuOpen}
			workspaceFiles={workspaceFiles}
			smartInputEnabled={smartInputEnabled}
			mirrorRef={mirrorRef}
			hitRef={hitRef}
			chatIsSending={chat.isSending}
			canReconnect={chat.canReconnect}
			isUploading={isUploading}
			hasSendableContent={hasSendableContent}
			hasPendingQuestion={Boolean(chat.pendingQuestion)}
			onInput={handleInput}
			onCompositionStart={handleCompositionStart}
			onCompositionEnd={handleCompositionEnd}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			onFiles={handleFiles}
			onImageFiles={handleImageFiles}
			onRemoveInlineImage={removeInlineImage}
			onShowPasteInTextField={showPasteInTextField}
			onRemovePasteBlock={(blockId) => setPasteBlocks((prev) => prev.filter((block) => block.id !== blockId))}
			onToggleModelPicker={toggleModelPicker}
			onCloseModelPicker={closeModelPicker}
			onModelSelect={handleModelSelect}
			onOpenModelSettings={openModelSettings}
			onToggleAttachMenu={() => setAttachMenuOpen((open) => !open)}
			onCloseAttachMenu={() => setAttachMenuOpen(false)}
			onPickWorkspaceFiles={pickWorkspaceFiles}
			onDropFiles={addLocalFiles}
			onSend={handleSend}
			onStop={handleStop}
			onReconnect={handleReconnect}
			slashPalette={slashPaletteOpen ? (
				<SlashCommandPalette
					entries={slashEntries}
					activeIndex={slashActiveIndex}
					query={slashQuery ?? ""}
					onSelect={handleSlashSelect}
					onActiveChange={setSlashActiveIndex}
				/>
			) : undefined}
			/>
		);
	};

	const selectedWorkspaceId = wsMode === "existing" ? wsExistingId : null;
	const selectedKind: "workspace" | "temp" | "new" = wsMode === "existing" ? "workspace" : wsMode;
	const workspaceContext = !simpleMode ? (
			<WorkspaceContext
				workspaces={workspaces.list}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={wsMode === "new" ? wsName : ""}
				busy={isSwitchingWorkspace}
				disabled={isUploading || Boolean(chat.pendingQuestion)}
				onChange={handleWorkspaceChange}
				onImport={handleWorkspaceImport}
				smartInputSettings={smartSettings}
				onToggleSmartInput={toggleSmartInput}
				onToggleSmartInputRule={toggleSmartInputRule}
				smartInputSaving={smartInputState.isSavingSmartInput}
				onOpenSmartInputSettings={openSmartInputSettings}
			/>
	) : null;

	const questionHint = chat.pendingQuestion ? <QuestionHint scrollRef={scrollRef} /> : null;
	const busyBlocker = sessions.busyBlocker ? <BusyBlocker busyBlocker={sessions.busyBlocker} /> : null;
	const smartToastNode = smartToast ? (
		<div className={`inno-smart-toast ${smartToast.error ? "is-error" : ""}`} role="status">{smartToast.message}</div>
	) : null;
	const smartOverlayNode = smartInputEnabled ? (
		<SmartInputOverlay
			engine={engineRef.current}
			panel={smartPanel}
			onClose={() => updateSmartPanel(null)}
			onOpenPanel={updateSmartPanel}
			agentCommands={slashCommands}
			onSelectAgentCommand={(command) => {
				const current = smartPanelRef.current;
				if (current?.kind !== "agent") return;
				if (current.slotId !== undefined) {
					engineRef.current?.replaceAgentBubbleCommand(current.slotId, command);
					return;
				}
				if (current.agentKeyword) engineRef.current?.convertAgentKeywordToBubble(current.agentKeyword, command);
			}}
			onOpenSkillPanel={openSkillPanel}
			workspaceFiles={workspaceFiles}
			workspaceFilesLoading={workspaceTreeLoading || (workspaceTree === null && !workspaceTreeError)}
			attachments={uploads}
			takeAttachment={takeAttachment}
			onWorkspaceHighlight={highlightWorkspace}
			refreshKey={smartPanelRefresh}
			onOpenFilePreview={openSmartFilePreview}
		/>
	) : null;

	if (isWelcome) {
		return (
			<>
			{smartOverlayNode}
			<ChatWelcome
				welcomeLayoutRef={welcomeLayoutRef}
				simpleMode={simpleMode}
				togglingMode={togglingMode}
				onToggleMode={toggleMode}
				questionHint={questionHint}
				busyBlocker={busyBlocker}
				smartToast={smartToastNode}
				composer={renderComposer(t("chat.welcomePlaceholder"))}
				workspaceContext={workspaceContext}
				presets={presets}
				presetsLoaded={presetsLoaded}
				isLoadingPresets={isLoadingPresets}
				isRefreshingPresets={isRefreshingPresets}
				presetsRefreshError={presetsRefreshError}
				presetRefreshStatus={presetRefreshStatus}
				loadedPresetIds={loadedPresetIds}
				onRefreshPresets={() => void loadPresets(true)}
				openingPresetId={openingPresetId}
				onOpenPreset={openPreset}
				presetQuery={presetQuery}
				onPresetQueryChange={setPresetQuery}
				wsError={wsError}
			/>
			</>
		);
	}

	return (
		<>
		{smartOverlayNode}
		<ChatConversation
			chat={chat}
			scrollRef={scrollRef}
			onScroll={handleChatScroll}
			onWheel={markUserScrollGesture}
			onTouchStart={markUserScrollGesture}
			onPointerDown={handleScrollerPointerDown}
			onPauseAutoScroll={pauseAutoScroll}
			showLatestButton={showLatestButton}
			onJumpToLatest={jumpToLatest}
			questionHint={questionHint}
			busyBlocker={busyBlocker}
			smartToast={smartToastNode}
			composer={renderComposer(t("chat.composerPlaceholder"))}
			onOpenAttachment={openChatAttachmentPreview}
			onOpenSkill={openSkillPanel}
			onEditMessage={handleEditMessage}
			canRetry={Boolean(chat.lastUserPrompt) && !chat.isSending && !chat.pendingQuestion && !isUploading}
			onRetry={handleRetry}
			wsError={wsError}
		/>
		</>
	);
}
