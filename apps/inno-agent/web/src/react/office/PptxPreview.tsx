import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import type { PptxPreviewResult, PptxSlide, WorkspaceFileDetail } from "../../types/workspace.js";
import { triggerDownload } from "../../api/workspace.js";
import { Spinner } from "../ui/Spinner.js";

/**
 * Render a .pptx as a vertical stack of slide SVGs, produced by the backend
 * Python converter (no LibreOffice). SVGs are shape-only with base64-embedded
 * images, so they inject safely into a plain container.
 */
export default function PptxPreview({ file }: { file: WorkspaceFileDetail }) {
	const { t } = useTranslation();
	const [slides, setSlides] = useState<PptxSlide[]>([]);
	const [aspect, setAspect] = useState<number>(16 / 9);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!file.previewUrl) {
			setError(t("preview.pptxFailed", "Failed to render presentation"));
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError("");
		setSlides([]);
		fetch(file.previewUrl)
			.then(async (res) => {
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error((body as { error?: string }).error || res.statusText);
				}
				return res.json() as Promise<PptxPreviewResult>;
			})
			.then((res) => {
				if (cancelled) return;
				setSlides(res.slides);
				if (res.canvasPx && res.canvasPx[1] > 0) setAspect(res.canvasPx[0] / res.canvasPx[1]);
			})
			.catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t("preview.pptxFailed", "Failed to render presentation")); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [file.previewUrl, t]);

	const downloadOriginal = () => {
		if (file.url) triggerDownload(`${file.url}${file.url.includes("?") ? "&" : "?"}download=1`);
	};

	if (loading) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--inno-text-muted)]">
				<Spinner size={16} />
				{t("preview.pptxLoading", "Rendering slides...")}
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--inno-text-muted)]">
				<div className="font-medium text-[var(--inno-text)]">{file.name}</div>
				<div className="text-xs text-[var(--inno-danger)]">{error}</div>
				<button className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)]" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
		);
	}

	return (
		<div className="workspace-scroll h-full overflow-auto bg-[var(--inno-surface-muted)] p-4">
			<div className="mb-3 flex items-center justify-between gap-2">
				<div className="text-xs text-[var(--inno-text-muted)]">
					{t("preview.pptxCount", "{{count}} slides", { count: slides.length })}
				</div>
				<button className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
			<div className="mx-auto flex max-w-4xl flex-col gap-4">
				{slides.map((slide) => (
					<div key={slide.index} className="overflow-hidden rounded-lg border border-[var(--inno-border)] bg-white shadow-sm">
						<div className="flex items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1">
							<span className="text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
								{t("preview.pptxSlide", "Slide {{n}}", { n: slide.index })}
							</span>
						</div>
						<div
							className="pptx-slide w-full"
							style={{ aspectRatio: String(aspect) }}
							dangerouslySetInnerHTML={{ __html: slide.svg }}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
