import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { InnoModelInfo } from "../types/settings.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import type { CreateSessionInput } from "../api/sessions.js";
import { bindSessionWorkspace } from "../api/workspaces.js";
import { ApiError } from "../api/client.js";
import type { PresetMeta } from "../types/presets.js";
import { arrayBufferToBase64 } from "../api/uploads.js";
import { uploadWorkspaceFiles } from "../api/workspace.js";
import { fetchPresetList, readCachedPresets, removeCachedPreset } from "../utils/preset-cache.js";
import { useStoreSnapshot } from "./hooks.js";
import { ChatComposer } from "./chat/ChatComposer.js";
import { ChatConversation } from "./chat/ChatConversation.js";
import { BusyBlocker, QuestionHint } from "./chat/ChatStatusBanners.js";
import { ChatUploadChips } from "./chat/ChatUploadChips.js";
import { ChatWelcome } from "./chat/ChatWelcome.js";
import { WorkspaceContext } from "./chat/WorkspaceContext.js";
import type { WorkspaceChoice } from "./WorkspaceSwitcher.js";
import {
	isLargeTextPaste,
	prepareInlineImage,
	resizeComposerTextarea,
	type PendingPasteBlock,
	type PendingUpload,
	type PreparedInlineImage,
} from "./chat/composer-utils.js";

type PresetRefreshStatus = "success" | "error";


type WsMode = "temp" | "new" | "existing";

// Remember the user's last workspace choice for a new chat so the bottom
// "新建对话" button doesn't always reset to temp.
const LAST_WS_MODE_KEY = "inno.lastWorkspaceMode";
const LAST_WS_ID_KEY = "inno.lastWorkspaceId";

interface ChatCenterProps {
	onOpenPresetPanels: () => void | Promise<void>;
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

export function ChatCenter({ onOpenPresetPanels }: ChatCenterProps) {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const welcomeLayoutRef = useRef<HTMLDivElement | null>(null);
	const welcomeComposerBaseHeightRef = useRef<number | null>(null);
	const draftRef = useRef("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const userScrollGestureRef = useRef(false);
	const pasteBlockIdRef = useRef(0);
	const [uploads, setUploads] = useState<PendingUpload[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [inlineImages, setInlineImages] = useState<PreparedInlineImage[]>([]);
	const [draftValue, setDraftValue] = useState(draftRef.current);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [pasteBlocks, setPasteBlocks] = useState<PendingPasteBlock[]>([]);

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
	const isWelcome = sessions.isWelcome;

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

	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.querySelector<HTMLElement>("[data-conversation-content]");
		if (!el || !content) return;
		const observer = new ResizeObserver(() => {
			if (shouldStickToBottomRef.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [sessions.currentSessionId]);

	useEffect(() => {
		shouldStickToBottomRef.current = true;
	}, [sessions.currentSessionId]);

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
			return;
		}
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
		const textareaHeight = el.getBoundingClientRect().height;
		const composerHeight = composer.getBoundingClientRect().height;
		if (welcomeComposerBaseHeightRef.current === null) {
			welcomeComposerBaseHeightRef.current = composerHeight - textareaHeight + minHeight;
		}
		const composerGrowth = Math.max(0, composerHeight - welcomeComposerBaseHeightRef.current);
		welcomeLayout.style.setProperty("--inno-welcome-composer-half-growth", `${composerGrowth / 2}px`);
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
		const rawValue = inputRef.current?.value ?? draftValue;
		const input = [rawValue.trim(), ...pasteBlocks.map((block) => block.text.trim())].filter(Boolean).join("\n\n");
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
					if (!simpleMode) rememberWsChoice(wsMode, wsExistingId);
					await sessionsStore.createSessionWith(wsInput);
					targetSessionId = sessionsStore.currentSessionId;
				}

				const targetWorkspaceId = workspaceStore.activeWorkspaceId ?? (isWelcome ? undefined : uploadWorkspaceId ?? undefined);
				if (pendingUploads.length > 0 && targetWorkspaceId === undefined) throw new Error(t("chat.uploadHint"));

				let uploadedFiles: Array<{ fileName: string; path: string }> = [];
				if (pendingUploads.length > 0) {
					const uploadItems = await Promise.all(pendingUploads.map(async ({ path, file }) => ({
						path,
						dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
					})));
					const result = await uploadWorkspaceFiles(uploadItems, targetWorkspaceId);
					uploadedFiles = (result.uploaded ?? []).map((node) => ({ fileName: node.name, path: node.path }));
					appStore.setRightPanelTab("preview");
					if (appStore.workspaceMode === "collapsed") appStore.setWorkspaceMode("quarter");
					if (workspaceStore.activeWorkspaceId !== targetWorkspaceId) await workspaceStore.setActiveWorkspace(targetWorkspaceId ?? null);
					else await workspaceStore.loadTree();
				}

				const uploadNote = uploadedFiles.length > 0
					? `\n\n${t("chat.uploadedToWorkspace")}\n${uploadedFiles.map((file) => `- ${file.fileName}: ${file.path}`).join("\n")}`
					: "";
				const messageContent = `${input}${uploadNote}` || (pendingImages.length > 0 ? t("chat.describeImage") : "");
				const imagesToSend = pendingImages.length > 0 ? pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;

				resetComposer();
				setUploads([]);
				setInlineImages([]);
				setWsError("");
				void chatStore.send(messageContent, imagesToSend, targetSessionId);
			} catch (error) {
				setWsError(error instanceof Error ? error.message : t("chat.errCreateSession"));
			} finally {
				setIsUploading(false);
			}
		})();
	}, [
		buildSessionInput,
		chat.isSending,
		draftValue,
		inlineImages,
		isUploading,
		isWelcome,
		pasteBlocks,
		resizeInput,
		sessions.currentSessionId,
		simpleMode,
		t,
		uploadWorkspaceId,
		uploads,
		wsExistingId,
		wsMode,
	]);

	const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
	}, [handleSend]);

	const handleStop = useCallback(() => chatStore.cancel(), []);
	const handleReconnect = useCallback(() => void chatStore.reconnect(), []);
	const handleRetry = useCallback(() => {
		shouldStickToBottomRef.current = true;
		void chatStore.retry();
	}, []);

	const addImageFiles = useCallback((files: File[]) => {
		files.forEach((file) => {
			void prepareInlineImage(file).then((prepared) => setInlineImages((prev) => [...prev, prepared]));
		});
	}, []);

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
		setPasteBlocks((prev) => prev.filter((item) => item.id !== blockId));
		resizeInput();
	}, [pasteBlocks, resizeInput]);

	const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
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
	}, [addImageFiles]);

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
		setWsError("");
		const items = files.map((file) => ({
			fileName: file.name,
			path: file.name.replace(/[\\/?%*:|"<>]/g, "_").trim() || `upload-${Date.now()}`,
			file,
		}));
		setUploads((current) => [...current, ...items]);
		event.target.value = "";
	}, []);
	const removeUpload = useCallback((index: number) => {
		setUploads((current) => current.filter((_, currentIndex) => currentIndex !== index));
	}, []);

	const renderComposer = (placeholder: string) => (
		<ChatComposer
			inputRef={inputRef}
			fileInputRef={fileInputRef}
			imageInputRef={imageInputRef}
			placeholder={placeholder}
			defaultValue={draftRef.current}
			inlineImages={inlineImages}
			pasteBlocks={pasteBlocks}
			modelState={modelState}
			modelOptions={modelOptions}
			currentModel={currentModel}
			modelPickerOpen={modelPickerOpen}
			chatIsSending={chat.isSending}
			canReconnect={chat.canReconnect}
			lastUserPrompt={chat.lastUserPrompt}
			isUploading={isUploading}
			hasSendableContent={hasSendableContent}
			hasPendingQuestion={Boolean(chat.pendingQuestion)}
			onInput={handleInput}
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
			onSend={handleSend}
			onStop={handleStop}
			onReconnect={handleReconnect}
			onRetry={handleRetry}
		/>
	);

	const renderWorkspaceContext = (context: "welcome" | "session") => {
		// The workspace selector belongs to the new-chat home page. A real
		// conversation already has a fixed workspace context and should keep the
		// composer uncluttered.
		if (context === "session") return null;
		const selectedWorkspaceId = wsMode === "existing" ? wsExistingId : null;
		const selectedKind: "workspace" | "temp" | "new" = wsMode === "existing" ? "workspace" : wsMode;
		return (
			<WorkspaceContext
				workspaces={workspaces.list}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={wsMode === "new" ? wsName : ""}
				busy={isSwitchingWorkspace}
				disabled={isUploading || Boolean(chat.pendingQuestion)}
				onChange={handleWorkspaceChange}
			/>
		);
	};

	const uploadChips = <ChatUploadChips uploads={uploads} onRemove={removeUpload} />;
	const questionHint = chat.pendingQuestion ? <QuestionHint scrollRef={scrollRef} /> : null;
	const busyBlocker = <BusyBlocker busyBlocker={sessions.busyBlocker} />;

	if (isWelcome) {
		return (
			<ChatWelcome
				welcomeLayoutRef={welcomeLayoutRef}
				simpleMode={simpleMode}
				togglingMode={togglingMode}
				onToggleMode={toggleMode}
				uploadChips={uploadChips}
				questionHint={questionHint}
				busyBlocker={busyBlocker}
				composer={renderComposer(t("chat.welcomePlaceholder"))}
				workspaceContext={renderWorkspaceContext("welcome")}
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
		);
	}

	return (
		<ChatConversation
			chat={chat}
			scrollRef={scrollRef}
			onScroll={handleChatScroll}
			onWheel={markUserScrollGesture}
			onTouchStart={markUserScrollGesture}
			onPointerDown={handleScrollerPointerDown}
			onPauseAutoScroll={pauseAutoScroll}
			uploadChips={uploadChips}
			questionHint={questionHint}
			busyBlocker={busyBlocker}
			composer={renderComposer(t("chat.composerPlaceholder"))}
			workspaceContext={renderWorkspaceContext("session")}
			wsError={wsError}
		/>
	);
}
