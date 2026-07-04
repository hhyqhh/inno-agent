import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { renderAsync } from "docx-preview";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { triggerDownload } from "../../api/workspace.js";

/**
 * Render a .docx into an HTML container with formatting preserved, via
 * docx-preview (client-side, no LibreOffice). Options mirror pi-web-ui's
 * DocxArtifact for parity.
 */
export default function DocxPreview({ file }: { file: WorkspaceFileDetail }) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!file.url) {
			setError(t("preview.docxFailed", "Failed to render document"));
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError("");
		const container = containerRef.current;
		if (container) container.innerHTML = "";
		(async () => {
			try {
				const res = await fetch(file.url as string);
				if (!res.ok) throw new Error(res.statusText);
				const buf = await res.arrayBuffer();
				if (cancelled || !containerRef.current) return;
				await renderAsync(buf, containerRef.current, undefined, {
					className: "docx",
					inWrapper: true,
					ignoreWidth: true,
					ignoreHeight: false,
					ignoreFonts: false,
					breakPages: true,
					ignoreLastRenderedPageBreak: true,
					experimental: false,
					trimXmlDeclaration: true,
					useBase64URL: false,
					renderHeaders: true,
					renderFooters: true,
					renderFootnotes: true,
					renderEndnotes: true,
				});
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : t("preview.docxFailed", "Failed to render document"));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
	}, [file.url, t]);

	const downloadOriginal = () => {
		if (file.url) triggerDownload(`${file.url}${file.url.includes("?") ? "&" : "?"}download=1`);
	};

	return (
		<div className="workspace-scroll h-full overflow-auto bg-[var(--inno-surface-muted)]">
			{loading ? (
				<div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">
					{t("preview.docxLoading", "Rendering document...")}
				</div>
			) : null}
			{error ? (
				<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--inno-text-muted)]">
					<div className="font-medium text-[var(--inno-text)]">{file.name}</div>
					<div className="text-xs text-[var(--inno-danger)]">{error}</div>
					<button
						className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)]"
						onClick={downloadOriginal}
					>
						<Download size={12} />
						{t("files.download", "Download")}
					</button>
				</div>
			) : null}
			<div ref={containerRef} className={`docx-host px-4 py-4 ${loading || error ? "hidden" : ""}`} />
		</div>
	);
}
