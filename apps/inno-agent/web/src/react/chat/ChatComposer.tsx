import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type CompositionEvent as ReactCompositionEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Paperclip, X, ArrowUp, Square, RotateCcw, Image, ScrollText, Check, ChevronDown, ChevronUp, Settings2, HardDriveUpload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../ui/Spinner.js";
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
	smartInputControl?: ReactNode;
	modelPickerOpen: boolean;
	attachMenuOpen: boolean;
	workspaceFiles: Array<{ name: string; path: string }>;
	smartInputEnabled: boolean;
	mirrorRef: RefObject<HTMLDivElement | null>;
	hitRef: RefObject<HTMLDivElement | null>;
	chatIsSending: boolean;
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
	smartInputControl,
	modelPickerOpen,
	attachMenuOpen,
	workspaceFiles,
	smartInputEnabled,
	mirrorRef,
	hitRef,
	chatIsSending,
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
	const { t } = useTranslation();
	const modelPickerRef = useRef<HTMLDivElement | null>(null);
	const attachTriggerRef = useRef<HTMLDivElement | null>(null);
	const attachMenuRef = useRef<HTMLDivElement | null>(null);
	const [attachMenuPosition, setAttachMenuPosition] = useState({ left: 8, top: 8 });
	const [osFileDragOver, setOsFileDragOver] = useState(false);
	const currentModelLabel = currentModel?.name || currentModel?.id || modelState.defaultModel || t("chat.modelUnavailable");

	useEffect(() => {
		if (!modelPickerOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!modelPickerRef.current?.contains(event.target as Node)) onCloseModelPicker();
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseModelPicker();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [modelPickerOpen, onCloseModelPicker]);

	useEffect(() => {
		if (!attachMenuOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (attachTriggerRef.current?.contains(target) || attachMenuRef.current?.contains(target)) return;
			onCloseAttachMenu();
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseAttachMenu();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [attachMenuOpen, onCloseAttachMenu]);

	const repositionAttachMenu = useCallback(() => {
		const trigger = attachTriggerRef.current;
		const menu = attachMenuRef.current;
		if (!trigger || !menu) return;
		const triggerRect = trigger.getBoundingClientRect();
		// getBoundingClientRect() includes the opening transform animation. Using
		// it here makes the first scroll remeasure a different size and nudges the
		// fixed menu. offset* reports the stable layout box instead.
		const width = menu.offsetWidth || Math.min(220, Math.max(0, window.innerWidth - 16));
		const height = menu.offsetHeight || 264;
		const maxLeft = Math.max(8, window.innerWidth - width - 8);
		const maxTop = Math.max(8, window.innerHeight - height - 8);
		const left = Math.max(8, Math.min(triggerRect.right - width, maxLeft));
		const top = Math.max(8, Math.min(triggerRect.top - height - 8, maxTop));
		setAttachMenuPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
	}, []);

	useLayoutEffect(() => {
		if (!attachMenuOpen) return;
		const handleScroll = (event: Event) => {
			// Scrolling the portaled menu does not move its fixed anchor. Avoid a
			// synchronous layout read on every wheel/trackpad event in that menu.
			if (event.target instanceof Node && attachMenuRef.current?.contains(event.target)) return;
			repositionAttachMenu();
		};
		repositionAttachMenu();
		window.addEventListener("resize", repositionAttachMenu);
		document.addEventListener("scroll", handleScroll, true);
		return () => {
			window.removeEventListener("resize", repositionAttachMenu);
			document.removeEventListener("scroll", handleScroll, true);
		};
	}, [attachMenuOpen, repositionAttachMenu, workspaceFiles.length]);

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
						<button
							type="button"
							className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] shadow-sm hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)]"
							title={t("chat.removeImage")}
							onClick={() => onRemoveInlineImage(index)}
						>
							<X size={12} />
						</button>
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
				<div className="inno-paste-card-copy" title={compactText}>
					<span className="inno-paste-card-preview">{preview}{hasMoreText ? "…" : ""}</span>
					<span className="inno-paste-card-count">· {t("common.pasteCardCharCount", "{{count}} 字", { count: block.text.length })}</span>
				</div>
				<button
					type="button"
					className="inno-paste-card-remove"
					title={t("common.pasteCardRemove")}
					aria-label={t("common.pasteCardRemove")}
					onClick={(event) => {
						event.stopPropagation();
						onRemovePasteBlock(block.id);
					}}
				>
					<X size={12} />
				</button>
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
		<div ref={attachTriggerRef} className="inno-composer-model-picker relative shrink-0">
			<button
				type="button"
				className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
				title={t("chat.uploadFiles")}
				disabled={chatIsSending || isUploading}
				aria-haspopup="menu"
				aria-expanded={attachMenuOpen}
				onClick={onToggleAttachMenu}
			>
				{isUploading ? <Spinner size={16} /> : <Paperclip size={16} />}
			</button>
			{attachMenuOpen && typeof document !== "undefined" ? createPortal(
				<div
					ref={attachMenuRef}
					className="inno-composer-model-menu inno-smart-attach-menu"
					role="menu"
					aria-label={t("chat.uploadFiles")}
					style={{ position: "fixed", left: attachMenuPosition.left, top: attachMenuPosition.top, right: "auto", bottom: "auto", zIndex: 100 }}
				>
					<button
						type="button"
						role="menuitem"
						className="inno-composer-model-option"
						onClick={() => {
							onCloseAttachMenu();
							fileInputRef.current?.click();
						}}
					>
						<span className="flex min-w-0 items-center gap-2">
							<HardDriveUpload size={14} className="shrink-0 text-[var(--inno-text-muted)]" />
							<span className="truncate">{t("chat.smartInput.attachFromThisDevice", "本机文件…")}</span>
						</span>
					</button>
					{workspaceFiles.length > 0 ? (
						<div className="inno-smart-attach-menu-caption">{t("chat.smartInput.attachFromWorkspace", "从工作区添加")}</div>
					) : (
						<div className="inno-smart-attach-menu-caption">{t("chat.smartInput.workspaceEmpty", "工作区暂无文件")}</div>
					)}
					{workspaceFiles.map((file) => (
						<button
							key={file.path}
							type="button"
							role="menuitem"
							className="inno-composer-model-option"
							title={file.path}
							onClick={() => {
								onCloseAttachMenu();
								onPickWorkspaceFiles([file.path]);
							}}
						>
							<span className="flex min-w-0 items-center gap-2">
								<FileTypeIcon kind={kindFromName(file.name)} size={14} />
								<FileName name={file.name} className="min-w-0 flex-1" />
							</span>
						</button>
					))}
				</div>,
				document.body,
			) : null}
		</div>
	);

	const renderModelPicker = () => (
		<div ref={modelPickerRef} className="inno-composer-model-picker relative shrink-0">
			<button
				type="button"
				className="inno-composer-model-trigger flex h-8 shrink-0 items-center gap-1 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
				title={t("chat.selectModel")}
				aria-label={t("chat.selectModel")}
				aria-haspopup="menu"
				aria-expanded={modelPickerOpen}
				disabled={modelOptions.length === 0 || modelState.isSavingModel || chatIsSending}
				onClick={onToggleModelPicker}
			>
				{modelState.defaultProvider ? <ModelProviderIcon provider={currentModel?.provider ?? modelState.defaultProvider} /> : null}
				<span className="whitespace-nowrap">{currentModelLabel}</span>
				{modelPickerOpen ? <ChevronUp size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
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
								disabled={modelState.isSavingModel || chatIsSending}
								onClick={() => onModelSelect(model)}
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
						<button type="button" className="inno-composer-model-manage" role="menuitem" onClick={onOpenModelSettings}>
							<Settings2 size={14} />
							<span>{t("chat.manageModels")}</span>
						</button>
					</div>
				</div>
			) : null}
		</div>
	);

	const sendDisabled = !hasSendableContent || isUploading;
	return (
		<div
			className={`inno-composer relative rounded-2xl p-2 ${osFileDragOver ? "is-osfile-over" : ""}`}
			onDragOverCapture={handleComposerDragOver}
			onDragOver={handleComposerDragOver}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) setOsFileDragOver(false);
			}}
			onDropCapture={handleComposerDrop}
			onDrop={handleComposerDrop}
		>
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
				<div className="flex min-w-0 items-center gap-1">
					{renderAttachMenu()}
					<button
						type="button"
						className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
						title={modelState.currentModelSupportsNativeImages ? t("chat.attachImage") : t("chat.attachImageViaOcr")}
						disabled={chatIsSending || isUploading}
						onClick={() => imageInputRef.current?.click()}
					>
						<Image size={16} />
					</button>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{smartInputControl}
					{renderModelPicker()}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{chatIsSending ? (
						<>
							{canReconnect ? (
								<button
									type="button"
									className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full"
									title={t("chat.reconnect", "重新连接")}
									onClick={onReconnect}
								>
									<RotateCcw size={16} />
								</button>
							) : null}
							<button
								type="button"
								className="inno-composer-stop flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-opacity hover:opacity-90 active:scale-[0.97]"
								title={t("chat.stopGeneration")}
								onClick={onStop}
							>
								<Square size={15} />
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								className={`inno-composer-send flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${sendDisabled ? "is-disabled" : ""}`}
								title={t("chat.send")}
								disabled={sendDisabled}
								onClick={onSend}
							>
								<ArrowUp size={16} strokeWidth={2} />
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
