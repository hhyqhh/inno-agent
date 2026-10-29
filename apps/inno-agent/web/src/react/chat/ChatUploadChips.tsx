import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingUpload } from "./composer-utils.js";
import type { SmartInputRule } from "../../types/settings.js";
import { anyActiveRuleMatches, kindFromName } from "./smart-input/kinds.js";
import {
	ContextMenu,
	type ContextMenuItem,
	Tooltip,
} from "../ui/index.js";
import { buildDragFilePanel, hiddenDragImage } from "./smart-input/drag-utils.js";
import { workspaceFileUrl } from "../../api/workspace.js";
import { FileName } from "../FileName.js";
import { FileTypeIcon } from "../FileTypeIcon.js";

export interface ChatUploadChipsProps {
	uploads: PendingUpload[];
	onRemove: (index: number) => void;
	/** Re-arm a failed local upload so the next send retries it. */
	onRetry?: (index: number) => void;
	/** Present when smart input is on: right-click "insert as bubble". */
	onInsertAsBubble?: (path: string) => void;
	/** Smart-input rules used to gate "insert as bubble" on the file's format. */
	rules?: SmartInputRule[];
	/** Workspace context used to resolve previews for existing image files. */
	workspaceId?: string;
	/** Open a workspace file in the app's preview panel (click on chip). */
	onOpenWorkspaceFile?: (path: string) => void;
}

function AttachmentImagePreview({ item, workspaceId }: { item: PendingUpload; workspaceId?: string }) {
	const [localUrl, setLocalUrl] = useState<string | null>(null);

	useEffect(() => {
		if (item.source !== "local" || !item.file) {
			setLocalUrl(null);
			return;
		}
		const url = URL.createObjectURL(item.file);
		setLocalUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [item.file, item.source]);

	const src = localUrl ?? (item.source === "workspace" ? workspaceFileUrl(item.path, workspaceId) : null);
	if (!src) return null;
	return (
		<>
			<span className="inno-upload-image-thumb" aria-hidden="true">
				<img src={src} alt="" decoding="async" />
			</span>
			<span className="inno-upload-image-preview" aria-hidden="true">
				<img src={src} alt="" loading="lazy" decoding="async" />
			</span>
		</>
	);
}

function createUploadDragImage(item: PendingUpload): HTMLElement {
	// Same shared panel the smart-input follower uses, so drags look identical
	// whether or not smart input is enabled.
	return buildDragFilePanel([{ name: item.fileName }], true);
}

/**
 * Composer attachment row: workspace files attach instantly ("工作区" tag),
 * local files stay local until send time and are then placed in the workspace
 * selected for that send. Chips are draggable onto keyword bubbles and expose
 * a right-click menu when smart input is enabled.
 */
export function ChatUploadChips({ uploads, onRemove, onRetry, onInsertAsBubble, rules, workspaceId, onOpenWorkspaceFile }: ChatUploadChipsProps) {
	const { t } = useTranslation();
	const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
	const [draggingId, setDraggingId] = useState<number | null>(null);

	// A drag can remove its source chip before the source element receives
	// dragend (for example when dropping onto a smart-input bubble). Always
	// clear the visual drag state from the window-level lifecycle as well.
	useEffect(() => {
		const clearDragging = () => setDraggingId(null);
		window.addEventListener("dragend", clearDragging, true);
		window.addEventListener("drop", clearDragging, true);
		window.addEventListener("inno-smart-dragend", clearDragging);
		return () => {
			window.removeEventListener("dragend", clearDragging, true);
			window.removeEventListener("drop", clearDragging, true);
			window.removeEventListener("inno-smart-dragend", clearDragging);
		};
	}, []);

	// If the dragged source was unmounted, no event is guaranteed to reach the
	// old element. Stable ids prevent another item from inheriting its opacity;
	// this effect also releases the stale state for the next drag.
	useEffect(() => {
		if (draggingId !== null && !uploads.some((file) => file.id === draggingId)) setDraggingId(null);
	}, [draggingId, uploads]);

	if (uploads.length === 0) return null;

	/**
	 * Click on a chip: local files open with the OS default handler (Electron
	 * shell), workspace files open in the app preview panel. Inner buttons
	 * (remove/retry) handle their own clicks.
	 */
	const openUpload = (item: PendingUpload) => {
		if (item.source === "workspace") {
			onOpenWorkspaceFile?.(item.path);
			return;
		}
		if (item.file && window.innoDesktop?.openLocalFile) {
			void window.innoDesktop.openLocalFile(item.file);
			return;
		}
		// Browser fallback: preview the picked file in a new tab.
		if (item.file) {
			const url = URL.createObjectURL(item.file);
			window.open(url, "_blank", "noopener");
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		}
	};

	const startPageDrag = (item: PendingUpload) => {
		const detail = { name: item.fileName, path: item.path, source: item.source, file: item.file };
		window.dispatchEvent(new CustomEvent("inno-smart-dragstart", { detail }));
	};
	const activeUpload = menu ? uploads[menu.index] : undefined;
	const canInsertAsBubble = Boolean(activeUpload && onInsertAsBubble && rules && anyActiveRuleMatches(activeUpload.fileName, rules));
	const menuItems: ContextMenuItem[] = activeUpload ? [
		...(canInsertAsBubble ? [{
			label: t("chat.smartInput.insertAsBubble", "插入为气泡"),
			onSelect: () => onInsertAsBubble?.(activeUpload.path),
		}] : []),
		{
			label: t("chat.smartInput.removeAttachment", "移除附件"),
			danger: true,
			onSelect: () => onRemove(menu!.index),
		},
	] : [];

	return (
		<div className="flex flex-wrap gap-1.5">
			{uploads.map((file, index) => {
				const kind = kindFromName(file.fileName);
				const failed = file.status === "failed";
				return (
					<span
						key={file.id}
						draggable
						onDragStart={(event) => {
							const dragImage = createUploadDragImage(file);
							setDraggingId(file.id);
							event.dataTransfer.setData("application/x-inno-file", JSON.stringify({ name: file.fileName, path: file.path, source: file.source }));
							event.dataTransfer.setData("text/plain", `ws:${file.path}`);
							event.dataTransfer.effectAllowed = "copy";
							startPageDrag(file);
							// Smart input renders its own live follower (file panel +
							// drop status); hide the native snapshot so only one panel shows.
							if (document.body.classList.contains("inno-smart-dragging")) {
								event.dataTransfer.setDragImage(hiddenDragImage(), 0, 0);
							} else {
								// Keep the preview above the pointer so it does not cover the
								// attachment row or the smart-input drop feedback.
								event.dataTransfer.setDragImage(dragImage, dragImage.offsetWidth / 2, dragImage.offsetHeight + 2);
							}
							window.setTimeout(() => dragImage.remove(), 0);
						}}
							onDragEnd={() => {
								setDraggingId(null);
							window.dispatchEvent(new CustomEvent("inno-smart-dragend"));
						}}
						onContextMenu={(event) => {
							if (!onInsertAsBubble) return;
							event.preventDefault();
							setMenu({ x: event.clientX, y: event.clientY, index });
						}}
						onClick={(event) => {
							if ((event.target as HTMLElement).closest("button")) return;
							openUpload(file);
						}}
						className={`inno-upload-chip inline-flex items-center gap-1.5 rounded-xl border px-2 py-1 text-xs shadow-sm cursor-grab ${
							draggingId === file.id ? "is-dragging" : ""
						} ${
							kind === "image" ? "inno-upload-image-card" : ""
						} ${
							failed
								? "border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)]"
								: "border-[var(--inno-border)] bg-[var(--inno-surface-muted)]"
						}`}
					>
						{kind === "image" ? (
							<AttachmentImagePreview item={file} workspaceId={workspaceId} />
						) : (
							<FileTypeIcon kind={kind} size={14} />
						)}
						<FileName name={file.fileName} className="min-w-0 max-w-[220px] flex-1 text-[var(--inno-text)]" />
						{file.source === "workspace" ? (
							<span className="text-[10px] text-[var(--inno-text-subtle)]">{t("chat.smartInput.sourceWorkspace", "工作区")}</span>
						) : failed ? (
							<span className="flex items-center gap-0.5">
								<span className="text-[10px] text-[var(--inno-danger)]">{t("chat.smartInput.uploadFailed", "失败")}</span>
								{onRetry ? (
									<Tooltip label={t("chat.smartInput.retryUpload", "重试上传（随下次发送）")}>
										<button
											type="button"
											className="inno-smart-retry-btn"
											onClick={() => onRetry(index)}
										>
											<RotateCcw size={12} />
										</button>
									</Tooltip>
								) : null}
							</span>
						) : (
							<span className="text-[10px] text-[var(--inno-text-subtle)]">{t("chat.smartInput.sourceUpload", "本地")}</span>
						)}
						<Tooltip label={t("chat.removeUpload")}>
							<button
								type="button"
								className="text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
								onClick={() => onRemove(index)}
							>
								<X size={14} />
							</button>
						</Tooltip>
					</span>
				);
			})}
			{menu && activeUpload ? createPortal(
				<ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
				document.body,
			) : null}
		</div>
	);
}
