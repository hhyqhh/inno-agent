import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Paperclip, X, SendHorizonal, Square, RotateCcw, Check, Image } from "lucide-react";
import type { ChatMessage } from "../types/chat.js";
import type { InlineImage } from "../api/chat.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { appStore } from "../stores/app-store.js";
import type { CreateSessionInput } from "../api/sessions.js";
import { uploadRawFile, type RawUploadResult } from "../api/uploads.js";
import { useStoreSnapshot } from "./hooks.js";
import { QuestionDialog } from "./QuestionDialog.js";
import "@earendil-works/pi-web-ui";

const CHANNEL_BADGE_CLASS: Record<string, string> = {
	cli: "bg-slate-100 text-slate-500",
	web: "bg-blue-50 text-blue-500",
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
		<span className={`inline-block rounded px-1.5 py-px text-[9px] font-medium leading-tight ring-1 ring-black/5 ${CHANNEL_BADGE_CLASS[channel] ?? "bg-slate-50 text-slate-400"}`}>
			{CHANNEL_LABEL[channel] ?? channel}
		</span>
	);
}

function MessageBubble({ message, showChannel }: { message: ChatMessage; showChannel?: boolean }) {
	if (message.role === "user") {
		return (
			<motion.div
				className="flex justify-end"
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.25, ease: "easeOut" }}
			>
				<div className="inno-message w-fit whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-100 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-950" style={{ maxWidth: "min(70%, 38rem)" }}>
					{showChannel && message.channel ? (
						<div className="mb-1 flex justify-end"><ChannelBadge channel={message.channel} /></div>
					) : null}
					{message.images?.length ? (
						<div className="mb-2 flex flex-wrap gap-1.5">
							{message.images.map((img, i) => (
								<img key={i} src={img.previewUrl} alt="attached" className="max-h-48 max-w-full rounded object-contain" />
							))}
						</div>
					) : null}
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
			<div className="inno-message max-w-[78%] rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-950">
				{showChannel && message.channel ? (
					<div className="mb-1"><ChannelBadge channel={message.channel} /></div>
				) : null}
				{message.thinking || message.tools?.length ? (
					<details className="mb-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-500">
						<summary className="cursor-pointer select-none font-medium text-slate-600">
							Thinking & tool calls
							{message.tools?.length ? ` · ${message.tools.length}` : ""}
						</summary>
						{message.thinking ? <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap font-mono">{message.thinking}</pre> : null}
						{message.tools?.length ? (
							<div className="mt-2 grid gap-1.5">
								{message.tools.map((tool) => (
									<details key={tool.toolCallId} className="rounded border border-slate-200 bg-white px-2 py-1">
										<summary className={tool.isError ? "cursor-pointer text-red-600" : "cursor-pointer text-slate-600"}>
											{tool.toolName}
										</summary>
										<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
									</details>
								))}
							</div>
						) : null}
					</details>
				) : null}
				<markdown-artifact content={message.content} />
			</div>
		</motion.div>
	);
}

type WsMode = "temp" | "new" | "existing";

function ModeChip({ selected, onClick, disabled, children }: { selected: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`rounded-full border px-1.5 py-px text-[10px] leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				selected
					? "border-blue-300 bg-blue-50 text-blue-700"
					: "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
			}`}
		>
			{children}
		</button>
	);
}

export function ChatCenter() {
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [uploads, setUploads] = useState<RawUploadResult[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [inlineImages, setInlineImages] = useState<(InlineImage & { name: string; previewUrl: string })[]>([]);

	// Inline workspace chooser state (welcome screen only).
	const [wsMode, setWsMode] = useState<WsMode>("temp");
	const [wsName, setWsName] = useState("");
	const [wsExistingId, setWsExistingId] = useState("");
	const [wsError, setWsError] = useState("");

	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		isSending: chatStore.isSending,
		isLoadingHistory: chatStore.isLoadingHistory,
		streamingText: chatStore.streamingText,
		streamingThinking: chatStore.streamingThinking,
		activeTools: chatStore.activeTools,
		completedTools: chatStore.completedTools,
		lastUserPrompt: chatStore.lastUserPrompt,
		pendingQuestion: chatStore.pendingQuestion,
	}));
	const sessions = useStoreSnapshot(sessionsStore, () => ({
		pendingNewSession: sessionsStore.pendingNewSession,
		currentSessionId: sessionsStore.currentSessionId,
		preselectedWorkspaceId: sessionsStore.preselectedWorkspaceId,
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

	// Welcome state: brand-new chat without an active session yet.
	const isWelcome =
		sessions.pendingNewSession ||
		(!sessions.currentSessionId && chat.messages.length === 0 && !chat.isLoadingHistory && !chat.isSending);

	useEffect(() => {
		if (isWelcome && workspaces.list.length === 0) {
			void workspacesStore.load();
		}
	}, [isWelcome, workspaces.list.length]);

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
		if (wsMode === "temp") return { newWorkspace: { isTemp: true } };
		if (wsMode === "new") {
			const trimmed = wsName.trim();
			if (!trimmed) return { __error: "请填写工作区名称" };
			return { newWorkspace: { name: trimmed, isTemp: false } };
		}
		if (!wsExistingId) return { __error: "请选择一个工作区" };
		return { workspaceId: wsExistingId };
	}, [wsMode, wsName, wsExistingId]);

	// Create the new workspace + session up-front (before any message) and reveal
	// it in the right panel so the user can upload files / skills first.
	const confirmNewWorkspace = useCallback(() => {
		const trimmed = wsName.trim();
		if (!trimmed) { setWsError("请填写工作区名称"); return; }
		setWsError("");
		void (async () => {
			try {
				await sessionsStore.createSessionWith({ newWorkspace: { name: trimmed, isTemp: false } });
				appStore.setRightPanelTab("preview");
				appStore.setWorkspaceWidth(560);
				appStore.setWorkspaceMode("half");
				setWsName("");
			} catch (err) {
				setWsError(err instanceof Error ? err.message : "创建工作区失败");
			}
		})();
	}, [wsName]);

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
	}, [isWelcome, buildSessionInput, uploads, inlineImages, chat.isSending, isUploading]);

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
					<span key={`${file.rawPath}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs shadow-sm">
						<span className="max-w-[220px] truncate">{file.fileName}</span>
						<span className="text-slate-500">{file.rawPath}</span>
						<button className="text-slate-500 hover:text-slate-950" title="Remove upload" onClick={() => removeUpload(index)}>
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
					<span key={`${img.name}-${index}`} className="relative inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-1 shadow-sm">
						<img src={img.previewUrl} alt={img.name} className="h-12 w-12 rounded object-cover" />
						<button
							className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-600 text-white hover:bg-slate-800"
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
				className="min-h-[36px] max-h-[140px] flex-1 resize-none overflow-hidden rounded-md border-0 bg-transparent px-2 py-2 text-sm leading-5 text-slate-950 outline-none placeholder:text-slate-400 disabled:opacity-60"
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
						className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${isUploading ? "cursor-not-allowed bg-slate-100 text-slate-500" : "bg-slate-900 text-white hover:bg-slate-800"}`}
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
							<div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-base font-semibold text-blue-600 shadow-sm">IA</div>
							<h2 className="text-lg font-medium text-slate-950">Inno Agent</h2>
						</div>

						{renderUploadChips()}
						{renderInlineImagePreviews()}
						{renderComposer("有什么想学习或实践的?发送消息开始…")}

						{preselectedWs ? (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-slate-400">工作区</span>
								<span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-100">
									{preselectedWs.name}
								</span>
								<span className="text-[10px] text-slate-400">新对话将创建于此工作区</span>
							</div>
						) : (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<span className="text-xs text-slate-400">工作区</span>
								<ModeChip selected={wsMode === "temp"} onClick={() => setWsMode("temp")}>临时·用完即弃</ModeChip>
								<ModeChip selected={wsMode === "new"} onClick={() => setWsMode("new")}>新建工作区</ModeChip>
								{wsMode === "new" ? (
									<>
										<input
											type="text"
											placeholder="工作区名称,例如:pandas demo"
											value={wsName}
											onChange={(e) => setWsName(e.target.value)}
											onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmNewWorkspace(); } }}
											className="ml-1 w-[200px] rounded-full border border-slate-200 bg-white px-2 py-px text-[10px] leading-tight outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
										/>
										<button
											type="button"
											onClick={confirmNewWorkspace}
											disabled={!wsName.trim()}
											title="创建并绑定工作区(可先上传文件/技能,再开始对话)"
											className="flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
										>
											<Check size={11} /> 创建并绑定
										</button>
									</>
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
				<div className="mx-auto flex max-w-3xl flex-col gap-3">
					{chat.isLoadingHistory && chat.messages.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center pt-20 text-slate-500">
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
							<div className="inno-message max-w-[78%] rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[13px]">
								{chat.activeTools.map((tool) => (
									<div key={tool.toolCallId} className="flex items-center gap-2 text-slate-500">
										<span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
										<span className="font-mono text-xs">{tool.toolName}</span>
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
							<details className="inno-message max-w-[78%] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
								<summary className="cursor-pointer">Thinking...</summary>
								<pre className="mt-1 whitespace-pre-wrap font-mono">{chat.streamingThinking}</pre>
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
							<details className="inno-message max-w-[78%] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
								<summary className="cursor-pointer">Completed tool calls · {chat.completedTools.length}</summary>
								<div className="mt-2 grid gap-1.5">
									{chat.completedTools.map((tool) => (
										<details key={tool.toolCallId} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
											<summary className={tool.isError ? "cursor-pointer text-red-600" : "cursor-pointer text-slate-600"}>{tool.toolName}</summary>
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify({ args: tool.args, result: tool.result }, null, 2)}</pre>
										</details>
									))}
								</div>
							</details>
						</motion.div>
					) : null}

					{chat.pendingQuestion ? (
						<QuestionDialog pending={chat.pendingQuestion} />
					) : null}

					{chat.streamingText ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
						>
							<div className="inno-message max-w-[78%] rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-950">
								<markdown-artifact content={chat.streamingText} />
							</div>
						</motion.div>
					) : null}

					{chat.isSending && !chat.streamingText && chat.activeTools.length === 0 ? (
						<motion.div
							className="flex justify-start"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.15 }}
						>
							<div className="inno-message max-w-[78%] rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-500">
								<span className="inline-flex gap-1">
									<span className="animate-bounce">·</span>
									<span className="animate-bounce" style={{ animationDelay: "150ms" }}>·</span>
									<span className="animate-bounce" style={{ animationDelay: "300ms" }}>·</span>
								</span>
							</div>
						</motion.div>
					) : null}
				</div>
			</div>

			<div className="shrink-0 border-t border-slate-200 bg-white p-3">
				<div className="mx-auto max-w-3xl">
					{renderUploadChips()}
					{renderInlineImagePreviews()}
					{renderComposer("Type a message...")}
				</div>
			</div>
		</section>
	);
}
