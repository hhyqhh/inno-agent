import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, ListTree, Maximize, Minus, Plus, RotateCcw } from "lucide-react";
// The core initializes pdfjsLib before the viewer module is evaluated.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button, IconButton, Input, Spinner } from "../ui/index.js";
import PdfNavigation, { type PdfOutlineItem } from "./PdfNavigation.js";
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf-preview.css";

GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF.js owns page virtualization, selectable text and fixed paper geometry. */
export default function PdfPreview({ url, name }: { url: string; name: string }) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const pagesRef = useRef<HTMLDivElement>(null);
	const viewerRef = useRef<PDFViewer | null>(null);
	const linkRef = useRef<PDFLinkService | null>(null);
	const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
	const [outline, setOutline] = useState<PdfOutlineItem[] | null>(null);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);
	const [page, setPage] = useState(1);
	const [pageInput, setPageInput] = useState("1");
	const [pageCount, setPageCount] = useState(0);
	const [scale, setScale] = useState(1);
	const [fitWidth, setFitWidth] = useState(true);

	useEffect(() => {
		let disposed = false;
		setReady(false);
		setFailed(false);
		setPage(1);
		setPageInput("1");
		setPageCount(0);
		setFitWidth(true);
		setPdfDocument(null);
		setOutline(null);
		const eventBus = new EventBus();
		const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer" });
		const viewer = new PDFViewer({ container: containerRef.current!, viewer: pagesRef.current!, eventBus, linkService });
		viewerRef.current = viewer;
		linkRef.current = linkService;
		linkService.setViewer(viewer);
		const initialized = () => {
			if (disposed) return;
			viewer.currentScaleValue = "page-width";
			setPageCount(viewer.pagesCount);
			setReady(true);
		};
		const pageChanged = ({ pageNumber }: { pageNumber: number }) => {
			if (disposed) return;
			setPage(pageNumber);
			setPageInput(String(pageNumber));
		};
		const scaleChanged = ({ scale: nextScale, presetValue }: { scale: number; presetValue?: string }) => {
			if (disposed) return;
			setScale(nextScale);
			setFitWidth(presetValue === "page-width");
		};
		const renderFailed = ({ error }: { error?: unknown }) => { if (error && !disposed) setFailed(true); };
		eventBus.on("pagesinit", initialized);
		eventBus.on("pagechanging", pageChanged);
		eventBus.on("scalechanging", scaleChanged);
		eventBus.on("pagerendered", renderFailed);
		let lastWidth = 0;
		let refreshTimer = 0;
		const refreshViewer = () => {
			refreshTimer = 0;
			// Recompute fit-width when the split pane changes, preserving explicit zoom.
			if (viewer.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
			viewer.update();
		};
		const resize = new ResizeObserver((entries) => {
			// Page re-rasters change the height at constant width; only real width
			// deltas need a fit pass.
			const entry = entries?.[entries.length - 1];
			const width = entry?.contentRect.width ?? containerRef.current?.clientWidth ?? 0;
			if (entry && Math.abs(width - lastWidth) < 0.5) return;
			lastWidth = width;
			// During a splitter drag the panel width changes every frame; re-rastering
			// visible pages at that rate starves the main thread. Refresh periodically
			// mid-drag instead; on release the dragging body class is already gone,
			// so the final resize delivery snaps the viewer to the committed width.
			if (document.body.classList.contains("workspace-resizing") || document.body.classList.contains("inno-ui-resizing-columns")) {
				if (refreshTimer === 0) refreshTimer = window.setTimeout(refreshViewer, 150);
				return;
			}
			if (refreshTimer !== 0) {
				clearTimeout(refreshTimer);
				refreshTimer = 0;
			}
			refreshViewer();
		});
		resize.observe(containerRef.current!);
		const scrollContainer = containerRef.current!;
		// React wheel listeners are passive. A local non-passive listener keeps
		// Ctrl+wheel/trackpad pinch inside the document rather than zooming app UI.
		const wheelZoom = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || !viewer.pagesCount || !event.deltaY) return;
			event.preventDefault();
			event.stopPropagation();
			const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollContainer.clientHeight : 1);
			viewer.currentScale = Math.min(4, Math.max(0.25, viewer.currentScale * Math.exp(-delta * 0.002)));
		};
		scrollContainer.addEventListener("wheel", wheelZoom, { passive: false });
		// Keep URL loading so PDF.js can range-fetch large converted documents.
		const task = getDocument({ url, useSystemFonts: true, isEvalSupported: false });
		void task.promise.then(async (document) => {
			if (disposed) return;
			setPdfDocument(document);
			linkService.setDocument(document);
			viewer.setDocument(document);
			const documentOutline = await document.getOutline().catch(() => []);
			if (!disposed) setOutline(documentOutline ?? []);
		}).catch(() => { if (!disposed) setFailed(true); });
		return () => {
			disposed = true;
			if (refreshTimer !== 0) clearTimeout(refreshTimer);
			resize.disconnect();
			scrollContainer.removeEventListener("wheel", wheelZoom);
			eventBus.off("pagesinit", initialized);
			eventBus.off("pagechanging", pageChanged);
			eventBus.off("scalechanging", scaleChanged);
			eventBus.off("pagerendered", renderFailed);
			viewer.setDocument(null!);
			linkService.setDocument(null!);
			viewerRef.current = null;
			linkRef.current = null;
			void task.destroy().catch(() => undefined);
		};
	}, [url, attempt]);

	const goToPage = (value: number) => {
		if (!viewerRef.current || !Number.isInteger(value) || value < 1 || value > pageCount) {
			setPageInput(String(page));
			return;
		}
		viewerRef.current.currentPageNumber = value;
		setPageInput(String(value));
	};
	const zoom = (factor: number) => {
		if (viewerRef.current) viewerRef.current.currentScale = Math.min(4, Math.max(0.25, viewerRef.current.currentScale * factor));
	};
	const resetZoom = () => { if (viewerRef.current) viewerRef.current.currentScale = 1; };
	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (!ready || failed || event.defaultPrevented || event.altKey || event.nativeEvent.isComposing) return;
		const target = event.target as HTMLElement;
		if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
		if (event.ctrlKey || event.metaKey) {
			if (event.key === "+" || event.key === "=") zoom(1.2);
			else if (event.key === "-" || event.key === "_") zoom(1 / 1.2);
			else if (event.key === "0") resetZoom();
			else return;
		} else if (!event.shiftKey && target.closest(".inno-pdf-scroll")) {
			if (event.key === "PageUp") goToPage(Math.max(1, page - 1));
			else if (event.key === "PageDown") goToPage(Math.min(pageCount, page + 1));
			else if (event.key === "Home") goToPage(1);
			else if (event.key === "End") goToPage(pageCount);
			else return;
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};
	return <section className="inno-pdf-preview" aria-label={name} onKeyDownCapture={handleKeyDown}>
		<div className="inno-pdf-toolbar" role="group" aria-label={t("preview.pdfControls")}>
			<div className="inno-pdf-control-group">
				<IconButton size="xs" aria-label={t("preview.documentNavigation")} title={t("preview.documentNavigation")} aria-expanded={navigationOpen} disabled={!ready || failed} onClick={() => setNavigationOpen(!navigationOpen)}><ListTree size={16} /></IconButton>
				<IconButton size="xs" aria-label={t("preview.previousPage")} title={t("preview.previousPage")} disabled={!ready || failed || page <= 1} onClick={() => goToPage(page - 1)}><ChevronUp size={16} /></IconButton>
				<Input size="sm" className="inno-pdf-page-input" aria-label={t("preview.currentPage")} inputMode="numeric" value={pageInput} disabled={!ready || failed}
					onChange={(event) => setPageInput(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => goToPage(Number(pageInput))}
					onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goToPage(Number(pageInput)); } if (event.key === "Escape") setPageInput(String(page)); }} />
				<span className="inno-pdf-page-count" aria-live="polite">/ {pageCount || "—"}</span>
				<IconButton size="xs" aria-label={t("preview.nextPage")} title={t("preview.nextPage")} disabled={!ready || failed || page >= pageCount} onClick={() => goToPage(page + 1)}><ChevronDown size={16} /></IconButton>
			</div>
			<div className="inno-pdf-control-group">
				<IconButton size="xs" aria-label={t("preview.zoomOut")} title={`${t("preview.zoomOut")} (Ctrl/⌘ −)`} aria-keyshortcuts="Control+- Meta+-" disabled={!ready || failed || scale <= 0.25} onClick={() => zoom(1 / 1.2)}><Minus size={16} /></IconButton>
				<Button variant="ghost" size="xs" className="inno-pdf-zoom" aria-label={t("preview.resetZoom")} title={`${t("preview.resetZoom")} (Ctrl/⌘ 0)`} aria-keyshortcuts="Control+0 Meta+0" disabled={!ready || failed} onClick={resetZoom}>{ready ? `${Math.round(scale * 100)}%` : "—"}</Button>
				<IconButton size="xs" aria-label={t("preview.zoomIn")} title={`${t("preview.zoomIn")} (Ctrl/⌘ +)`} aria-keyshortcuts="Control+= Meta+=" disabled={!ready || failed || scale >= 4} onClick={() => zoom(1.2)}><Plus size={16} /></IconButton>
				<Button variant="ghost" size="xs" aria-label={t("preview.fitWidth")} title={t("preview.fitWidth")} aria-pressed={fitWidth} disabled={!ready || failed} onClick={() => { if (viewerRef.current) viewerRef.current.currentScaleValue = "page-width"; }}>
					<Maximize size={16} /><span className="inno-pdf-fit-label">{t("preview.fitWidth")}</span>
				</Button>
			</div>
		</div>
		<div className="inno-pdf-body">
			{navigationOpen && pdfDocument ? <PdfNavigation document={pdfDocument} outline={outline} page={page} navigate={goToPage} close={() => setNavigationOpen(false)} navigateOutline={(item) => { if (item.dest) void linkRef.current?.goToDestination(item.dest).catch(() => undefined); }} /> : null}
			<div className="inno-pdf-main">
			<div ref={containerRef} className="inno-pdf-scroll workspace-scroll" tabIndex={0} aria-label={t("preview.documentPages")}>
				<div ref={pagesRef} className="pdfViewer" />
			</div>
			{!ready && !failed ? <div role="status" className="inno-pdf-status"><Spinner size={16} />{t("preview.wordOpening")}</div> : null}
			{failed ? <div role="alert" className="inno-pdf-status"><span>{t("preview.docxFailed")}</span><Button size="xs" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={14} />{t("preview.wordRetry")}</Button></div> : null}
			</div>
		</div>
	</section>;
}
