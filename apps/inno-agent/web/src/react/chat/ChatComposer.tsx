import { useEffect, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Paperclip, X, ArrowUp, Square, RotateCcw, Image, FileText, Check, ChevronDown, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../ui/Spinner.js";
import type { InnoModelInfo } from "../../types/settings.js";
import type { PreparedInlineImage, PendingPasteBlock } from "./composer-utils.js";
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
	modelState: ChatComposerModelState;
	modelOptions: InnoModelInfo[];
	currentModel?: InnoModelInfo;
	modelPickerOpen: boolean;
	chatIsSending: boolean;
	canReconnect: boolean;
	lastUserPrompt: string | null;
	isUploading: boolean;
	hasSendableContent: boolean;
	hasPendingQuestion: boolean;
	onInput: () => void;
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
	onSend: () => void;
	onStop: () => void;
	onReconnect: () => void;
	onRetry: () => void;
}

export function ChatComposer({
	inputRef,
	fileInputRef,
	imageInputRef,
	placeholder,
	defaultValue,
	inlineImages,
	pasteBlocks,
	modelState,
	modelOptions,
	currentModel,
	modelPickerOpen,
	chatIsSending,
	canReconnect,
	lastUserPrompt,
	isUploading,
	hasSendableContent,
	hasPendingQuestion,
	onInput,
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
	onSend,
	onStop,
	onReconnect,
	onRetry,
}: ChatComposerProps) {
	const { t } = useTranslation();
	const modelPickerRef = useRef<HTMLDivElement | null>(null);
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

	const renderInlineImagePreviews = () => (
		inlineImages.length > 0 ? (
			<div className="flex flex-wrap gap-1.5">
				{inlineImages.map((img, index) => (
					<span key={`${img.name}-${index}`} className="relative inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-1 shadow-sm">
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
		const preview = block.text.split(/\r\n|\r|\n/)[0].trim() || t("common.pasteCardTitle");
		return (
			<div key={block.id} className="inno-paste-card" role="group" aria-label={t("common.pasteCardTitle")}>
				<span className="inno-paste-card-icon" aria-hidden="true">
					<FileText size={16} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs text-[var(--inno-text)]" title={preview}>{preview}</div>
					<div className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--inno-text-muted)]">
						<button type="button" className="inno-paste-card-action" onClick={() => onShowPasteInTextField(block.id)}>
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
					onClick={() => onRemovePasteBlock(block.id)}
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
				{pasteBlocks.map(renderPasteBlock)}
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
				disabled={modelOptions.length === 0 || modelState.isSavingModel || chatIsSending}
				onClick={onToggleModelPicker}
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
		<div className="inno-composer rounded-2xl p-2">
			<input ref={fileInputRef} id="file-input" type="file" className="hidden" multiple onChange={onFiles} />
			<input ref={imageInputRef} id="image-input" type="file" className="hidden" multiple accept="image/*" onChange={onImageFiles} />
			{renderComposerAttachments()}
			<textarea
				ref={inputRef}
				id="chat-input"
				defaultValue={defaultValue}
				className="inno-composer-textarea w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
				placeholder={placeholder}
				rows={2}
				onKeyDown={onKeyDown}
				onInput={onInput}
				onPaste={onPaste}
				disabled={chatIsSending || isUploading || hasPendingQuestion}
			/>
			<div className="inno-composer-toolbar flex shrink-0 items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1">
					<button
						type="button"
						className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
						title={t("chat.uploadFiles")}
						disabled={chatIsSending || isUploading}
						onClick={() => fileInputRef.current?.click()}
					>
						{isUploading ? <Spinner size={16} /> : <Paperclip size={16} />}
					</button>
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
				{renderModelPicker()}
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
							{lastUserPrompt ? (
								<button
									type="button"
									className="inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
									title={t("chat.retryLast")}
									disabled={isUploading}
									onClick={onRetry}
								>
									<RotateCcw size={16} />
								</button>
							) : null}
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
