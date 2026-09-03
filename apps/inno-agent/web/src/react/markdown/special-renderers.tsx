import { lazy, Suspense, type ComponentType } from "react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";

function lazyRenderer(
	loader: () => Promise<{ default: ComponentType<CustomRendererProps> }>,
): ComponentType<CustomRendererProps> {
	const Component = lazy(loader);
	return function DeferredArtifactRenderer(props: CustomRendererProps) {
		return (
			<Suspense fallback={<pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3 text-xs">{props.code}</pre>}>
				<Component {...props} />
			</Suspense>
		);
	};
}

const HtmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.HtmlArtifactRenderer })));
const SvgArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.SvgArtifactRenderer })));
const GraphvizArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.GraphvizArtifactRenderer })));
const PlantUmlArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.PlantUmlArtifactRenderer })));
const EChartsArtifactRenderer = lazyRenderer(() => import("./ArtifactRenderers.js").then((module) => ({ default: module.EChartsArtifactRenderer })));
export const EnhancedCodeRenderer = lazyRenderer(() => import("./EnhancedCodeRenderer.js").then((module) => ({ default: module.EnhancedCodeRenderer })));

export const SPECIAL_CODE_RENDERERS: CustomRenderer[] = [
	{ language: ["html", "htm"], component: HtmlArtifactRenderer },
	{ language: "svg", component: SvgArtifactRenderer },
	{ language: ["dot", "graphviz"], component: GraphvizArtifactRenderer },
	{ language: ["plantuml", "puml"], component: PlantUmlArtifactRenderer },
	{ language: ["echarts", "echart"], component: EChartsArtifactRenderer },
];
