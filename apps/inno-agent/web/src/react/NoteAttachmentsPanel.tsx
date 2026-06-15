import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Loader2, Paperclip, Sparkles, Trash2, Upload } from "lucide-react";
import { deleteRawFile, l2RawUrl, listNoteAttachments, uploadNoteAttachment } from "../api/sources.js";
import { appStore } from "../stores/app-store.js";
import { notebookStore } from "../stores/notebook-store.js";
import type { NoteAttachment } from "../types/sources.js";

function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isPreviewable(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].some((ext) => lower.endsWith(ext));
}

function openWikiPage(path: string): void {
	appStore.setRightPanelTab("notebook");
	appStore.setWorkspaceMode("half");
	void notebookStore.selectPage(path);
}

export function NoteAttachmentsPanel({ noteRawPath }: { noteRawPath: string }) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isUploading, setIsUploading] = useState(false);
	const [deletingPath, setDeletingPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function reload() {
		setIsLoading(true);
		setError(null);
		try {
			setAttachments(await listNoteAttachments(noteRawPath));
		} catch {
			setAttachments([]);
			setError("load_failed");
		} finally {
			setIsLoading(false);
		}
	}

	useEffect(() => {
		void reload();
	}, [noteRawPath]);

	async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length === 0) return;
		setIsUploading(true);
		setError(null);
		try {
			const uploaded = await Promise.all(files.map((file) => uploadNoteAttachment(noteRawPath, file)));
			setAttachments((current) => {
				const map = new Map(current.map((item) => [item.rawPath, item]));
				for (const item of uploaded) map.set(item.rawPath, item);
				return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			});
		} catch {
			setError("upload_failed");
		} finally {
			setIsUploading(false);
		}
	}

	async function handleDelete(attachment: NoteAttachment) {
		if (!window.confirm(t("sources.note.confirmDeleteAttachment", { name: attachment.fileName }))) return;
		setDeletingPath(attachment.rawPath);
		setError(null);
		try {
			await deleteRawFile(attachment.rawPath);
			setAttachments((current) => current.filter((item) => item.rawPath !== attachment.rawPath));
		} catch {
			setError("delete_failed");
		} finally {
			setDeletingPath(null);
		}
	}

	return (
		<section className="border-t border-slate-200 bg-slate-50/60 p-4">
			<div className="mb-3 flex items-center justify-between gap-2">
				<h4 className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
					<Paperclip size={14} />
					{t("sources.note.attachments")}
				</h4>
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
					disabled={isUploading}
					onClick={() => fileInputRef.current?.click()}
				>
					{isUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
					{t("sources.note.uploadAttachment")}
				</button>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					accept=".pdf,.doc,.docx,.txt,.csv,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.zip"
					onChange={(event) => void handleUpload(event)}
				/>
			</div>
			{error ? <p className="mb-2 text-xs text-red-600">{t(`sources.note.attachmentsFlash.${error}`)}</p> : null}
			{isLoading ? (
				<div className="flex justify-center py-4">
					<Loader2 size={18} className="animate-spin text-slate-400" />
				</div>
			) : attachments.length === 0 ? (
				<p className="text-sm text-slate-500">{t("sources.note.attachmentsEmpty")}</p>
			) : (
				<div className="space-y-2">
					{attachments.map((attachment) => {
						const canPreview = isPreviewable(attachment.fileName);
						const isDeleting = deletingPath === attachment.rawPath;
						const wikiPage = attachment.wikiPages?.find((page) => page.path.includes("wiki/sources/")) ?? attachment.wikiPages?.[0];
						return (
							<div
								key={attachment.rawPath}
								className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
							>
								<Paperclip size={14} className="shrink-0 text-slate-400" />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<div className="truncate text-sm font-medium text-slate-950">{attachment.fileName}</div>
										{attachment.archived ? (
											<span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 ring-1 ring-emerald-100">
												<Sparkles size={10} />
												{t("sources.note.attachmentArchived")}
											</span>
										) : null}
									</div>
									<div className="text-xs text-slate-400">{formatSize(attachment.size)}</div>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{wikiPage ? (
										<button
											type="button"
											className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
											title={t("sources.note.viewNoteWiki")}
											onClick={() => openWikiPage(wikiPage.path)}
										>
											<Sparkles size={14} />
										</button>
									) : null}
									{canPreview ? (
										<a
											href={l2RawUrl(attachment.rawPath)}
											target="_blank"
											rel="noreferrer"
											className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
											title={t("sources.preview")}
										>
											<ExternalLink size={14} />
										</a>
									) : null}
									<a
										href={l2RawUrl(attachment.rawPath, { download: true })}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
										title={t("sources.download")}
									>
										<Download size={14} />
									</a>
									<button
										type="button"
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-50 disabled:opacity-50"
										disabled={isDeleting}
										title={t("common.delete")}
										onClick={() => void handleDelete(attachment)}
									>
										{isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
