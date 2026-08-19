import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingUpload } from "./composer-utils.js";

export function ChatUploadChips({ uploads, onRemove }: { uploads: PendingUpload[]; onRemove: (index: number) => void }) {
	const { t } = useTranslation();
	if (uploads.length === 0) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-1.5">
			{uploads.map((file, index) => (
				<span key={`${file.path}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-xs shadow-sm">
					<span className="max-w-[220px] truncate">{file.fileName}</span>
					<span className="text-[var(--inno-text-muted)]">{file.path}</span>
					<button
						type="button"
						className="text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
						title={t("chat.removeUpload")}
						onClick={() => onRemove(index)}
					>
						<X size={14} />
					</button>
				</span>
			))}
		</div>
	);
}
