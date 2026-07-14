import { Download, FileArchive, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { l2RawFileUrl } from "../../api/notes.js";
import type { NoteAttachment } from "../../types/notes.js";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentDate(value: string, language: "zh" | "en"): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString(language === "en" ? "en-US" : "zh-CN", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export interface NoteAttachmentsProps {
	attachments: NoteAttachment[];
	isUploading?: boolean;
	deletingAttachmentId?: string | null;
	readOnly?: boolean;
	onUpload: (files: FileList | File[]) => void | Promise<void>;
	onDelete: (attachmentId: string, fileName: string) => void | Promise<void>;
}

export function NoteAttachments({
	attachments,
	isUploading = false,
	deletingAttachmentId = null,
	readOnly = false,
	onUpload,
	onDelete,
}: NoteAttachmentsProps) {
	const { t, i18n } = useTranslation();
	const uiLanguage = i18n.language.startsWith("zh") ? "zh" : "en";
	const uploadRef = useRef<HTMLInputElement>(null);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	return (
		<section className="inno-note-attachments" aria-label={t("notes.attachments.heading")}>
			<div className="inno-note-attachments-head">
				<h3>{t("notes.attachments.heading")}</h3>
				{!readOnly ? (
					<>
						<button
							type="button"
							className="inno-note-attachments-upload"
							disabled={isUploading}
							onClick={() => uploadRef.current?.click()}
						>
							{isUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
							<span>{isUploading ? t("notes.attachments.uploading") : t("notes.attachments.upload")}</span>
						</button>
						<input
							ref={uploadRef}
							type="file"
							className="hidden"
							multiple
							onChange={(event) => {
								if (event.target.files?.length) {
									void onUpload(event.target.files);
									event.target.value = "";
								}
							}}
						/>
					</>
				) : null}
			</div>
			{attachments.length === 0 ? (
				<p className="inno-note-attachments-empty">{t("notes.attachments.empty")}</p>
			) : (
				<div className="inno-note-attachments-list">
					{attachments.map((attachment) => (
						<div key={attachment.id} className="inno-note-attachment-row">
							<span className="inno-note-attachment-icon" aria-hidden="true">
								{attachment.mimeType.includes("zip") || attachment.fileName.endsWith(".zip") ? (
									<FileArchive size={15} />
								) : (
									<Paperclip size={15} />
								)}
							</span>
							<span className="inno-note-attachment-copy">
								<strong>{attachment.fileName}</strong>
								<small>
									{formatFileSize(attachment.size)} · {formatAttachmentDate(attachment.createdAt, uiLanguage)}
								</small>
							</span>
							<div className="inno-note-attachment-actions">
								{!readOnly && confirmDeleteId === attachment.id ? (
									<span className="inno-note-attachment-delete-confirm">
										<span>{t("notes.attachments.confirmDelete")}</span>
										<button
											type="button"
											className="inno-note-attachment-action danger"
											disabled={deletingAttachmentId === attachment.id}
											onClick={() => {
												setConfirmDeleteId(null);
												void onDelete(attachment.id, attachment.fileName);
											}}
										>
											{deletingAttachmentId === attachment.id ? (
												<Loader2 size={14} className="animate-spin" />
											) : null}
											<span>{t("notes.attachments.confirm")}</span>
										</button>
										<button
											type="button"
											className="inno-note-attachment-action"
											onClick={() => setConfirmDeleteId(null)}
										>
											{t("notes.attachments.cancel")}
										</button>
									</span>
								) : (
									<>
										<a
											className="inno-note-attachment-action"
											href={l2RawFileUrl(attachment.filePath)}
											target="_blank"
											rel="noreferrer"
											title={t("notes.attachments.download")}
										>
											<Download size={14} />
											<span>{t("notes.attachments.download")}</span>
										</a>
										{!readOnly ? (
											<button
												type="button"
												className="inno-note-attachment-action danger"
												disabled={deletingAttachmentId === attachment.id}
												title={t("notes.attachments.delete")}
												onClick={() => setConfirmDeleteId(attachment.id)}
											>
												<Trash2 size={14} />
												<span>{t("notes.attachments.delete")}</span>
											</button>
										) : null}
									</>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
