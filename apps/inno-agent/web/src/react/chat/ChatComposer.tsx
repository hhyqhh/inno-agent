import {
	useUITransition,
	DropdownMenu,
	DropdownMenuActionItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuOptionItem,
	DropdownMenuRadioGroup,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Spinner,
	IconButton,
	Tooltip,
} from "../ui/index.js";
import { useRef, useState, type ChangeEvent, type ClipboardEvent, type CompositionEvent as ReactCompositionEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { X, ArrowUp, Square, RotateCcw, Image, ScrollText, ChevronDown, CornerDownLeft, Plus, Settings2, HardDriveUpload } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { FileName } from "../FileName.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import type { InnoModelInfo } from "../../types/settings.js";
import type { PreparedInlineImage, PendingPasteBlock } from "./composer-utils.js";
import { kindFromName } from "./smart-input/kinds.js";
import { ModelProviderIcon } from "./ModelProviderIcon.js";

export interface ChatComposerModelState {
	models: InnoModelInfo[];
	defaultProvider: string;
	defaultModel: string;
	currentModelSupportsNativeImages: boolean;
	isSavingModel: boolean;
}

export interface ChatComposerProps {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	fileInputRef: RefObject<HTMLInputElement | null>;
	imageInputRef: RefObject<HTMLInputElement | null>;
	placeholder: string;
	defaultValue: string;
	inlineImages: PreparedInlineImage[];
	pasteBlocks: PendingPasteBlock[];
	uploadChips: ReactNode;
	modelState: ChatComposerModelState;
	modelOptions: InnoModelInfo[];
	currentModel?: InnoModelInfo;
	/** Permission switcher; welcome uses a pill, conversation uses a frameless labeled control. */
	permissionControl?: ReactNode;
	/** Read-only context meter, shown next to the model picker in conversations. */
	contextUsageControl?: ReactNode;
	/** Workspace selector shown on the welcome composer sub-pill row. */
	workspaceControl?: ReactNode;
	/** Move conversation-only controls into the input card; welcome keeps the
	 *  existing sub-pill row layout. */
	conversationMode?: boolean;
	modelPickerOpen: boolean;
	attachMenuOpen: boolean;
	workspaceFiles: Array<{ name: string; path: string }>;
	smartInputEnabled: boolean;
	mirrorRef: RefObject<HTMLDivElement | null>;
	hitRef: RefObject<HTMLDivElement | null>;
	chatIsSending: boolean;
	/** A manual job run is streaming — shows the stop button without locking
	 *  the composer the way a normal chat turn does. */
	jobStreaming?: boolean;
	canReconnect: boolean;
	isUploading: boolean;
	hasSendableContent: boolean;
	hasPendingQuestion: boolean;
	onInput: () => void;
	onCompositionStart: (event: ReactCompositionEvent<HTMLTextAreaElement>) => void;
	onCompositionEnd: (event: ReactCompositionEvent<HTMLTextAreaElement>) => void;
	onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
	onFiles: (event: ChangeEvent<HTMLInputElement>) => void;
	onImageFiles: (event: ChangeEvent<HTMLInputElement>) => void;
	onRemoveInlineImage: (index: number) => void;
	onShowPasteInTextField: (blockId: number) => void;
	onRemovePasteBlock: (blockId: number) => void;
	onToggleModelPicker: () => void;
	onCloseModelPicker: () => void;
	onModelSelect: (model: InnoModelInfo) => void;
	onOpenModelSettings: () => void;
	onToggleAttachMenu: () => void;
	onCloseAttachMenu: () => void;
	onPickWorkspaceFiles: (paths: string[]) => void;
	onDropFiles: (files: File[]) => void;
	onSend: () => void;
	onStop: () => void;
	onReconnect: () => void;
	/** Slash-command palette rendered above the composer (ChatCenter owns its state). */
	slashPalette?: ReactNode;
}

export function ChatComposer({
	inputRef,
	fileInputRef,
	imageInputRef,
	placeholder,
	defaultValue,
	inlineImages,
	pasteBlocks,
	uploadChips,
	modelState,
	modelOptions,
	currentModel,
	permissionControl,
	contextUsageControl,
	workspaceControl,
	conversationMode = false,
	modelPickerOpen,
	attachMenuOpen,
	workspaceFiles,
	smartInputEnabled,
	mirrorRef,
	hitRef,
	chatIsSending,
	jobStreaming = false,
	canReconnect,
	isUploading,
	hasSendableContent,
	hasPendingQuestion,
	onInput,
	onCompositionStart,
	onCompositionEnd,
	onKeyDown,
	onPaste,
	onFiles,
	onImageFiles,
	onRemoveInlineImage,
	onShowPasteInTextField,
	onRemovePasteBlock,
	onToggleModelPicker,
	onCloseModelPicker,
	onModelSelect,
	onOpenModelSettings,
	onToggleAttachMenu,
	onCloseAttachMenu,
	onPickWorkspaceFiles,
	onDropFiles,
	onSend,
	onStop,
	onReconnect,
	slashPalette,
}: ChatComposerProps) {
	const uiTransition = useUITransition();
	const { t } = useTranslation();
	const [osFileDragOver, setOsFileDragOver] = useState(false);
	const currentModelLabel = currentModel?.name || currentModel?.id || modelState.defaultModel || t("chat.modelUnavailable");

	const isOsFileDrag = (event: ReactDragEvent<HTMLElement>): boolean =>
		Array.from(event.dataTransfer?.types ?? []).includes("Files");
	const isWorkspaceFileDrag = (event: ReactDragEvent<HTMLElement>): boolean =>
		Array.from(event.dataTransfer?.types ?? []).includes("application/x-inno-file");
	const isSmartBubbleDropTarget = (event: ReactDragEvent<HTMLElement>): boolean =>
		event.target instanceof Element && Boolean(event.target.closest(".inno-smart-chip"));
	const readWorkspaceFilePaths = (event: ReactDragEvent<HTMLElement>): string[] => {
		const raw = event.dataTransfer?.getData("application/x-inno-file");
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as {
				path?: unknown;
				source?: unknown;
				items?: unknown;
			};
			const candidates = Array.isArray(parsed.items) ? parsed.items : [parsed];
			return candidates.flatMap((candidate) => {
				if (!candidate || typeof candidate !== "object") return [];
				const item = candidate as { path?: unknown; source?: unknown };
				return item.source === "workspace" && typeof item.path === "string" ? [item.path] : [];
			});
		} catch {
			return [];
		}
	};

	const handleComposerDragOver = (event: ReactDragEvent<HTMLElement>) => {
		if (!isOsFileDrag(event) && !isWorkspaceFileDrag(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		setOsFileDragOver(true);
	};

	const handleComposerDrop = (event: ReactDragEvent<HTMLElement>) => {
		if (isWorkspaceFileDrag(event)) {
			// A file that already became a bubble is still physically held until
			// mouse-up. Do not add that consumed drag to the loose attachment row.
			if (document.body.classList.contains("inno-smart-drag-consumed")) {
				event.preventDefault();
				event.stopPropagation();
				document.body.classList.remove("inno-smart-drag-consumed");
				setOsFileDragOver(false);
				return;
			}
			// Existing bubbles own their drop behavior; blank composer space adds
			// the workspace file to the attachment row above the input.
			if (isSmartBubbleDropTarget(event)) {
				setOsFileDragOver(false);
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setOsFileDragOver(false);
			const paths = readWorkspaceFilePaths(event);
			if (paths.length > 0) onPickWorkspaceFiles(paths);
			return;
		}
		if (!isOsFileDrag(event)) return;
		// The composer listens in both capture and bubble phases. Handle a
		// normal drop here once, otherwise the same local file is appended twice.
		// A smart bubble owns drops on itself so it can bind the file instead.
		if (isSmartBubbleDropTarget(event)) {
			setOsFileDragOver(false);
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setOsFileDragOver(false);
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) onDropFiles(files);
	};

	const renderInlineImagePreviews = () => (
		inlineImages.length > 0 ? (
			<div className="flex flex-wrap gap-1.5">
				{inlineImages.map((img, index) => (
					<span key={`${img.name}-${index}`} className="inno-inline-image-card">
						<span className="inno-inline-image-preview" aria-hidden="true">
							<img src={img.previewUrl} alt="" />
						</span>
						<img src={img.previewUrl} alt={img.name} className="h-12 w-12 rounded object-cover" />
						<Tooltip label={t("chat.removeImage")}>
							<button
								type="button"
								className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] shadow-sm hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)]"
								aria-label={t("chat.removeImage")}
								onClick={() => onRemoveInlineImage(index)}
							>
								<X size={12} />
							</button>
						</Tooltip>
					</span>
				))}
			</div>
		) : null
	);

	const renderPasteBlock = (block: PendingPasteBlock) => {
		const compactText = block.text.replace(/\s+/g, " ").trim();
		const preview = Array.from(compactText).slice(0, 16).join("") || "…";
		const hasMoreText = Array.from(compactText).length > 16;
		const activate = () => onShowPasteInTextField(block.id);
		return (
			<div
				key={block.id}
				className="inno-paste-card"
				role="button"
				tabIndex={0}
				aria-label={`${preview}${hasMoreText ? "…" : ""} · ${t("common.pasteCardCharCount", "{{count}} 字", { count: block.text.length })}`}
				onClick={activate}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						activate();
					}
				}}
				>
					<span className="inno-paste-card-icon" aria-hidden="true">
						<ScrollText size={14} />
				</span>
				<Tooltip label={compactText}>
					<div className="inno-paste-card-copy">
						<span className="inno-paste-card-preview">{preview}{hasMoreText ? "…" : ""}</span>
						<span className="inno-paste-card-count">· {t("common.pasteCardCharCount", "{{count}} 字", { count: block.text.length })}</span>
					</div>
				</Tooltip>
				<Tooltip label={t("common.pasteCardRemove")}>
					<button
						type="button"
						className="inno-paste-card-remove"
						aria-label={t("common.pasteCardRemove")}
						onClick={(event) => {
							event.stopPropagation();
							onRemovePasteBlock(block.id);
						}}
					>
						<X size={12} />
					</button>
				</Tooltip>
			</div>
		);
	};

	const renderComposerAttachments = () => (
		uploadChips || inlineImages.length > 0 || pasteBlocks.length > 0 ? (
			<div className="inno-composer-attachments mb-0 flex min-w-0 flex-wrap items-start gap-2">
				{uploadChips}
				{renderInlineImagePreviews()}
				{pasteBlocks.map(renderPasteBlock)}
			</div>
		) : null
	);

	const renderAttachMenu = () => (
		<DropdownMenu
			open={attachMenuOpen}
			onOpenChange={(nextOpen) => {
				if (nextOpen && !attachMenuOpen) onToggleAttachMenu();
				else if (!nextOpen && attachMenuOpen) onCloseAttachMenu();
			}}
		>
			<DropdownMenuTrigger asChild>
				<IconButton
					variant="ghost"
					size="md"
					shape="pill"
					className="inno-composer-action"
					title={t("chat.uploadFiles")}
					aria-label={t("chat.uploadFiles")}
					disabled={chatIsSending || isUploading}
				>
					{isUploading ? <Spinner size={16} /> : <Plus size={18} />}
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" sideOffset={8} collisionPadding={8} aria-label={t("chat.uploadFiles")} className="inno-smart-attach-menu">
				<DropdownMenuActionItem
					icon={<HardDriveUpload size={14} />}
					label={t("chat.smartInput.attachFromThisDevice", "本机文件…")}
					onSelect={() => {
						onCloseAttachMenu();
						fileInputRef.current?.click();
					}}
				/>
				<DropdownMenuLabel className="inno-smart-attach-menu-caption">
					{workspaceFiles.length > 0
						? t("chat.smartInput.attachFromWorkspace", "从工作区添加")
						: t("chat.smartInput.workspaceEmpty", "工作区暂无文件")}
				</DropdownMenuLabel>
				{workspaceFiles.map((file) => (
					<DropdownMenuActionItem
						key={file.path}
						icon={<FileTypeIcon kind={kindFromName(file.name)} size={14} />}
						label={<FileName name={file.name} className="min-w-0 flex-1" />}
						title={file.path}
						onSelect={() => onPickWorkspaceFiles([file.path])}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);

	const modelOptionValue = (provider: string, modelId: string) => JSON.stringify([provider, modelId]);
	const selectedModelValue = modelOptionValue(modelState.defaultProvider, modelState.defaultModel);
	const renderModelPicker = () => (
		<DropdownMenu
			open={modelPickerOpen && modelOptions.length > 0}
			onOpenChange={(nextOpen) => {
				if (nextOpen && !modelPickerOpen) onToggleModelPicker();
				else if (!nextOpen && modelPickerOpen) onCloseModelPicker();
			}}
		>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="inno-composer-model-trigger inno-composer-subrow-control flex h-8 shrink-0 items-center gap-1 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
					aria-label={t("chat.selectModel")}
					disabled={modelOptions.length === 0 || modelState.isSavingModel || chatIsSending}
				>
					{modelState.defaultProvider ? <ModelProviderIcon provider={currentModel?.provider ?? modelState.defaultProvider} /> : null}
						<span className="max-w-[32vw] truncate whitespace-nowrap md:max-w-none">{currentModelLabel}</span>
						<motion.span
							className="inline-flex shrink-0"
							animate={{ rotate: modelPickerOpen ? 180 : 0 }}
							transition={uiTransition}
						>
							<ChevronDown size={13} aria-hidden="true" />
						</motion.span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" sideOffset={8} collisionPadding={8} aria-label={t("chat.selectModel")} className="inno-composer-model-menu">
				<DropdownMenuRadioGroup
					value={selectedModelValue}
					onValueChange={(value) => {
						const model = modelOptions.find((option) => modelOptionValue(option.provider, option.id) === value);
						if (model) onModelSelect(model);
					}}
				>
					{modelOptions.map((model) => (
						<DropdownMenuOptionItem
							key={modelOptionValue(model.provider, model.id)}
							value={modelOptionValue(model.provider, model.id)}
							icon={<ModelProviderIcon provider={model.provider} />}
							label={model.name || model.id}
							disabled={modelState.isSavingModel || chatIsSending}
							className="inno-composer-model-option"
						/>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuActionItem
					icon={<Settings2 size={14} />}
					label={t("chat.manageModels")}
					className="inno-composer-model-manage"
					onSelect={onOpenModelSettings}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);

	const sendDisabled = !hasSendableContent || isUploading;
	// Soft keyboards have no Shift+Enter, so touch users get an explicit
	// newline button (hidden on fine-pointer devices via pointer: coarse CSS).
	const insertNewline = () => {
		const el = inputRef.current;
		if (!el) return;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.setRangeText("\n", start, end, "end");
		// The textarea is uncontrolled; notify React's onInput chain (smart-input
		// mirror, autosize) about the programmatic edit.
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.focus({ preventScroll: true });
	};
	return (
		<div
			className={`inno-composer relative ${conversationMode ? "inno-composer--conversation" : ""}`}
			onDragOverCapture={handleComposerDragOver}
			onDragOver={handleComposerDragOver}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) setOsFileDragOver(false);
			}}
			onDropCapture={handleComposerDrop}
			onDrop={handleComposerDrop}
		>
			<div className={`inno-composer-card relative p-2 ${osFileDragOver ? "is-osfile-over" : ""}`}>
				{slashPalette}
				<input ref={fileInputRef} id="file-input" type="file" className="hidden" multiple onChange={onFiles} />
				<input ref={imageInputRef} id="image-input" type="file" className="hidden" multiple accept="image/*" onChange={onImageFiles} />
				{renderComposerAttachments()}
				<div className={`inno-smart-wrap ${smartInputEnabled ? "is-active" : ""}`}>
					{smartInputEnabled ? <div ref={mirrorRef} className="inno-smart-mirror" aria-hidden="true" /> : null}
					<textarea
						ref={inputRef}
						id="chat-input"
						defaultValue={defaultValue}
						className="inno-composer-textarea w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
						placeholder={placeholder}
						rows={2}
						onKeyDown={onKeyDown}
						onInput={onInput}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						onPaste={onPaste}
						disabled={chatIsSending || isUploading || hasPendingQuestion}
					/>
					{smartInputEnabled ? <div ref={hitRef} className="inno-smart-hit" /> : null}
				</div>
				<div className="inno-composer-toolbar flex shrink-0 items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						{renderAttachMenu()}
						<IconButton
							variant="ghost"
							size="md"
							shape="pill"
							className="inno-composer-action"
							title={modelState.currentModelSupportsNativeImages ? t("chat.attachImage") : t("chat.attachImageViaOcr")}
							aria-label={modelState.currentModelSupportsNativeImages ? t("chat.attachImage") : t("chat.attachImageViaOcr")}
							disabled={chatIsSending || isUploading}
							onClick={() => imageInputRef.current?.click()}
						>
							<Image size={16} />
						</IconButton>
						{conversationMode ? permissionControl : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<IconButton
							variant="ghost"
							size="md"
							shape="pill"
							className="inno-composer-newline inno-composer-action"
							title={t("chat.insertNewline")}
							aria-label={t("chat.insertNewline")}
							disabled={chatIsSending || isUploading || hasPendingQuestion}
							onClick={insertNewline}
						>
							<CornerDownLeft size={16} />
						</IconButton>
						{conversationMode ? contextUsageControl : null}
						{conversationMode ? renderModelPicker() : null}
						{(chatIsSending || jobStreaming) ? (
							<>
								{canReconnect && !jobStreaming ? (
									<IconButton
										variant="ghost"
										size="md"
										shape="pill"
										className="inno-composer-action"
										title={t("chat.reconnect", "重新连接")}
										aria-label={t("chat.reconnect", "重新连接")}
										onClick={onReconnect}
									>
										<RotateCcw size={16} />
									</IconButton>
								) : null}
								<IconButton
									variant="danger"
									size="md"
									shape="pill"
									className="inno-composer-stop text-white"
									title={t("chat.stopGeneration")}
									aria-label={t("chat.stopGeneration")}
									onClick={onStop}
								>
									<Square size={15} />
								</IconButton>
							</>
						) : (
							<IconButton
								variant="primary"
								size="sm"
								shape="pill"
								className={`inno-composer-send ${sendDisabled ? "is-disabled" : ""}`}
								title={t("chat.send")}
								aria-label={t("chat.send")}
								disabled={sendDisabled}
								onClick={onSend}
							>
								<ArrowUp size={16} strokeWidth={2} />
							</IconButton>
						)}
					</div>
				</div>
			</div>
			{conversationMode ? null : (
				<div className="inno-composer-subrow">
					{workspaceControl}
					{permissionControl}
					<span className="flex-1" aria-hidden="true" />
					{renderModelPicker()}
				</div>
			)}
		</div>
	);
}
