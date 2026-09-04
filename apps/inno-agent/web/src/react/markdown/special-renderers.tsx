import { Component, lazy, Suspense, useContext, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StreamdownContext, type CustomRenderer, type CustomRendererProps } from "streamdown";
import { EnhancedCodeRenderer } from "./EnhancedCodeRenderer.js";
import { markdownMaxHeight, markdownToolbarEnabled } from "./shared.js";

export { EnhancedCodeRenderer };

function lazyRenderer(
	loader: () => Promise<{ default: ComponentType<CustomRendererProps> }>,
	Fallback: ComponentType<CustomRendererProps>,
): ComponentType<CustomRendererProps> {
	const Component = lazy(loader);
	return function DeferredArtifactRenderer(props: CustomRendererProps) {
		return (
			<RendererErrorBoundary fallback={<Fallback {...props} />} resetKey={`${props.language}\u0000${props.code}`}>
				<Suspense fallback={<Fallback {...props} />}>
					<Component {...props} />
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

function extractFallbackHtmlTitle(code: string): string {
	return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1]
		?.replace(/<[^>]+>/g, "")
		.trim() ?? "";
}

function ArtifactRendererFallback({ code, language, isIncomplete }: CustomRendererProps) {
	if (isIncomplete) return <CodeRendererFallback code={code} language={language} />;
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "code");
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
				{toolbarEnabled ? <div className="inno-markdown-toolbar" aria-hidden="true"><span className="inno-markdown-toolbar-skeleton" /></div> : null}
			</div>
			<div className="inno-markdown-artifact-content">
				<div className="inno-markdown-preview-status" role="status" aria-live="polite">{t("markdown.loadingPreview", "正在加载预览…")}</div>
				<pre className="inno-markdown-artifact-source" data-inno-source-fallback="">{code}</pre>
			</div>
		</div>
	);
}

function MermaidRendererFallback() {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "mermaid");
	const maxHeight = markdownMaxHeight(streamdownContext.codeBlockMaxHeight);
		return (
			<div data-inno-mermaid-preview="" data-inno-content-block="mermaid" className="inno-markdown-content-block inno-markdown-content-block--mermaid is-loading">
				<div className="inno-markdown-content-header">
					<span className="inno-markdown-content-title">{t("markdown.mermaidLabel", "Mermaid 图表")}</span>
					{toolbarEnabled ? <div className="inno-markdown-toolbar" aria-hidden="true"><span className="inno-markdown-toolbar-skeleton" /></div> : null}
				</div>
				<div data-inno-mermaid-surface="" className="inno-mermaid-surface inno-markdown-mermaid-surface" style={maxHeight ? { maxHeight } : undefined}><div className="inno-mermaid-status" role="status"><span className="inno-mermaid-spinner" aria-hidden="true" />{t("markdown.mermaidLoading", "正在加载图表…")}</div></div>
			</div>
	);
}

const HtmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.HtmlArtifactRenderer })), ArtifactRendererFallback);
const SvgArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.SvgArtifactRenderer })), ArtifactRendererFallback);
const GraphvizArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.GraphvizArtifactRenderer })), ArtifactRendererFallback);
const PlantUmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.PlantUmlArtifactRenderer })), ArtifactRendererFallback);
const EChartsArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.EChartsArtifactRenderer })), ArtifactRendererFallback);
const MermaidArtifactRenderer = lazyRenderer(() => import("./MermaidArtifactRenderer.js").then((module) => ({ default: module.MermaidArtifactRenderer })), MermaidRendererFallback);

export const SPECIAL_CODE_RENDERERS: CustomRenderer[] = [
	{ language: "mermaid", component: MermaidArtifactRenderer },
	{ language: ["html", "htm"], component: HtmlArtifactRenderer },
	{ language: "svg", component: SvgArtifactRenderer },
	{ language: ["dot", "graphviz"], component: GraphvizArtifactRenderer },
	{ language: ["plantuml", "puml"], component: PlantUmlArtifactRenderer },
	{ language: ["echarts", "echart"], component: EChartsArtifactRenderer },
];
