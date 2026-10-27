import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { IconButton, MenuOption, Tabs, getTabTriggerId } from "../ui/index.js";

export interface PdfOutlineItem {
	title: string;
	dest: string | unknown[] | null;
	items: PdfOutlineItem[];
}

function OutlineEntry({ item, navigate }: { item: PdfOutlineItem; navigate(item: PdfOutlineItem): void }) {
	const [expanded, setExpanded] = useState(false);
	return <li>
		<div className="inno-pdf-outline-row">
			{/* Reserve the same disclosure column for leaves so sibling titles align. */}
			<span className="inno-pdf-outline-disclosure">{item.items.length ? <IconButton size="xs" aria-label={item.title} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</IconButton> : null}</span>
			<MenuOption className="inno-pdf-outline-link" title={item.title} disabled={!item.dest} onClick={() => navigate(item)}><span className="truncate">{item.title}</span></MenuOption>
		</div>
		{expanded && item.items.length ? <ul className="inno-pdf-outline-children">{item.items.map((child, index) => <OutlineEntry key={index} item={child} navigate={navigate} />)}</ul> : null}
	</li>;
}

function PageThumbnail({ document, pageNumber, current, root, navigate }: { document: PDFDocumentProxy; pageNumber: number; current: boolean; root: HTMLDivElement | null; navigate(page: number): void }) {
	const { t } = useTranslation();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root, rootMargin: "160px" });
		observer.observe(canvasRef.current!);
		return () => observer.disconnect();
	}, [root]);
	useEffect(() => {
		if (!visible) return;
		const canvas = canvasRef.current!;
		let disposed = false;
		let task: RenderTask | undefined;
		void document.getPage(pageNumber).then(async (page) => {
			if (disposed) return;
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: 120 / base.width * Math.min(window.devicePixelRatio || 1, 2) });
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			task = page.render({ canvas, viewport });
			await task.promise;
		}).catch(() => { /* Page-number navigation remains usable if a thumbnail cannot render. */ });
		return () => {
			disposed = true;
			task?.cancel();
			canvas.width = canvas.height = 0;
		};
	}, [document, pageNumber, visible]);
	return <MenuOption className="inno-pdf-thumbnail" aria-label={t("preview.pageNumber", { number: pageNumber })} aria-current={current ? "page" : undefined} onClick={() => navigate(pageNumber)}>
		<canvas ref={canvasRef} aria-hidden="true" />
		<span>{pageNumber}</span>
	</MenuOption>;
}

export default function PdfNavigation({ document, outline, page, navigate, navigateOutline, close }: {
	document: PDFDocumentProxy;
	outline: PdfOutlineItem[] | null;
	page: number;
	navigate(page: number): void;
	navigateOutline(item: PdfOutlineItem): void;
	close(): void;
}) {
	const { t } = useTranslation();
	const id = useId();
	const [tab, setTab] = useState<"outline" | "pages">("outline");
	const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
	return <aside className="inno-pdf-navigation" aria-label={t("preview.documentNavigation")} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
		<div className="inno-pdf-navigation-header">
			<Tabs id={id} size="compact" value={tab} onValueChange={setTab} ariaLabel={t("preview.documentNavigation")} items={[
				{ value: "outline", label: t("preview.documentOutline") },
				{ value: "pages", label: t("preview.documentThumbnails") },
			]} />
			<IconButton size="xs" aria-label={t("preview.closeNavigation")} onClick={close}><X size={16} /></IconButton>
		</div>
		<div ref={setScrollRoot} id={`${id}-panel`} role="tabpanel" aria-labelledby={getTabTriggerId(id, tab)} className="inno-pdf-navigation-content workspace-scroll">
			{tab === "outline" ? outline === null ? <p className="inno-pdf-navigation-note" role="status">{t("preview.loadingFile")}</p> : outline.length ?
				<ul>{outline.map((item, index) => <OutlineEntry key={index} item={item} navigate={navigateOutline} />)}</ul>
				: <p className="inno-pdf-navigation-note">{t("preview.noDocumentOutline")}</p>
				: Array.from({ length: document.numPages }, (_, index) => <PageThumbnail key={index} document={document} pageNumber={index + 1} current={page === index + 1} root={scrollRoot} navigate={navigate} />)}
		</div>
	</aside>;
}
