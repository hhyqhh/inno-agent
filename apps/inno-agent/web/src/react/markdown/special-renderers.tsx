import { Component, lazy, Suspense, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StreamdownContext, type CustomRenderer, type CustomRendererProps } from "streamdown";
import { EnhancedCodeRenderer } from "./EnhancedCodeRenderer.js";
import { markdownMaxHeight } from "./shared.js";

export { EnhancedCodeRenderer };

function lazyRenderer(
	loader: () => Promise<{ default: ComponentType<CustomRendererProps> }>,
	Fallback: ComponentType<CustomRendererProps>,
	LoadingFallback: ComponentType<CustomRendererProps> = Fallback,
): ComponentType<CustomRendererProps> {
	const LazyComponent = lazy(loader);
	return function DeferredArtifactRenderer(props: CustomRendererProps) {
		return (
			<RendererErrorBoundary fallback={<Fallback {...props} />} resetKey={`${props.language}\u0000${props.code}`}>
				<Suspense fallback={<LoadingFallback {...props} />}>
					<LazyComponent {...props} />
				</Suspense>
			</RendererErrorBoundary>
		);
	};
}

/**
 * An optional renderer is allowed to fail without taking down the enclosing
 * Streamdown tree. This matters on a cold history open: a hashed renderer
 * chunk can fail or arrive after the message has already been committed. The
 * outer Markdown boundary can only fall back to the whole source, which makes
 * an otherwise valid HTML/SVG block look as if it vanished.
 */
class RendererErrorBoundary extends Component<{
	fallback: ReactNode;
	resetKey: string;
	children: ReactNode;
}, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		console.error("[inno] Markdown block renderer failed; showing source fallback", error);
	}

	componentDidUpdate(previous: { resetKey: string }) {
		if (this.state.failed && previous.resetKey !== this.props.resetKey) {
			this.setState({ failed: false });
		}
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function CodeRendererFallback({ code, language }: Pick<CustomRendererProps, "code" | "language">) {
	const maxHeight = markdownMaxHeight(useContext(StreamdownContext).codeBlockMaxHeight);
	return (
		<div data-inno-content-block="code" className="inno-markdown-content-block inno-markdown-content-block--code is-loading">
			<div className="inno-markdown-content-header">
				<span className="inno-markdown-content-title">{language || "text"}</span>
			</div>
			<pre className="inno-markdown-code-fallback" style={maxHeight ? { maxHeight } : undefined}>{code}</pre>
		</div>
	);
}

/** Keep a generic code-renderer failure local to its fenced block. A cold
 * highlighter or a renderer hook error must not make the outer Markdown tree
 * fall back to printing the entire message source. */
export function ResilientCodeRenderer(props: CustomRendererProps) {
	return (
		<RendererErrorBoundary
			fallback={<CodeRendererFallback code={props.code} language={props.language} />}
			resetKey={`${props.language}\u0000${props.code}\u0000${props.isIncomplete ? "incomplete" : "complete"}`}
		>
			<EnhancedCodeRenderer {...props} />
		</RendererErrorBoundary>
	);
}

function extractFallbackHtmlTitle(code: string): string {
	return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1]
		?.replace(/<[^>]+>/g, "")
		.trim() ?? "";
}

const ARTIFACT_LOADING_DELAY_MS = 150;

function ArtifactRendererFallback({ code, language, isIncomplete, showSource = true, loadingVisible = true }: CustomRendererProps & { showSource?: boolean; loadingVisible?: boolean }) {
	// Hooks must run unconditionally: when the error boundary shows this
	// fallback, a streaming fence can still flip isIncomplete mid-render, and
	// an early return would change the hook order between commits.
	const { t } = useTranslation();
	if (isIncomplete) return <CodeRendererFallback code={code} language={language} />;
	const normalizedLanguage = language?.toLowerCase() ?? "";
	const title = normalizedLanguage === "html" || normalizedLanguage === "htm"
		? extractFallbackHtmlTitle(code) || t("markdown.htmlPreview", "HTML 预览")
		: normalizedLanguage === "svg"
			? t("markdown.svgImage", "SVG 图像")
			: normalizedLanguage === "dot" || normalizedLanguage === "graphviz"
				? t("markdown.graphvizChart", "Graphviz 图表")
				: normalizedLanguage === "puml" || normalizedLanguage === "plantuml"
					? t("markdown.plantumlChart", "PlantUML 图表（公共服务渲染）")
					: normalizedLanguage === "echarts" || normalizedLanguage === "echart"
						? t("markdown.echartsChart", "ECharts 图表")
						: language || t("markdown.artifact", "Artifact");
	return (
		<div data-inno-content-block="artifact" className="inno-markdown-content-block inno-markdown-content-block--artifact is-loading">
			<div className="inno-markdown-content-header">
				<span className="inno-markdown-content-title">{title}</span>
			</div>
			<div className="inno-markdown-artifact-content">
				<div className="inno-markdown-preview-status" role={loadingVisible ? "status" : undefined} aria-live={loadingVisible ? "polite" : undefined} aria-hidden={loadingVisible ? undefined : true}>{loadingVisible ? t("markdown.loadingPreview", "正在加载预览…") : null}</div>
				{showSource ? <pre className="inno-markdown-artifact-source" data-inno-source-fallback="">{code}</pre> : null}
			</div>
		</div>
	);
}

/** Keep source hidden while the preview chunk is still loading. If the chunk
 * actually fails, RendererErrorBoundary uses ArtifactRendererFallback so the
 * user still has a recoverable source view instead of a blank artifact. */
function ArtifactRendererLoadingFallback(props: CustomRendererProps) {
	const [loadingVisible, setLoadingVisible] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setLoadingVisible(true), ARTIFACT_LOADING_DELAY_MS);
		return () => clearTimeout(timer);
	}, []);
	return <ArtifactRendererFallback {...props} showSource={false} loadingVisible={loadingVisible} />;
}

function MermaidRendererFallback() {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const maxHeight = markdownMaxHeight(streamdownContext.codeBlockMaxHeight);
	return (
		<div data-inno-mermaid-preview="" data-inno-content-block="mermaid" className="inno-markdown-content-block inno-markdown-content-block--mermaid is-loading">
			<div className="inno-markdown-content-header">
				<span className="inno-markdown-content-title">{t("markdown.mermaidLabel", "Mermaid 图表")}</span>
			</div>
			<div data-inno-mermaid-surface="" className="inno-mermaid-surface inno-markdown-mermaid-surface" style={maxHeight ? { maxHeight } : undefined}><div className="inno-mermaid-status" role="status"><span className="inno-mermaid-spinner" aria-hidden="true" />{t("markdown.mermaidLoading", "正在加载图表…")}</div></div>
		</div>
	);
}

/** Error path for a failed Mermaid chunk: show the diagram source in the
 * standard code fallback instead of a spinner that can never resolve. */
function MermaidSourceFallback(props: CustomRendererProps) {
	return <CodeRendererFallback code={props.code} language="mermaid" />;
}

const HtmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.HtmlArtifactRenderer })), ArtifactRendererFallback, ArtifactRendererLoadingFallback);
const SvgArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.SvgArtifactRenderer })), ArtifactRendererFallback, ArtifactRendererLoadingFallback);
const GraphvizArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.GraphvizArtifactRenderer })), ArtifactRendererFallback, ArtifactRendererLoadingFallback);
const PlantUmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.PlantUmlArtifactRenderer })), ArtifactRendererFallback, ArtifactRendererLoadingFallback);
const EChartsArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.EChartsArtifactRenderer })), ArtifactRendererFallback, ArtifactRendererLoadingFallback);
const MermaidArtifactRenderer = lazyRenderer(() => import("./MermaidArtifactRenderer.js").then((module) => ({ default: module.MermaidArtifactRenderer })), MermaidSourceFallback, MermaidRendererFallback);

const ECHARTS_SERIES_TYPES = new Set([
	"bar",
	"boxplot",
	"candlestick",
	"custom",
	"effectscatter",
	"funnel",
	"gauge",
	"graph",
	"heatmap",
	"line",
	"lines",
	"map",
	"parallel",
	"pictorialbar",
	"pie",
	"radar",
	"sankey",
	"scatter",
	"sunburst",
	"themeriver",
	"treemap",
	"tree",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Recognize the strict-JSON form commonly emitted for ECharts options. */
function looksLikeEChartsOption(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const series = value.series;
	const items = Array.isArray(series) ? series : [series];
	return items.some((item) => isRecord(item)
		&& typeof item.type === "string"
		&& ECHARTS_SERIES_TYPES.has(item.type.toLowerCase()));
}

function JsonCodeRenderer(props: CustomRendererProps) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(props.code);
	} catch {
		return <ResilientCodeRenderer {...props} />;
	}
	return looksLikeEChartsOption(parsed)
		? <EChartsArtifactRenderer {...props} />
		: <ResilientCodeRenderer {...props} />;
}

export const SPECIAL_CODE_RENDERERS: CustomRenderer[] = [
	{ language: "mermaid", component: MermaidArtifactRenderer },
	{ language: ["html", "htm"], component: HtmlArtifactRenderer },
	{ language: "svg", component: SvgArtifactRenderer },
	{ language: ["dot", "graphviz"], component: GraphvizArtifactRenderer },
	{ language: ["plantuml", "puml"], component: PlantUmlArtifactRenderer },
	{ language: ["echarts", "echart"], component: EChartsArtifactRenderer },
	{ language: "json", component: JsonCodeRenderer },
];
