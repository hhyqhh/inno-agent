import {
	AlertTriangle,
	Check,
	Code2,
	Columns2,
	Copy,
	Download,
	Eye,
	Maximize2,
	MoreHorizontal,
	Pencil,
	Play,
	RotateCcw,
	Save,
	WrapText,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import plantumlEncoder from "plantuml-encoder";
import {
	Fragment,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
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
	markdownMaxHeight,
	markdownToolbarEnabled,
} from "./shared.js";

type ArtifactViewMode = "preview" | "source" | "split";

const RESTRICTED_PREVIEW_CSP = [
	"default-src 'none'",
	"img-src data: blob:",
	"media-src data: blob:",
	"style-src 'unsafe-inline'",
	"font-src data:",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");
const INTERACTIVE_PREVIEW_CSP = [
	RESTRICTED_PREVIEW_CSP,
	"script-src 'unsafe-inline'",
	"connect-src 'none'",
	"frame-src 'none'",
	"worker-src 'none'",
].join("; ");

function htmlRequiresInteraction(html: string): boolean {
	return /<(?:script|iframe|object|embed)\b|\son[a-z]+\s*=|javascript\s*:/i.test(html);
}

function stripMetaRefresh(html: string): string {
	return html.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?refresh\b)[^>]*>/gi, "");
}

const SVG_ALLOWED_ELEMENTS = new Set([
	"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan", "title", "desc", "defs", "symbol", "use", "image", "marker",
	"lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "style",
	"filter", "fegaussianblur", "feoffset", "femerge", "femergenode", "fecolormatrix",
]);
const SVG_ALLOWED_ATTRIBUTES = new Set([
	"xmlns", "viewbox", "preserveaspectratio", "width", "height", "x", "y", "x1", "x2", "y1", "y2",
	"cx", "cy", "r", "rx", "ry", "d", "dx", "dy", "points", "pathlength", "transform",
	"fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
	"stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity", "color", "offset",
	"stop-color", "stop-opacity", "font-family", "font-size", "font-style", "font-weight", "text-anchor",
	"dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing",
	"clip-path", "clip-rule", "mask", "filter", "marker-start", "marker-mid", "marker-end",
	"id", "class", "style", "href", "xlink:href", "role", "aria-label", "aria-hidden",
]);

function sanitizeSvgMarkup(source: string): string | null {
	if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
	const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
	const root = documentNode.documentElement;
	if (root.localName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) {
		return null;
	}

	for (const element of Array.from(root.querySelectorAll("*"))) {
		const tag = element.localName.toLowerCase();
		if (!SVG_ALLOWED_ELEMENTS.has(tag)) {
			element.remove();
			continue;
		}
		if (tag === "style") {
			const css = element.textContent ?? "";
			if (/@import|expression\s*\(|javascript\s*:|url\s*\(\s*(?!['"]?#)/i.test(css)) element.remove();
			continue;
		}
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			const value = attribute.value.trim();
			if (!SVG_ALLOWED_ATTRIBUTES.has(name) || name.startsWith("on")) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if ((name === "href" || name === "xlink:href") && !/^#[-\w:.]+$/.test(value) && !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value)) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (/^(?:fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/.test(name) && /url\s*\(/i.test(value) && !/^url\(\s*['"]?#[-\w:.]+['"]?\s*\)$/i.test(value)) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (name === "style" && /@import|expression\s*\(|javascript\s*:|url\s*\(\s*(?!['"]?#)/i.test(value)) element.removeAttribute(attribute.name);
		}
	}
	for (const attribute of Array.from(root.attributes)) {
		if (!SVG_ALLOWED_ATTRIBUTES.has(attribute.name.toLowerCase()) || attribute.name.toLowerCase().startsWith("on")) root.removeAttribute(attribute.name);
	}
	return new XMLSerializer().serializeToString(root);
}

function injectRestrictedHead(html: string, csp = RESTRICTED_PREVIEW_CSP): string {
	const safeHtml = stripMetaRefresh(html);
	const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
	if (/<head(?:\s[^>]*)?>/i.test(safeHtml)) {
		return safeHtml.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`);
	}
	if (/<html(?:\s[^>]*)?>/i.test(safeHtml)) {
		return safeHtml.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head>${meta}</head>`);
	}
	return `<head>${meta}</head>${safeHtml}`;
}

function safeFilename(value: string): string {
	const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-");
	return normalized.slice(0, 80) || "inno-artifact";
}

function extractHtmlTitle(html: string): string {
	const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
		?.replace(/<[^>]+>/g, "")
		.trim();
	return title || "";
}

function ArtifactSource({
	source,
	editing,
	wrapped,
	onChange,
}: {
	source: string;
	editing: boolean;
	wrapped: boolean;
	onChange: (value: string) => void;
}) {
	if (editing) {
		return (
			<textarea
				value={source}
				onChange={(event) => onChange(event.target.value)}
				spellCheck={false}
				className="inno-markdown-artifact-editor"
			/>
		);
	}

	return (
		<pre className={`inno-markdown-artifact-source ${wrapped ? "is-wrapped" : ""}`}>
			<code>{source}</code>
		</pre>
	);
}

interface ArtifactShellProps extends CustomRendererProps {
	title: string;
	extension: string;
	mimeType?: string;
	renderPreview: (source: string, isFullscreen: boolean) => ReactNode;
	renderToolbarAction?: (source: string) => ReactNode;
}

interface ArtifactToolbarProps {
	displayMode: ArtifactViewMode;
	canPreview: boolean;
	isIncomplete: boolean;
	editing: boolean;
	wrapped: boolean;
	copied: boolean;
	copyEnabled: boolean;
	downloadEnabled: boolean;
	fullscreenEnabled: boolean;
	moreOpen: boolean;
	moreId: string;
	hasEditedSource: boolean;
	onPreview: () => void;
	onSource: () => void;
	onSplit: () => void;
	onToggleMore: () => void;
	onCloseMore: () => void;
	onWrap: () => void;
	onApply: () => void;
	onEdit: () => void;
	onRestore: () => void;
	onCopy: () => void | Promise<void>;
	onDownload: () => void;
	onFullscreen: () => void;
	toolbarAction?: ReactNode;
}

function ArtifactToolbar({
	displayMode,
	canPreview,
	isIncomplete,
	editing,
	wrapped,
	copied,
	copyEnabled,
	downloadEnabled,
	fullscreenEnabled,
	moreOpen,
	moreId,
	hasEditedSource,
	onPreview,
	onSource,
	onSplit,
	onToggleMore,
	onCloseMore,
	onWrap,
	onApply,
	onEdit,
	onRestore,
	onCopy,
	onDownload,
	onFullscreen,
	toolbarAction,
}: ArtifactToolbarProps) {
	const { t } = useTranslation();
	return (
		<MarkdownToolbar label={t("markdown.artifactTools", "Artifact 工具")}>
			<div className="inno-markdown-toolbar-group inno-markdown-toolbar-group--modes" role="tablist" aria-label={t("markdown.artifactView", "Artifact 视图")}>
				<ToolbarSegmentedButton label={t("markdown.preview", "预览")} showLabel selected={displayMode === "preview"} disabled={!canPreview} onClick={onPreview}><Eye size={14} /></ToolbarSegmentedButton>
				<ToolbarSegmentedButton label={t("markdown.viewSource", "查看源码")} showLabel selected={displayMode === "source"} onClick={onSource}><Code2 size={14} /></ToolbarSegmentedButton>
			</div>
			{copyEnabled ? (
				<ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copySource", "复制源码")} showLabel onClick={onCopy}>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ToolbarIconButton>
			) : null}
			{toolbarAction}
			<div className="inno-markdown-toolbar-menu-anchor">
				<ToolbarIconButton label={t("markdown.moreTools", "更多")} showLabel menu expanded={moreOpen} aria-controls={moreId} onClick={onToggleMore}>
					<MoreHorizontal size={14} />
				</ToolbarIconButton>
				<ToolbarMenu id={moreId} open={moreOpen} onClose={onCloseMore} label={t("markdown.moreTools", "更多")}>
					<ToolbarMenuItem label={t("markdown.splitView", "分屏查看")} disabled={!canPreview} onClick={onSplit}><Columns2 size={14} /></ToolbarMenuItem>
					<ToolbarMenuItem label={wrapped ? t("markdown.disableWrapText", "取消自动换行") : t("markdown.wrapText", "自动换行")} onClick={onWrap}><WrapText size={14} /></ToolbarMenuItem>
					{editing ? (
						<ToolbarMenuItem label={t("markdown.applyChanges", "应用更改")} onClick={onApply}><Save size={14} /></ToolbarMenuItem>
					) : (
						<ToolbarMenuItem label={t("markdown.editCopy", "编辑副本")} disabled={isIncomplete} onClick={onEdit}><Pencil size={14} /></ToolbarMenuItem>
					)}
					{hasEditedSource ? <ToolbarMenuItem label={t("markdown.restoreOriginal", "恢复模型原文")} onClick={onRestore}><RotateCcw size={14} /></ToolbarMenuItem> : null}
					{downloadEnabled ? <ToolbarMenuItem label={t("markdown.downloadSource", "下载源码")} onClick={onDownload}><Download size={14} /></ToolbarMenuItem> : null}
					{fullscreenEnabled ? <ToolbarMenuItem label={t("markdown.fullscreen", "全屏查看")} disabled={!canPreview} onClick={onFullscreen}><Maximize2 size={14} /></ToolbarMenuItem> : null}
				</ToolbarMenu>
			</div>
		</MarkdownToolbar>
	);
}

function ArtifactShell({ code, language, isIncomplete, title, extension, mimeType, renderPreview, renderToolbarAction }: ArtifactShellProps) {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "code");
	const copyEnabled = markdownControlEnabled(streamdownContext.controls, "code", "copy");
	const downloadEnabled = markdownControlEnabled(streamdownContext.controls, "code", "download");
	const fullscreenEnabled = markdownControlEnabled(streamdownContext.controls, "code", "fullscreen");
	const maxHeight = markdownMaxHeight(streamdownContext.codeBlockMaxHeight);
	const moreId = `inno-artifact-more-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const [mode, setModeState] = useState<ArtifactViewMode>(isIncomplete ? "source" : "preview");
	// Streaming forces the source view; a manual toolbar choice pins the mode so
	// the post-completion switch back to preview does not override the user.
	const modePinnedRef = useRef(false);
	const setMode = (next: ArtifactViewMode) => {
		modePinnedRef.current = true;
		setModeState(next);
	};
	// null = pristine: follow the streaming `code` prop directly. Syncing
	// streamed source into state via an effect leaves one committed render
	// per chunk where state !== code, flashing the "restore original" button.
	const [editedSource, setEditedSource] = useState<string | null>(null);
	const [draft, setDraft] = useState(code);
	const [editing, setEditing] = useState(false);
	const [wrapped, setWrapped] = useState(false);
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);

	useEffect(() => {
		if (isIncomplete && !modePinnedRef.current) {
			setModeState("source");
		} else if (!modePinnedRef.current) {
			// The fence just completed: leave the forced source view for the
			// rendered preview unless the user picked a mode themselves.
			setModeState("preview");
		}
	}, [isIncomplete]);

	useEffect(() => setMoreOpen(false), [code]);

	const appliedSource = editedSource ?? code;
	const currentSource = editing ? draft : appliedSource;
	const canPreview = !isIncomplete && currentSource.trim().length > 0;
	// Effects run after paint. Derive the automatic mode during render so the
	// fence-completion commit goes straight from streaming source to preview
	// instead of flashing the source for one frame.
	const displayMode = canPreview
		? (isIncomplete ? "source" : modePinnedRef.current ? mode : "preview")
		: "source";
	const toolbarAction = renderToolbarAction?.(currentSource);

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(currentSource);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	}, [currentSource]);

	const handleDownload = () => {
		downloadBlob(`${safeFilename(title)}.${extension}`, new Blob([currentSource], { type: mimeType ?? "text/plain;charset=utf-8" }));
	};

	const handlePreview = () => {
		setMode("preview");
	};

	const handleEdit = () => {
		setDraft(appliedSource);
		setEditing(true);
		setMode("source");
	};

	const handleSave = () => {
		setEditedSource(draft);
		setEditing(false);
		setMode("preview");
	};

	const handleReset = () => {
		setEditedSource(null);
		setDraft(code);
		setEditing(false);
	};

	const content = (isFullscreen: boolean) => (
		<div data-inno-content-block="artifact" className={`inno-markdown-artifact-content ${isFullscreen ? "is-fullscreen" : ""}`} style={!isFullscreen && maxHeight ? { maxHeight } : undefined}>
			{displayMode === "preview" ? renderPreview(currentSource, isFullscreen) : null}
			{displayMode === "source" ? <ArtifactSource source={currentSource} editing={editing} wrapped={wrapped} onChange={setDraft} /> : null}
			{displayMode === "split" ? (
				<div className="inno-markdown-artifact-split">
					<div className="inno-markdown-artifact-pane">{renderPreview(currentSource, isFullscreen)}</div>
					<div className="inno-markdown-artifact-pane"><ArtifactSource source={currentSource} editing={editing} wrapped={wrapped} onChange={setDraft} /></div>
				</div>
			) : null}
		</div>
	);

	const toolbar = toolbarEnabled ? (
		<ArtifactToolbar
			displayMode={displayMode}
			canPreview={canPreview}
			isIncomplete={isIncomplete}
			editing={editing}
			wrapped={wrapped}
			copied={copied}
			copyEnabled={copyEnabled}
			downloadEnabled={downloadEnabled}
			fullscreenEnabled={fullscreenEnabled}
			moreOpen={moreOpen}
			moreId={moreId}
			hasEditedSource={editedSource !== null && editedSource !== code}
			onPreview={handlePreview}
			onSource={() => setMode("source")}
			onSplit={() => setMode("split")}
			onToggleMore={() => setMoreOpen((value) => !value)}
			onCloseMore={() => setMoreOpen(false)}
			onWrap={() => setWrapped((value) => !value)}
			onApply={handleSave}
			onEdit={handleEdit}
			onRestore={handleReset}
			onCopy={() => void handleCopy()}
			onDownload={handleDownload}
			onFullscreen={() => { setMoreOpen(false); setFullscreen(true); }}
			toolbarAction={toolbarAction}
		/>
	) : null;

	return (
		<Fragment>
			<div data-inno-artifact={language} data-inno-content-block="artifact" className="inno-markdown-content-block inno-markdown-content-block--artifact">
				<div className="inno-markdown-content-header">
					<span className="inno-markdown-content-title">{title}</span>
					{isIncomplete ? <span className="inno-markdown-content-status"><span className="inno-markdown-content-status-dot" />{t("markdown.generating", "生成中")}</span> : null}
					{toolbar}
				</div>
				{content(false)}
			</div>

			<MarkdownFullscreenDialog
				open={fullscreen}
				title={title}
				ariaLabel={`${title} ${t("markdown.fullscreen", "全屏预览")}`}
				closeLabel={t("markdown.exitFullscreen", "退出全屏")}
				onClose={() => setFullscreen(false)}
				actions={toolbarEnabled && (copyEnabled || downloadEnabled || toolbarAction) ? (
					<MarkdownToolbar label={t("markdown.artifactTools", "Artifact 工具")}>
						{toolbarAction}
						{copyEnabled ? <ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copySource", "复制源码")} showLabel onClick={() => void handleCopy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</ToolbarIconButton> : null}
						{downloadEnabled ? <ToolbarIconButton label={t("markdown.downloadSource", "下载源码")} showLabel onClick={handleDownload}><Download size={14} /></ToolbarIconButton> : null}
					</MarkdownToolbar>
				) : null}
			>
				{content(true)}
			</MarkdownFullscreenDialog>
		</Fragment>
	);
}

const SVG_PREVIEW_STYLE = "<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{display:block;width:100% !important;height:auto !important;max-width:100% !important;max-height:100% !important}</style>";

const MIN_SVG_ZOOM = 0.25;
const MAX_SVG_ZOOM = 4;
const SVG_ZOOM_STEP = 0.25;
const INITIAL_SVG_PAN = { x: 0, y: 0 };
const MAX_INLINE_SVG_WIDTH = 480;

type SvgPan = { x: number; y: number };

function useSvgZoom(source: string) {
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState<SvgPan>(INITIAL_SVG_PAN);

	useEffect(() => {
		setZoom(1);
		setPan(INITIAL_SVG_PAN);
	}, [source]);

	const onZoomChange = useCallback((delta: number) => {
		setZoom((value) => Math.min(MAX_SVG_ZOOM, Math.max(MIN_SVG_ZOOM, Math.round((value + delta) * 100) / 100)));
	}, []);
	const onReset = useCallback(() => {
		setZoom(1);
		setPan(INITIAL_SVG_PAN);
	}, []);

	return { zoom, pan, onZoomChange, onPanChange: setPan, onReset };
}

function SvgZoomControls({ zoom, pan, onZoomChange, onReset, disabled }: { zoom: number; pan: SvgPan; onZoomChange: (delta: number) => void; onReset: () => void; disabled: boolean }) {
	const { t } = useTranslation();
	const viewIsReset = zoom === 1 && pan.x === 0 && pan.y === 0;
	return (
		<>
			<MarkdownToolbarGroup>
				<ToolbarIconButton label={t("markdown.zoomOut", "缩小")} showLabel disabled={disabled || zoom <= MIN_SVG_ZOOM} onClick={() => onZoomChange(-SVG_ZOOM_STEP)}><ZoomOut size={14} /></ToolbarIconButton>
				<ToolbarIconButton label={t("markdown.zoomIn", "放大")} showLabel disabled={disabled || zoom >= MAX_SVG_ZOOM} onClick={() => onZoomChange(SVG_ZOOM_STEP)}><ZoomIn size={14} /></ToolbarIconButton>
				<ToolbarIconButton label={t("markdown.resetView", "重置视图")} showLabel disabled={disabled || viewIsReset} onClick={onReset}><RotateCcw size={14} /></ToolbarIconButton>
			</MarkdownToolbarGroup>
			<MarkdownToolbarDivider />
		</>
	);
}

function useSvgArtifactControls(source: string, isIncomplete: boolean) {
	const streamdownContext = useContext(StreamdownContext);
	const { zoom, pan, onZoomChange, onPanChange, onReset } = useSvgZoom(source);
	const panZoomEnabled = markdownControlEnabled(streamdownContext.controls, "code", "panZoom");
	const renderToolbarAction = useCallback((currentSource: string) => panZoomEnabled ? (
		<SvgZoomControls
			zoom={zoom}
			pan={pan}
			onZoomChange={onZoomChange}
			onReset={onReset}
			disabled={isIncomplete || !currentSource.trim()}
		/>
	) : null, [isIncomplete, onReset, onZoomChange, pan, panZoomEnabled, zoom]);
	return { zoom, pan, onPanChange, renderToolbarAction };
}

type SvgPreviewDimensions = {
	aspectRatio: number;
};

function getSvgPreviewDimensions(svg: string): SvgPreviewDimensions | null {
	const width = /\bwidth\s*=\s*["']([0-9]+(?:\.[0-9]+)?)(?:\s*px)?["']/i.exec(svg)?.[1];
	const height = /\bheight\s*=\s*["']([0-9]+(?:\.[0-9]+)?)(?:\s*px)?["']/i.exec(svg)?.[1];
	const widthValue = width ? Number(width) : null;
	const heightValue = height ? Number(height) : null;
	if (widthValue && heightValue && Number.isFinite(widthValue) && Number.isFinite(heightValue) && widthValue > 0 && heightValue > 0) {
		return { aspectRatio: widthValue / heightValue };
	}

	const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]
		?.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (viewBox && viewBox.length >= 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3]) && viewBox[2] > 0 && viewBox[3] > 0) {
		return { aspectRatio: viewBox[2] / viewBox[3] };
	}

	return null;
}

function RestrictedHtmlFrame({ html, title, className = "", allowScripts = false, style }: { html: string; title: string; className?: string; allowScripts?: boolean; style?: CSSProperties }) {
	const srcDoc = useMemo(() => injectRestrictedHead(html, allowScripts ? INTERACTIVE_PREVIEW_CSP : RESTRICTED_PREVIEW_CSP), [allowScripts, html]);
	return (
		<iframe
			title={title}
			sandbox={allowScripts ? "allow-scripts" : ""}
			srcDoc={srcDoc}
			className={`inno-markdown-preview-frame ${className}`}
			style={style}
		/>
	);
}

function HtmlPreview({ html, title, interactiveEnabled }: { html: string; title: string; interactiveEnabled: boolean }) {
	const requiresInteraction = htmlRequiresInteraction(html);

	return (
		<div className="inno-markdown-html-preview">
			<RestrictedHtmlFrame html={html} title={title} allowScripts={requiresInteraction && interactiveEnabled} />
		</div>
	);
}

function SvgPreviewError({ message }: { message: string }) {
	return (
		<div className="inno-markdown-preview-status inno-markdown-preview-status--error" data-inno-preview-error="svg" role="alert">
			<AlertTriangle className="inno-markdown-preview-status-icon" size={16} strokeWidth={1.8} aria-hidden="true" />
			<span>{message}</span>
		</div>
	);
}

function SvgPreviewFrame({ svg, title, invalidMessage, zoom, pan, onPanChange, isFullscreen = false }: { svg: string | null; title: string; invalidMessage: string; zoom: number; pan: SvgPan; onPanChange: (nextPan: SvgPan) => void; isFullscreen?: boolean }) {
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<{ startX: number; startY: number; origin: SvgPan } | null>(null);

	if (!svg) return <SvgPreviewError message={invalidMessage} />;
	const dimensions = getSvgPreviewDimensions(svg);
	const transform = zoom === 1 && pan.x === 0 && pan.y === 0
		? undefined
		: { transform: pan.x === 0 && pan.y === 0 ? `scale(${zoom})` : `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` };
	const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button === 2) return;
		dragRef.current = { startX: event.clientX, startY: event.clientY, origin: pan };
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDragging(true);
		event.preventDefault();
	};
	const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		onPanChange({
			x: drag.origin.x + event.clientX - drag.startX,
			y: drag.origin.y + event.clientY - drag.startY,
		});
	};
	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
	};
	return (
		<div
			className={`inno-markdown-svg-pan-surface${dragging ? " is-dragging" : ""}`}
			onPointerDown={startDrag}
			onPointerMove={moveDrag}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={() => {
				dragRef.current = null;
				setDragging(false);
			}}
		>
			<div
				className={`inno-markdown-svg-preview${dimensions ? "" : " is-fallback"}`}
				style={dimensions && !isFullscreen ? {
					aspectRatio: String(dimensions.aspectRatio),
					width: `min(100%, ${MAX_INLINE_SVG_WIDTH}px)`,
				} : undefined}
			>
				<RestrictedHtmlFrame
					title={title}
					html={`${SVG_PREVIEW_STYLE}${svg}`}
					className="inno-markdown-svg-preview-frame"
					style={transform}
				/>
			</div>
		</div>
	);
}

export function HtmlArtifactRenderer(props: CustomRendererProps) {
	const { t } = useTranslation();
	const title = extractHtmlTitle(props.code) || t("markdown.htmlPreview", "HTML 预览");
	const [interactiveSource, setInteractiveSource] = useState<string | null>(null);
	return (
		<ArtifactShell
			{...props}
			title={title}
			extension="html"
			mimeType="text/html;charset=utf-8"
			renderToolbarAction={(source) => {
			if (!htmlRequiresInteraction(source)) return null;
			const interactiveEnabled = interactiveSource === source;
			return (
				<ToolbarIconButton
					label={interactiveEnabled ? t("markdown.resetInteractivePreview", "重置交互预览") : t("markdown.enableInteractive", "启用交互预览")}
					title={interactiveEnabled
						? t("markdown.resetInteractivePreviewHint", "点击后停止脚本执行，恢复受限预览")
						: t("markdown.interactivePreviewHint", "点击后将在受限沙盒中启用脚本和交互事件")}
					showLabel
					active={interactiveEnabled}
					onClick={() => setInteractiveSource((current) => current === source ? null : source)}
				>
					{interactiveEnabled ? <RotateCcw size={14} /> : <Play size={14} />}
				</ToolbarIconButton>
			);
		}}
			renderPreview={(source) => <HtmlPreview html={source} title={title} interactiveEnabled={interactiveSource === source} />}
		/>
	);
}

export function SvgArtifactRenderer(props: CustomRendererProps) {
	const { t } = useTranslation();
	const { zoom, pan, onPanChange, renderToolbarAction } = useSvgArtifactControls(props.code, props.isIncomplete);
	const title = t("markdown.svgImage", "SVG 图像");
	const invalidMessage = t("markdown.invalidSvg", "SVG 格式有误");
	const renderSvg = (source: string, isFullscreen: boolean) => <SvgPreviewFrame svg={sanitizeSvgMarkup(source)} title={title} invalidMessage={invalidMessage} zoom={zoom} pan={pan} onPanChange={onPanChange} isFullscreen={isFullscreen} />;
	return <ArtifactShell
		{...props}
		title={title}
		extension="svg"
		mimeType="image/svg+xml;charset=utf-8"
		renderPreview={renderSvg}
		renderToolbarAction={renderToolbarAction}
	/>;
}

function AsyncSvgPreview({
	source,
	title,
	isIncomplete,
	invalidMessage,
	zoom,
	pan,
	onPanChange,
	isFullscreen,
	render,
}: {
	source: string;
	title: string;
	isIncomplete: boolean;
	invalidMessage: string;
	zoom: number;
	pan: SvgPan;
	onPanChange: (nextPan: SvgPan) => void;
	isFullscreen?: boolean;
	render: (source: string, signal: AbortSignal) => Promise<string>;
}) {
	const { t } = useTranslation();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(() => !isIncomplete && source.trim().length > 0);

	useEffect(() => {
		if (isIncomplete || !source.trim()) return;
		const controller = new AbortController();
		setLoading(true);
		setError("");
		render(source, controller.signal)
			.then((value) => {
				if (!controller.signal.aborted) {
					const sanitized = sanitizeSvgMarkup(value);
					setSvg(sanitized);
					if (!sanitized) setError(invalidMessage);
				}
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [isIncomplete, invalidMessage, render, source]);

	if (isIncomplete || loading || (!svg && !error && source.trim().length > 0)) return <div className="inno-markdown-preview-status" role="status">{t("markdown.generatingChart", "正在生成图表…")}</div>;
	if (error) return <SvgPreviewError message={error} />;
	return <SvgPreviewFrame svg={svg} title={title} invalidMessage={invalidMessage} zoom={zoom} pan={pan} onPanChange={onPanChange} isFullscreen={isFullscreen} />;
}

type VizModule = typeof import("@viz-js/viz");
let vizPromise: ReturnType<VizModule["instance"]> | undefined;

async function renderGraphviz(source: string): Promise<string> {
	vizPromise ??= import("@viz-js/viz").then((module) => module.instance());
	const viz = await vizPromise;
	return viz.renderString(source, { format: "svg" });
}

export function GraphvizArtifactRenderer(props: CustomRendererProps) {
	const { t } = useTranslation();
	const { zoom, pan, onPanChange, renderToolbarAction } = useSvgArtifactControls(props.code, props.isIncomplete);
	const title = t("markdown.graphvizChart", "Graphviz 图表");
	const invalidMessage = t("markdown.invalidSvg", "SVG 格式有误");
	const renderer = useCallback((source: string) => renderGraphviz(source), []);
	return (
		<ArtifactShell
			{...props}
			title={title}
			extension="dot"
			renderPreview={(source, isFullscreen) => <AsyncSvgPreview source={source} title={title} isIncomplete={props.isIncomplete} invalidMessage={invalidMessage} zoom={zoom} pan={pan} onPanChange={onPanChange} isFullscreen={isFullscreen} render={renderer} />}
			renderToolbarAction={renderToolbarAction}
		/>
	);
}

const PLANTUML_SERVER = "https://www.plantuml.com/plantuml/svg";

export function PlantUmlArtifactRenderer(props: CustomRendererProps) {
	const { t } = useTranslation();
	const { zoom, pan, onPanChange, renderToolbarAction } = useSvgArtifactControls(props.code, props.isIncomplete);
	const title = t("markdown.plantumlChart", "PlantUML 图表（公共服务渲染）");
	const invalidMessage = t("markdown.invalidSvg", "SVG 格式有误");
	const renderer = useCallback(async (source: string, signal: AbortSignal) => {
		const response = await fetch(`${PLANTUML_SERVER}/${plantumlEncoder.encode(source)}`, { signal });
		if (!response.ok) {
			throw new Error(response.status === 400
				? t("markdown.plantumlSyntaxError", "PlantUML 语法有误，无法生成图表。")
				: t("markdown.plantumlServerError", "PlantUML 服务返回 {{status}}", { status: response.status }));
		}
		return response.text();
	}, [t]);
	return (
		<ArtifactShell
			{...props}
			title={title}
			extension="puml"
			renderPreview={(source, isFullscreen) => <AsyncSvgPreview source={source} title={title} isIncomplete={props.isIncomplete} invalidMessage={invalidMessage} zoom={zoom} pan={pan} onPanChange={onPanChange} isFullscreen={isFullscreen} render={renderer} />}
			renderToolbarAction={renderToolbarAction}
		/>
	);
}

interface EChartsInstance {
	setOption(option: unknown, notMerge?: boolean): void;
	resize(): void;
	dispose(): void;
}

interface ParsedEChartsOption {
	option: unknown | null;
	error: string;
}

const UNSAFE_ECHARTS_URL_RE = /\b(?:https?:|javascript:|data:text\/html)|^\/\//i;

/**
 * Walks a parsed ECharts option and rejects any string that smuggles in an
 * external or script URL. Runs on the decoded values (not the raw JSON text)
 * so `\/` and ` ` escapes cannot bypass the check.
 */
function containsUnsafeUrl(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;
	if (typeof value === "string") return UNSAFE_ECHARTS_URL_RE.test(value);
	if (Array.isArray(value)) return value.some((item) => containsUnsafeUrl(item, depth + 1));
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).some((item) => containsUnsafeUrl(item, depth + 1));
	}
	return false;
}

function parseEChartsOption(source: string, t: ReturnType<typeof useTranslation>["t"]): ParsedEChartsOption {
	if (!source.trim()) return { option: null, error: "" };
	try {
		const option = JSON.parse(source);
		if (!option || typeof option !== "object" || Array.isArray(option)) {
			throw new Error(t("markdown.invalidEchartsJson", "ECharts 配置不是有效 JSON"));
		}
		if (containsUnsafeUrl(option)) {
			throw new Error(t("markdown.unsafeEchartsConfig", "图表配置包含不安全的外部资源地址。"));
		}
		return { option, error: "" };
	} catch (reason) {
		return {
			option: null,
			error: reason instanceof Error ? reason.message : t("markdown.invalidEchartsJson", "ECharts 配置不是有效 JSON"),
		};
	}
}

function EChartsPreview({ source, isIncomplete }: { source: string; isIncomplete: boolean }) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<EChartsInstance | null>(null);
	const parsed = useMemo(() => parseEChartsOption(source, t), [source, t]);
	const [runtimeError, setRuntimeError] = useState("");

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chartRef.current?.resize());
		observer?.observe(host);
		return () => observer?.disconnect();
	}, []);

	useEffect(() => {
		const host = hostRef.current;
		if (isIncomplete || parsed.error || parsed.option === null || !host) {
			chartRef.current?.dispose();
			chartRef.current = null;
			return;
		}

		let cancelled = false;
		setRuntimeError("");
		void import("echarts").then((echarts) => {
			if (cancelled || !hostRef.current) return;
			const chart = chartRef.current ?? (echarts.init(host, undefined, { renderer: "svg" }) as EChartsInstance);
			chartRef.current = chart;
			chart.setOption(parsed.option, true);
		}).catch((reason: unknown) => {
			if (!cancelled) setRuntimeError(reason instanceof Error ? reason.message : String(reason));
		});
		return () => {
			cancelled = true;
		};
	}, [isIncomplete, parsed]);

	useEffect(() => () => {
		chartRef.current?.dispose();
		chartRef.current = null;
	}, []);

	if (isIncomplete) return <div className="inno-markdown-preview-status" role="status">{t("markdown.generatingChart", "正在生成图表…")}</div>;
	return (
		<div className="inno-markdown-echarts-preview">
			<div ref={hostRef} className="inno-markdown-echarts-host" />
			{parsed.error || runtimeError ? <div role="alert" className="inno-markdown-preview-error">{parsed.error || runtimeError}</div> : null}
		</div>
	);
}

export function EChartsArtifactRenderer(props: CustomRendererProps) {
	const { t } = useTranslation();
	return (
		<ArtifactShell
			{...props}
			title={t("markdown.echartsChart", "ECharts 图表")}
			extension="json"
			mimeType="application/json;charset=utf-8"
			renderPreview={(source) => <EChartsPreview source={source} isIncomplete={props.isIncomplete} />}
		/>
	);
}
