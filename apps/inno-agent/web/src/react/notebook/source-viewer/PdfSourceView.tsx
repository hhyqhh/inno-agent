import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { EvidenceSliceResponse } from "../../../types/wiki.js";
import { sourceContentUrl } from "../../../api/wiki.js";
import { EvidenceTextView } from "./EvidenceTextView.js";
import { evidenceBlocksInDocumentOrder } from "./MarkdownSourceView.js";
import { preferredScrollBehavior } from "./text-highlight.js";
import {
	clearPdfTextHighlights,
	highlightPdfText,
	type PdfDomTextMatch,
} from "./pdf-text-layer.js";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfSourceViewProps {
	sourceId: string;
	sourceRevision: string;
	page?: number;
	evidence?: EvidenceSliceResponse;
	quote?: string;
	occurrence?: number;
	/** Keep the page visible but use the extracted slice when the resolver did not trust the quote. */
	forceExtractedFallback?: boolean;
}

type PreviewState = "loading" | "ready" | "fallback" | "error";

const DEFAULT_SCALE = 1.25;

function fallbackMessage(match: PdfDomTextMatch | "empty" | "forced" | "error", hasEvidence: boolean, t: TFunction, detail?: string): string {
	const suffix = hasEvidence ? t("notebook.page.sourceViewer.pdf.showExtracted") : t("notebook.page.sourceViewer.pdf.pageVisible");
	if (match === "forced") return `${t("notebook.page.sourceViewer.pdf.forced")}${suffix}`;
	if (match === "error") {
		const base = t("notebook.page.sourceViewer.pdf.error", { detail: detail ? `: ${detail}` : "" });
		return `${base}${hasEvidence ? t("notebook.page.sourceViewer.pdf.showExtracted") : t("notebook.page.sourceViewer.pdf.downloadInspect")}`;
	}
	if (match === "empty") return `${t("notebook.page.sourceViewer.pdf.empty")}${suffix}`;
	if (match.status === "ambiguous") return `${t("notebook.page.sourceViewer.pdf.ambiguous")}${suffix}`;
	if (match.status === "none") return `${t("notebook.page.sourceViewer.pdf.none")}${suffix}`;
	return `${t("notebook.page.sourceViewer.pdf.unavailable")}${suffix}`;
}

function setScaleFactor(element: HTMLElement, scale: number): void {
	element.style.setProperty("--scale-factor", String(scale));
}

function destroyQuietly(value: unknown): void {
	try {
		const result = (value as { destroy?: () => unknown } | undefined)?.destroy?.();
		if (result && typeof (result as Promise<unknown>).catch === "function") void (result as Promise<unknown>).catch(() => undefined);
	} catch {
		// Cleanup must not mask the original render error.
	}
}

export function PdfSourceView({ sourceId, sourceRevision, page = 1, evidence, quote, occurrence, forceExtractedFallback = false }: PdfSourceViewProps) {
	const { t } = useTranslation();
	const pageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textLayerRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<PreviewState>("loading");
	const [fallbackReason, setFallbackReason] = useState<string>();

	useEffect(() => {
		const controller = new AbortController();
		const pageHost = pageRef.current;
		const canvas = canvasRef.current;
		const textLayerHost = textLayerRef.current;
		let loadingTask: ReturnType<typeof getDocument> | undefined;
		let pdf: PDFDocumentProxy | undefined;
		let renderTask: { promise: Promise<unknown>; cancel?: () => void } | undefined;
		let textLayer: { render(): Promise<unknown>; cancel?: () => void } | undefined;

		setState("loading");
		setFallbackReason(undefined);
		if (!pageHost || !canvas || !textLayerHost) return () => controller.abort();
		pageHost.replaceChildren(canvas, textLayerHost);
		textLayerHost.replaceChildren();

		const requestedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
		const loadingOptions = {
			url: sourceContentUrl(sourceId),
			httpHeaders: { "If-Match": `"${sourceRevision}"` },
			disableRange: false,
			disableStream: true,
			disableAutoFetch: true,
			rangeChunkSize: 64 * 1024,
		};

		void (async () => {
			try {
				loadingTask = getDocument(loadingOptions);
				pdf = await loadingTask.promise;
				if (controller.signal.aborted) return;
				const pageNumber = Math.min(requestedPage, Math.max(1, pdf.numPages || requestedPage));
				const loadedPage = await pdf.getPage(pageNumber);
				if (controller.signal.aborted) return;

				const viewport = loadedPage.getViewport({ scale: DEFAULT_SCALE });
				pageHost.dataset.pdfPage = String(pageNumber);
				pageHost.dataset.pageNumber = String(pageNumber);
				pageHost.style.width = `${viewport.width}px`;
				pageHost.style.height = `${viewport.height}px`;
				setScaleFactor(pageHost, viewport.scale ?? DEFAULT_SCALE);
				canvas.width = Math.ceil(viewport.width);
				canvas.height = Math.ceil(viewport.height);
				canvas.style.width = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;
				const context = canvas.getContext("2d", { alpha: false });
				if (!context) throw new Error("Canvas rendering is unavailable");
				renderTask = loadedPage.render({ canvasContext: context, viewport });

				const textContent = await loadedPage.getTextContent();
				if (controller.signal.aborted) return;
				textLayer = new TextLayer({
					textContentSource: textContent,
					container: textLayerHost,
					viewport,
				});
				await Promise.all([renderTask.promise, textLayer.render()]);
				if (controller.signal.aborted) return;

				if (forceExtractedFallback) {
					setFallbackReason(fallbackMessage("forced", evidence !== undefined, t));
					setState("fallback");
				} else if (quote) {
					const match = highlightPdfText(textLayerHost, quote, occurrence);
					if (match.status === "unique") {
						match.marks?.[0]?.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
						setState("ready");
					} else {
						setFallbackReason(fallbackMessage(match, evidence !== undefined, t));
						setState("fallback");
					}
				} else if (textLayerHost.textContent?.trim()) {
					setState("ready");
				} else {
					setFallbackReason(fallbackMessage("empty", evidence !== undefined, t));
					setState("fallback");
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				setFallbackReason(fallbackMessage("error", evidence !== undefined, t, error instanceof Error ? error.message : undefined));
				setState("error");
			}
		})();

		return () => {
			controller.abort();
			try { renderTask?.cancel?.(); } catch { /* best effort */ }
			try { textLayer?.cancel?.(); } catch { /* best effort */ }
			clearPdfTextHighlights(textLayerHost);
			textLayerHost.replaceChildren();
			canvas.width = 0;
			canvas.height = 0;
			try { pdf?.cleanup?.(); } catch { /* best effort */ }
			destroyQuietly(pdf);
			destroyQuietly(loadingTask);
		};
	}, [page, sourceId, sourceRevision, quote, occurrence, forceExtractedFallback, evidence, t]);

	const showExtracted = (state === "fallback" || state === "error") && evidence !== undefined;
	return (
		<div data-pdf-source-view className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--inno-surface-muted)]">
			<div className="flex min-h-0 flex-1 justify-center overflow-auto p-4">
				<div
					ref={pageRef}
					data-pdf-page={String(Math.max(1, Math.floor(page)))}
					className="relative shrink-0 bg-white shadow-sm"
				>
					<canvas ref={canvasRef} aria-label={t("notebook.page.sourceViewer.pdf.pageAria", { page: Math.max(1, Math.floor(page)) })} />
					<div ref={textLayerRef} className="textLayer" aria-hidden="true" />
				</div>
			</div>
			{state === "loading" ? (
				<div role="status" className="border-t border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2 text-xs text-[var(--inno-text-muted)]">
					{t("notebook.page.sourceViewer.pdf.rendering")}
				</div>
			) : null}
			{fallbackReason ? (
				<div role="alert" className="border-t border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
					{fallbackReason}
				</div>
			) : null}
			{showExtracted ? (
				<div className="border-t border-[var(--inno-border)] bg-[var(--inno-surface)]">
					<EvidenceTextView
						blocks={evidenceBlocksInDocumentOrder(evidence)}
						targetBlockId={evidence.target.id}
						quote={quote}
						occurrence={occurrence}
					/>
				</div>
			) : null}
		</div>
	);
}
