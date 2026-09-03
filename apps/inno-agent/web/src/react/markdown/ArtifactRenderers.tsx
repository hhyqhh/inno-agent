import {
	Check,
	Code2,
	Columns2,
	Copy,
	Download,
	Eye,
	Maximize2,
	Minimize2,
	Pencil,
	RotateCcw,
	Save,
	WrapText,
} from "lucide-react";
import plantumlEncoder from "plantuml-encoder";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { CustomRendererProps } from "streamdown";

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

function sanitizeSvgMarkup(source: string): string {
	if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return "";
	const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
	const root = documentNode.documentElement;
	if (root.localName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) {
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><text x="12" y="42">SVG 内容无效</text></svg>';
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
	return title || "HTML 预览";
}

function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8"): void {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ToolbarButton({
	label,
	active = false,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`inline-flex size-7 items-center justify-center rounded-md border-0 transition-colors ${active ? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"} disabled:cursor-not-allowed disabled:opacity-40`}
		>
			{children}
		</button>
	);
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
				className="h-full min-h-64 w-full resize-none border-0 bg-[var(--inno-surface)] p-3 font-mono text-xs leading-relaxed text-[var(--inno-text)] outline-none"
			/>
		);
	}

	return (
		<pre className={`m-0 max-h-[32rem] min-h-40 overflow-auto bg-[var(--inno-code-bg,var(--inno-surface))] p-3 font-mono text-xs leading-relaxed text-[var(--inno-text)] ${wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
			<code>{source}</code>
		</pre>
	);
}

interface ArtifactShellProps extends CustomRendererProps {
	title: string;
	extension: string;
	mimeType?: string;
	renderPreview: (source: string, fullscreen: boolean) => ReactNode;
}

function ArtifactShell({ code, language, isIncomplete, title, extension, mimeType, renderPreview }: ArtifactShellProps) {
	const [mode, setMode] = useState<ArtifactViewMode>(isIncomplete ? "source" : "preview");
	const [appliedSource, setAppliedSource] = useState(code);
	const [draft, setDraft] = useState(code);
	const [editing, setEditing] = useState(false);
	const [wrapped, setWrapped] = useState(false);
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);

	useEffect(() => {
		if (editing) return;
		setAppliedSource(code);
		setDraft(code);
	}, [code, editing]);

	useEffect(() => {
		if (isIncomplete) setMode("source");
	}, [isIncomplete]);

	useEffect(() => {
		if (!fullscreen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFullscreen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [fullscreen]);

	const currentSource = editing ? draft : appliedSource;
	const canPreview = !isIncomplete && currentSource.trim().length > 0;
	const displayMode = canPreview ? mode : "source";

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(currentSource);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	}, [currentSource]);

	const handleEdit = () => {
		setDraft(appliedSource);
		setEditing(true);
		setMode("source");
	};

	const handleSave = () => {
		setAppliedSource(draft);
		setEditing(false);
		setMode("preview");
	};

	const handleReset = () => {
		setDraft(code);
		setAppliedSource(code);
		setEditing(false);
	};

	const content = (isFullscreen: boolean) => (
		<div className={`${isFullscreen ? "h-full" : "min-h-48 max-h-[34rem]"} min-w-0 overflow-hidden`}>
			{displayMode === "preview" ? renderPreview(currentSource, isFullscreen) : null}
			{displayMode === "source" ? (
				<ArtifactSource source={currentSource} editing={editing} wrapped={wrapped} onChange={setDraft} />
			) : null}
			{displayMode === "split" ? (
				<div className={`${isFullscreen ? "h-full" : "min-h-64"} grid min-w-0 grid-cols-2 divide-x divide-[var(--inno-border)]`}>
					<div className="min-w-0 overflow-auto">{renderPreview(currentSource, isFullscreen)}</div>
					<div className="min-w-0 overflow-auto"><ArtifactSource source={currentSource} editing={editing} wrapped={wrapped} onChange={setDraft} /></div>
				</div>
			) : null}
		</div>
	);

	return (
		<Fragment>
			<div data-inno-artifact={language} className="my-3 min-w-0 overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] shadow-sm">
				<div className="flex min-w-0 items-center gap-2 border-b border-[var(--inno-border)] px-2.5 py-1.5">
					<span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--inno-text)]">{title}</span>
					{isIncomplete ? <span className="mr-1 inline-flex items-center gap-1 text-[11px] text-[var(--inno-text-muted)]"><span className="size-1.5 animate-pulse rounded-full bg-[var(--inno-accent)]" />生成中</span> : null}
					<ToolbarButton label="预览" active={displayMode === "preview"} disabled={!canPreview} onClick={() => setMode("preview")}><Eye size={14} /></ToolbarButton>
					<ToolbarButton label="查看源码" active={displayMode === "source"} onClick={() => setMode("source")}><Code2 size={14} /></ToolbarButton>
					<ToolbarButton label="分屏查看" active={displayMode === "split"} disabled={!canPreview} onClick={() => setMode("split")}><Columns2 size={14} /></ToolbarButton>
					<ToolbarButton label="自动换行" active={wrapped} onClick={() => setWrapped((value) => !value)}><WrapText size={14} /></ToolbarButton>
					{editing ? (
						<ToolbarButton label="应用更改" onClick={handleSave}><Save size={14} /></ToolbarButton>
					) : (
						<ToolbarButton label="编辑副本" disabled={isIncomplete} onClick={handleEdit}><Pencil size={14} /></ToolbarButton>
					)}
					{appliedSource !== code ? <ToolbarButton label="恢复模型原文" onClick={handleReset}><RotateCcw size={14} /></ToolbarButton> : null}
					<ToolbarButton label={copied ? "已复制" : "复制源码"} onClick={() => void handleCopy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</ToolbarButton>
					<ToolbarButton label="下载源码" onClick={() => downloadText(`${safeFilename(title)}.${extension}`, currentSource, mimeType)}><Download size={14} /></ToolbarButton>
					<ToolbarButton label="全屏查看" disabled={!canPreview} onClick={() => setFullscreen(true)}><Maximize2 size={14} /></ToolbarButton>
				</div>
				{content(false)}
			</div>

			{fullscreen && typeof document !== "undefined" ? createPortal(
				<div role="dialog" aria-modal="true" aria-label={`${title} 全屏预览`} className="fixed inset-0 z-[1000] flex flex-col bg-[var(--inno-background)]">
					<div className="flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2">
						<span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--inno-text)]">{title}</span>
						<ToolbarButton label="退出全屏" onClick={() => setFullscreen(false)}><Minimize2 size={16} /></ToolbarButton>
					</div>
					<div className="min-h-0 flex-1 p-3">{content(true)}</div>
				</div>,
				document.body,
			) : null}
		</Fragment>
	);
}

function RestrictedHtmlFrame({ html, title, className = "", allowScripts = false }: { html: string; title: string; className?: string; allowScripts?: boolean }) {
	const srcDoc = useMemo(() => injectRestrictedHead(html, allowScripts ? INTERACTIVE_PREVIEW_CSP : RESTRICTED_PREVIEW_CSP), [allowScripts, html]);
	return (
		<iframe
			title={title}
			sandbox={allowScripts ? "allow-scripts" : ""}
			srcDoc={srcDoc}
			className={`h-full min-h-64 w-full border-0 bg-white ${className}`}
		/>
	);
}

function HtmlPreview({ html, title }: { html: string; title: string }) {
	const requiresInteraction = useMemo(() => htmlRequiresInteraction(html), [html]);
	const [authorized, setAuthorized] = useState(false);

	useEffect(() => setAuthorized(false), [html]);

	return (
		<div className="relative h-full min-h-64">
			<RestrictedHtmlFrame html={html} title={title} allowScripts={requiresInteraction && authorized} />
			{requiresInteraction && !authorized ? (
				<div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-[var(--inno-border)] bg-[var(--inno-surface)]/95 px-3 py-2 text-[11px] text-[var(--inno-text-muted)] backdrop-blur">
					<span>此预览包含脚本或交互事件，当前未执行。</span>
					<button type="button" className="shrink-0 rounded-md bg-[var(--inno-accent)] px-2.5 py-1 font-medium text-white" onClick={() => setAuthorized(true)}>启用交互预览</button>
				</div>
			) : null}
		</div>
	);
}

export function HtmlArtifactRenderer(props: CustomRendererProps) {
	const title = extractHtmlTitle(props.code);
	return (
		<ArtifactShell
			{...props}
			title={title}
			extension="html"
			mimeType="text/html;charset=utf-8"
			renderPreview={(source) => <HtmlPreview html={source} title={title} />}
		/>
	);
}

export function SvgArtifactRenderer(props: CustomRendererProps) {
	const title = "SVG 图像";
	const renderSvg = (source: string) => (
		<RestrictedHtmlFrame
			title={title}
			html={`<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%;height:auto}</style>${sanitizeSvgMarkup(source)}`}
		/>
	);
	return <ArtifactShell {...props} title={title} extension="svg" mimeType="image/svg+xml;charset=utf-8" renderPreview={renderSvg} />;
}

function AsyncSvgPreview({
	source,
	title,
	isIncomplete,
	render,
}: {
	source: string;
	title: string;
	isIncomplete: boolean;
	render: (source: string, signal: AbortSignal) => Promise<string>;
}) {
	const [svg, setSvg] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (isIncomplete || !source.trim()) return;
		const controller = new AbortController();
		setLoading(true);
		setError("");
		render(source, controller.signal)
			.then((value) => {
				if (!controller.signal.aborted) setSvg(sanitizeSvgMarkup(value));
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [isIncomplete, render, source]);

	if (isIncomplete || loading) return <div className="flex min-h-64 items-center justify-center text-sm text-[var(--inno-text-muted)]">正在生成图表…</div>;
	if (error) return <div role="alert" className="m-3 rounded-lg border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] p-3 text-xs text-[var(--inno-danger)]">{error}</div>;
	return <RestrictedHtmlFrame title={title} html={`<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%;height:auto}</style>${svg}`} />;
}

type VizModule = typeof import("@viz-js/viz");
let vizPromise: ReturnType<VizModule["instance"]> | undefined;

async function renderGraphviz(source: string): Promise<string> {
	vizPromise ??= import("@viz-js/viz").then((module) => module.instance());
	const viz = await vizPromise;
	return viz.renderString(source, { format: "svg" });
}

export function GraphvizArtifactRenderer(props: CustomRendererProps) {
	const renderer = useCallback((source: string) => renderGraphviz(source), []);
	return (
		<ArtifactShell
			{...props}
			title="Graphviz 图表"
			extension="dot"
			renderPreview={(source) => <AsyncSvgPreview source={source} title="Graphviz 图表" isIncomplete={props.isIncomplete} render={renderer} />}
		/>
	);
}

const PLANTUML_SERVER = "https://www.plantuml.com/plantuml/svg";

export function PlantUmlArtifactRenderer(props: CustomRendererProps) {
	const renderer = useCallback(async (source: string, signal: AbortSignal) => {
		const response = await fetch(`${PLANTUML_SERVER}/${plantumlEncoder.encode(source)}`, { signal });
		if (!response.ok) throw new Error(response.status === 400 ? "PlantUML 语法有误，无法生成图表。" : `PlantUML 服务返回 ${response.status}`);
		return response.text();
	}, []);
	return (
		<ArtifactShell
			{...props}
			title="PlantUML 图表（公共服务渲染）"
			extension="puml"
			renderPreview={(source) => <AsyncSvgPreview source={source} title="PlantUML 图表" isIncomplete={props.isIncomplete} render={renderer} />}
		/>
	);
}

interface EChartsInstance {
	setOption(option: unknown, notMerge?: boolean): void;
	resize(): void;
	dispose(): void;
}

function EChartsPreview({ source, isIncomplete }: { source: string; isIncomplete: boolean }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<EChartsInstance | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		if (isIncomplete || !source.trim() || !hostRef.current) return;
		let disposed = false;
		let option: unknown;
		try {
			option = JSON.parse(source);
			if (/\b(?:https?:|javascript:|data:text\/html)/i.test(source)) {
				throw new Error("图表配置包含不安全的外部资源地址。");
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "ECharts 配置不是有效 JSON");
			return;
		}

		setError("");
		void import("echarts").then((echarts) => {
			if (disposed || !hostRef.current) return;
			const chart = echarts.init(hostRef.current, undefined, { renderer: "svg" }) as EChartsInstance;
			chartRef.current = chart;
			chart.setOption(option, true);
		});

		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chartRef.current?.resize());
		if (observer && hostRef.current) observer.observe(hostRef.current);
		return () => {
			disposed = true;
			observer?.disconnect();
			chartRef.current?.dispose();
			chartRef.current = null;
		};
	}, [isIncomplete, source]);

	if (isIncomplete) return <div className="flex min-h-64 items-center justify-center text-sm text-[var(--inno-text-muted)]">正在生成图表…</div>;
	return (
		<div className="relative min-h-64 bg-white">
			<div ref={hostRef} className="h-80 w-full" />
			{error ? <div role="alert" className="absolute inset-x-3 top-3 rounded-lg border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] p-3 text-xs text-[var(--inno-danger)]">{error}</div> : null}
		</div>
	);
}

export function EChartsArtifactRenderer(props: CustomRendererProps) {
	return (
		<ArtifactShell
			{...props}
			title="ECharts 图表"
			extension="json"
			mimeType="application/json;charset=utf-8"
			renderPreview={(source) => <EChartsPreview source={source} isIncomplete={props.isIncomplete} />}
		/>
	);
}
