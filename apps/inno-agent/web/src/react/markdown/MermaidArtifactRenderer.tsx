import { Check, Code2, Copy, Download, Maximize2, MoreHorizontal, RotateCcw, Workflow, ZoomIn, ZoomOut } from "lucide-react";
import { Fragment, useCallback, useContext, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { mermaid, type MermaidConfig } from "@streamdown/mermaid";
import { StreamdownContext, type CustomRendererProps } from "streamdown";
import {
	downloadBlob,
	MarkdownFullscreenDialog,
	MarkdownToolbar,
	MarkdownToolbarDivider,
	MarkdownToolbarGroup,
	ToolbarIconButton,
	ToolbarMenu,
	ToolbarMenuItem,
	ToolbarSegmentedButton,
	markdownControlEnabled,
	markdownToolbarEnabled,
} from "./shared.js";

const MERMAID_CONFIG = {
	securityLevel: "strict",
	startOnLoad: false,
	suppressErrorRendering: true,
	fontFamily: "inherit",
} satisfies MermaidConfig;

type MermaidView = "chart" | "code";
type MermaidPan = { x: number; y: number };

const MIN_MERMAID_ZOOM = 0.25;
const MAX_MERMAID_ZOOM = 4;
const MERMAID_ZOOM_STEP = 0.25;

function getMermaidAspectRatio(svg: string): number | null {
	const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]
		?.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (!viewBox || viewBox.length < 4 || !Number.isFinite(viewBox[2]) || !Number.isFinite(viewBox[3]) || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
	return viewBox[2] / viewBox[3];
}

function MermaidToolbar({
	view,
	zoom,
	isFullscreen,
	moreOpen,
	moreId,
	onViewChange,
	onZoomChange,
	onReset,
	onCopy,
	onDownload,
	onFullscreen,
	onMoreToggle,
	onMoreClose,
	canDownload,
	canReset,
	canCopy,
	copyEnabled,
	downloadEnabled,
	fullscreenEnabled,
	panZoomEnabled,
	copied,
}: {
	view: MermaidView;
	zoom: number;
	isFullscreen: boolean;
	moreOpen: boolean;
	moreId: string;
	onViewChange: (view: MermaidView) => void;
	onZoomChange: (delta: number) => void;
	onReset: () => void;
	onCopy: () => void | Promise<void>;
	onDownload: () => void;
	onFullscreen: () => void;
	onMoreToggle: () => void;
	onMoreClose: () => void;
	canDownload: boolean;
	canReset: boolean;
	canCopy: boolean;
	copyEnabled: boolean;
	downloadEnabled: boolean;
	fullscreenEnabled: boolean;
	panZoomEnabled: boolean;
	copied: boolean;
}) {
	const { t } = useTranslation();
	const hasMoreActions = downloadEnabled || (fullscreenEnabled && !isFullscreen);
	const panZoomDisabled = view === "code";
	return (
		<MarkdownToolbar label={t("markdown.mermaidView", "Mermaid 视图")}>
			<div className="inno-markdown-toolbar-group inno-markdown-toolbar-group--modes" role="tablist" aria-label={t("markdown.mermaidView", "Mermaid 视图")}>
					<ToolbarSegmentedButton label={t("markdown.mermaidChart", "图表")} showLabel selected={view === "chart"} onClick={() => onViewChange("chart")}><Workflow size={14} /></ToolbarSegmentedButton>
					<ToolbarSegmentedButton label={t("markdown.mermaidCode", "代码")} showLabel selected={view === "code"} onClick={() => onViewChange("code")}><Code2 size={14} /></ToolbarSegmentedButton>
			</div>
			{panZoomEnabled ? (
				<>
					<MarkdownToolbarGroup>
						<ToolbarIconButton label={t("markdown.zoomOut", "缩小")} showLabel disabled={panZoomDisabled || zoom <= MIN_MERMAID_ZOOM} onClick={() => onZoomChange(-MERMAID_ZOOM_STEP)}><ZoomOut size={14} /></ToolbarIconButton>
						<ToolbarIconButton label={t("markdown.zoomIn", "放大")} showLabel disabled={panZoomDisabled || zoom >= MAX_MERMAID_ZOOM} onClick={() => onZoomChange(MERMAID_ZOOM_STEP)}><ZoomIn size={14} /></ToolbarIconButton>
						<ToolbarIconButton label={t("markdown.resetView", "重置视图")} showLabel disabled={panZoomDisabled || !canReset} onClick={onReset}><RotateCcw size={14} /></ToolbarIconButton>
					</MarkdownToolbarGroup>
					<MarkdownToolbarDivider />
				</>
			) : null}
			{copyEnabled || hasMoreActions ? (
				<MarkdownToolbarGroup>
					{copyEnabled ? <ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyCode", "复制代码")} showLabel disabled={!canCopy} onClick={onCopy}>
						{copied ? <Check size={14} /> : <Copy size={14} />}
					</ToolbarIconButton> : null}
					{hasMoreActions ? <div className="inno-markdown-toolbar-menu-anchor">
							<ToolbarIconButton label={t("markdown.moreTools", "更多")} showLabel menu expanded={moreOpen} aria-controls={moreId} onClick={onMoreToggle}><MoreHorizontal size={14} /></ToolbarIconButton>
						<ToolbarMenu id={moreId} open={moreOpen} onClose={onMoreClose} label={t("markdown.moreTools", "更多")}>
							{downloadEnabled ? <ToolbarMenuItem label={t("markdown.downloadDiagram", "下载图表")} disabled={!canDownload} onClick={onDownload}><Download size={14} /></ToolbarMenuItem> : null}
							{fullscreenEnabled && !isFullscreen ? <ToolbarMenuItem label={t("markdown.fullscreen", "全屏查看")} onClick={onFullscreen}><Maximize2 size={14} /></ToolbarMenuItem> : null}
						</ToolbarMenu>
					</div> : null}
				</MarkdownToolbarGroup>
			) : null}
		</MarkdownToolbar>
	);
}

function MermaidSurface({
	view,
	code,
	svg,
	loading,
	error,
	zoom,
	pan,
	aspectRatio,
	isFullscreen,
	loadingLabel,
	errorLabel,
	chartLabel,
	onPanChange,
}: {
	view: MermaidView;
	code: string;
	svg: string | null;
	loading: boolean;
	error: boolean;
	zoom: number;
	pan: MermaidPan;
	aspectRatio: number | null;
	isFullscreen: boolean;
	loadingLabel: string;
	errorLabel: string;
	chartLabel: string;
	onPanChange: (pan: MermaidPan) => void;
}) {
	const dragRef = useRef<{ pointerId: number; startX: number; startY: number; pan: MermaidPan } | null>(null);
	const [dragging, setDragging] = useState(false);
	const canDrag = view === "chart" && Boolean(svg) && !loading && !error;

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!canDrag || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
		dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, pan };
		setDragging(true);
		event.currentTarget.setPointerCapture?.(event.pointerId);
		event.preventDefault();
	};
	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		onPanChange({ x: drag.pan.x + event.clientX - drag.startX, y: drag.pan.y + event.clientY - drag.startY });
	};
	const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
	};

	return (
		<div
			data-inno-mermaid-surface=""
			className="inno-mermaid-surface inno-markdown-mermaid-surface"
			style={aspectRatio && !isFullscreen
				? { aspectRatio: String(aspectRatio) }
				: undefined}
		>
			{view === "code" ? (
				<pre data-inno-mermaid-source="" className="inno-mermaid-source inno-markdown-mermaid-source"><code>{code}</code></pre>
			) : (
				<div
					data-inno-mermaid-chart=""
					data-inno-mermaid-draggable={canDrag ? "true" : undefined}
					data-inno-mermaid-dragging={dragging ? "true" : undefined}
					className="inno-mermaid-chart"
					role="img"
					aria-label={chartLabel}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={stopDragging}
					onPointerCancel={stopDragging}
				>
					{loading ? <div className="inno-mermaid-status" role="status"><span className="inno-mermaid-spinner" aria-hidden="true" />{loadingLabel}</div> : null}
					{!loading && error ? <div className="inno-mermaid-status" role="status">{errorLabel}</div> : null}
					{!loading && !error && svg ? <div className="inno-mermaid-chart-svg" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} dangerouslySetInnerHTML={{ __html: svg }} /> : null}
				</div>
			)}
		</div>
	);
}

export function MermaidArtifactRenderer({ code, isIncomplete }: CustomRendererProps) {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "mermaid");
	const copyEnabled = markdownControlEnabled(streamdownContext.controls, "mermaid", "copy");
	const downloadEnabled = markdownControlEnabled(streamdownContext.controls, "mermaid", "download");
	const fullscreenEnabled = markdownControlEnabled(streamdownContext.controls, "mermaid", "fullscreen");
	const panZoomEnabled = markdownControlEnabled(streamdownContext.controls, "mermaid", "panZoom");
	const renderId = `inno-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const moreId = `inno-mermaid-more-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const fullscreenMoreId = `${moreId}-fullscreen`;
	const [view, setViewState] = useState<MermaidView>(() => isIncomplete ? "code" : "chart");
	const [svg, setSvg] = useState<string | null>(null);
	const [loading, setLoading] = useState(() => !isIncomplete && code.trim().length > 0);
	const [error, setError] = useState(false);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState<MermaidPan>({ x: 0, y: 0 });
	const [fullscreen, setFullscreen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const copyResetTimerRef = useRef<number | null>(null);
	const viewPinnedRef = useRef(false);
	const aspectRatio = svg ? getMermaidAspectRatio(svg) : null;

	useEffect(() => () => {
		if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
	}, []);

	const setView = useCallback((next: MermaidView) => {
		viewPinnedRef.current = true;
		setViewState(next);
	}, []);

	useEffect(() => {
		let active = true;
		if (isIncomplete || !code.trim()) {
			setSvg(null);
			setLoading(false);
			setError(false);
			setPan({ x: 0, y: 0 });
			setViewState("code");
			return () => { active = false; };
		}

		setLoading(true);
		setError(false);
		if (!viewPinnedRef.current) setViewState("chart");
		void mermaid.getMermaid(MERMAID_CONFIG).render(renderId, code)
			.then((result) => {
				if (!active) return;
				setSvg(result.svg);
				setLoading(false);
				setZoom(1);
				setPan({ x: 0, y: 0 });
			})
			.catch(() => {
				if (!active) return;
				setSvg(null);
				setLoading(false);
				setError(true);
			});

		return () => { active = false; };
	}, [code, isIncomplete, renderId]);

	const handleDownload = useCallback(() => {
		if (svg) {
			downloadBlob("inno-diagram.svg", new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
		} else {
			downloadBlob("inno-diagram.mmd", new Blob([code], { type: "text/plain;charset=utf-8" }));
		}
	}, [code, svg]);

	const handleCopy = useCallback(async () => {
		if (!code.trim() || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
			copyResetTimerRef.current = window.setTimeout(() => {
				copyResetTimerRef.current = null;
				setCopied(false);
			}, 1600);
		} catch {
			// Clipboard access can be denied by the browser; leave the action quiet.
		}
	}, [code]);

	const handleReset = useCallback(() => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	}, []);

	const closeFullscreen = useCallback(() => {
		setFullscreen(false);
		setMoreOpen(false);
	}, []);
	const openFullscreen = useCallback(() => {
		setMoreOpen(false);
		setFullscreen(true);
	}, []);

	const toolbar = (isFullscreen: boolean, id: string) => toolbarEnabled ? (
		<MermaidToolbar
			view={view}
			zoom={zoom}
			isFullscreen={isFullscreen}
			moreOpen={moreOpen}
			moreId={id}
			onViewChange={setView}
			onZoomChange={(delta) => setZoom((value) => Math.min(MAX_MERMAID_ZOOM, Math.max(MIN_MERMAID_ZOOM, Math.round((value + delta) * 100) / 100)))}
			onReset={handleReset}
			onCopy={() => void handleCopy()}
			onDownload={handleDownload}
			onFullscreen={openFullscreen}
			onMoreToggle={() => setMoreOpen((value) => !value)}
			onMoreClose={() => setMoreOpen(false)}
			canDownload={Boolean(code.trim())}
			canReset={zoom !== 1 || pan.x !== 0 || pan.y !== 0}
			canCopy={Boolean(code.trim())}
			copyEnabled={copyEnabled}
			downloadEnabled={downloadEnabled}
			fullscreenEnabled={fullscreenEnabled}
			panZoomEnabled={panZoomEnabled}
			copied={copied}
		/>
	) : null;

	const surface = (isFullscreen: boolean) => (
		<MermaidSurface
			view={view}
			code={code}
			svg={svg}
			loading={loading}
			error={error}
			zoom={zoom}
			pan={pan}
			aspectRatio={aspectRatio}
			isFullscreen={isFullscreen}
			loadingLabel={t("markdown.mermaidRendering", "正在渲染图表…")}
			errorLabel={t("markdown.mermaidRenderError", "图表暂时无法渲染，请切换到代码查看。")}
			chartLabel={t("markdown.mermaidChart", "图表")}
			onPanChange={setPan}
		/>
	);

		return (
			<Fragment>
				<div data-inno-mermaid-preview="" data-inno-content-block="mermaid" className={`inno-markdown-content-block inno-markdown-content-block--mermaid${loading ? " is-loading" : ""}`}>
					<div className="inno-markdown-content-header">
						<span className="inno-markdown-content-title">{t("markdown.mermaidLabel", "Mermaid 图表")}</span>
						{toolbar(false, moreId)}
					</div>
					{surface(false)}
				</div>
				<MarkdownFullscreenDialog
					open={fullscreen}
					title={t("markdown.mermaidLabel", "Mermaid 图表")}
					ariaLabel={t("markdown.mermaidFullscreen", "Mermaid 全屏查看")}
				closeLabel={t("markdown.exitFullscreen", "退出全屏")}
				onClose={closeFullscreen}
				actions={toolbar(true, fullscreenMoreId)}
			>
				<div data-inno-mermaid-preview="" data-inno-content-block="mermaid" className={`inno-markdown-content-block inno-markdown-content-block--mermaid${loading ? " is-loading" : ""} is-fullscreen`}>
					{surface(true)}
				</div>
			</MarkdownFullscreenDialog>
		</Fragment>
	);
}
