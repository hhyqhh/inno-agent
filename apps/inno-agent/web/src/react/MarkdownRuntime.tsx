import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import remarkAlert from "remark-github-blockquote-alert";
import {
	defaultRehypePlugins,
	defaultRemarkPlugins,
	Streamdown,
	type PluginConfig,
	type StreamdownTranslations,
} from "streamdown";
import { ResilientCodeRenderer, SPECIAL_CODE_RENDERERS } from "./markdown/special-renderers.js";
import { EnhancedTable } from "./markdown/EnhancedTable.js";
import { EnhancedLink } from "./markdown/EnhancedLink.js";
import { STREAMDOWN_ICON_OVERRIDES } from "./markdown/shared.js";
import { settingsStore } from "../stores/settings-store.js";
import { useStoreSnapshot } from "./hooks.js";

export interface MarkdownRuntimeProps {
	content: string;
	streaming?: boolean;
	/** Keep the streaming DOM shape (per-block wrappers) while skipping the
	 *  character animation; used for a turn that just finished rendering so
	 *  swapping to the settled bubble does not relayout the content. */
	animate?: boolean;
	compact?: boolean;
	className?: string;
	mermaidPlugin?: PluginConfig["mermaid"];
}

const BLOCKED_RAW_ELEMENTS = ["script", "iframe", "object", "embed", "form", "input", "button"];
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkAlert];
// Streamdown switches token colors with Tailwind `dark:` classes, which follow
// the OS prefers-color-scheme — but every inno theme is a light palette, so an
// OS in dark mode ends up painting dark-theme (light) token colors on the
// light code-block background and the code is unreadable. Pin both slots to
// the light theme so highlight colors always match the app's light surfaces.
const SHIKI_THEMES: NonNullable<React.ComponentProps<typeof Streamdown>["shikiTheme"]> = ["github-light", "github-light"];

type SanitizeAttribute = string | [string, ...unknown[]];
interface SanitizeSchema {
	tagNames?: string[];
	attributes?: Record<string, SanitizeAttribute[] | undefined>;
	[key: string]: unknown;
}

function mergeUnique<T>(...groups: Array<readonly T[] | undefined>): T[] {
	return Array.from(new Set(groups.flatMap((group) => group ?? [])));
}

interface HastNode {
	type?: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

function headingText(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	return (node.children ?? []).map(headingText).join("");
}

function createHeadingIds(prefix: string) {
	return () => (tree: HastNode) => {
		const seen = new Map<string, number>();
		const visit = (node: HastNode) => {
			if (/^h[1-6]$/.test(node.tagName ?? "")) {
				const base = headingText(node).trim().toLowerCase()
					.normalize("NFKC")
					.replace(/[^\p{L}\p{N}\s_-]/gu, "")
					.replace(/[\s_]+/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "") || "section";
				const count = seen.get(base) ?? 0;
				seen.set(base, count + 1);
				node.properties = { ...(node.properties ?? {}), id: `${prefix}-${base}${count ? `-${count + 1}` : ""}` };
			}
			for (const child of node.children ?? []) visit(child);
		};
		visit(tree);
	};
}

function createRehypePlugins(headingPrefix: string) {
	const defaults = defaultRehypePlugins as Partial<Record<string, unknown>>;
	const sanitize = defaults.sanitize;
	const harden = defaults.harden;
	const headingIds = createHeadingIds(headingPrefix);
	if (!defaults.raw || !Array.isArray(sanitize) || sanitize.length < 2 || !harden) {
		// A streamdown upgrade restructured the default pipeline. Degrade to the
		// stock plugins (losing only the alert/svg schema extensions) instead of
		// throwing during render and blanking every markdown surface.
		console.warn("[inno] Unexpected Streamdown rehype plugin configuration; falling back to defaults");
		return [...Object.values(defaults), headingIds] as NonNullable<React.ComponentProps<typeof Streamdown>["rehypePlugins"]>;
	}

	const [sanitizePlugin, baseSchema] = sanitize as [unknown, SanitizeSchema];
	const [hardenPlugin, hardenOptions] = Array.isArray(harden) ? harden : [harden, undefined];
	const schema: SanitizeSchema = {
		...baseSchema,
		tagNames: mergeUnique(baseSchema.tagNames, ["svg", "path"]),
		attributes: {
			...baseSchema.attributes,
			div: mergeUnique(baseSchema.attributes?.div, [
				["className", "markdown-alert", "markdown-alert-note", "markdown-alert-tip", "markdown-alert-important", "markdown-alert-warning", "markdown-alert-caution"],
				"dir",
			]),
			p: mergeUnique(baseSchema.attributes?.p, [["className", "markdown-alert-title"], "dir"]),
			svg: mergeUnique(baseSchema.attributes?.svg, ["className", "viewBox", "width", "height", "ariaHidden"]),
			path: mergeUnique(baseSchema.attributes?.path, ["d"]),
		},
	};

	return [defaults.raw, [sanitizePlugin, schema], [hardenPlugin, hardenOptions], createHeadingIds(headingPrefix)] as NonNullable<React.ComponentProps<typeof Streamdown>["rehypePlugins"]>;
}

const SPECIAL_LANGUAGES = new Set(SPECIAL_CODE_RENDERERS.flatMap((renderer) => Array.isArray(renderer.language) ? renderer.language : [renderer.language]));
export function isEnhancedCodeLanguage(language: string): boolean {
	return !SPECIAL_LANGUAGES.has(language);
}
const ENHANCED_CODE_LANGUAGES = Array.from(new Set<string>([
	...code.getSupportedLanguages(),
	"",
	"text",
	"plain",
	"plaintext",
	])).filter(isEnhancedCodeLanguage);
const CODE_RENDERERS = [
	...SPECIAL_CODE_RENDERERS,
	{ language: ENHANCED_CODE_LANGUAGES, component: ResilientCodeRenderer },
];
const FULL_CONTROLS = {
	code: { copy: true, download: { filename: "inno-code" }, panZoom: true },
	table: { copy: true, download: { filename: "inno-table" }, fullscreen: true },
	mermaid: { copy: true, download: { filename: "inno-diagram" }, fullscreen: true, panZoom: true },
	image: { download: true },
} as const;
const MARKDOWN_COMPONENTS = { a: EnhancedLink, table: EnhancedTable };
const STREAMING_ANIMATION = {
	animation: "fadeIn",
	duration: 180,
	easing: "ease-out",
	// Provider chunks can contain a full sentence. Animate individual
	// characters so a large final delta still reads as continuous output
	// instead of appearing as one opaque block.
	sep: "char",
	stagger: 18,
	maxBacklogMs: 320,
} as const;
const MERMAID_OPTIONS = {
	config: {
		securityLevel: "strict",
		startOnLoad: false,
		suppressErrorRendering: true,
		fontFamily: "inherit",
	},
} as const;
const MAX_ANIMATED_CONTENT_LENGTH = 64 * 1024;

export function MarkdownRuntime({ content, streaming = false, animate, compact = false, className, mermaidPlugin }: MarkdownRuntimeProps) {
	const { t } = useTranslation();
	const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "") || "md";
	const mathSingleDollar = useStoreSnapshot(settingsStore, () => settingsStore.settings?.ui?.mathSingleDollar === true);
	const math = useMemo(() => createMathPlugin({
		singleDollarTextMath: mathSingleDollar,
		errorColor: "var(--inno-danger)",
	}), [mathSingleDollar]);
	const rehypePlugins = useMemo(() => createRehypePlugins(`inno-${renderId}`), [renderId]);
	const plugins = useMemo<PluginConfig>(() => ({
		code,
		cjk,
		math,
		renderers: CODE_RENDERERS,
		...(mermaidPlugin ? { mermaid: mermaidPlugin } : {}),
	}), [math, mermaidPlugin]);
	const translations = useMemo<Partial<StreamdownTranslations>>(() => ({
		close: t("common.close", "关闭"),
		copied: t("common.copied", "已复制"),
		copyCode: t("markdown.copyCode", "复制代码"),
		copyLink: t("common.copy", "复制链接"),
		copyTable: t("common.copy", "复制表格"),
		copyTableAsCsv: t("markdown.copyTableAsCsv", "复制为 CSV"),
		copyTableAsMarkdown: t("markdown.copyTableAsMarkdown", "复制为 Markdown"),
		copyTableAsTsv: t("markdown.copyTableAsTsv", "复制为 TSV"),
		downloadDiagram: t("markdown.downloadDiagram", "下载图表"),
		downloadFile: t("markdown.downloadCode", "下载代码"),
		downloadImage: t("markdown.downloadImage", "下载图片"),
		downloadTable: t("markdown.downloadTable", "下载表格"),
		openExternalLink: t("markdown.openExternalLink", "打开外部链接"),
		openLink: t("markdown.openLink", "打开链接"),
		viewFullscreen: t("markdown.fullscreen", "全屏查看"),
		exitFullscreen: t("markdown.exitFullscreen", "退出全屏"),
		zoomIn: t("markdown.zoomIn", "放大"),
		zoomOut: t("markdown.zoomOut", "缩小"),
		resetView: t("markdown.resetView", "重置视图"),
	}), [t]);
	const shouldAnimate = (animate ?? streaming) && content.length <= MAX_ANIMATED_CONTENT_LENGTH;
	return (
		<Streamdown
			mode={streaming ? "streaming" : "static"}
			parseIncompleteMarkdown={streaming}
			normalizeHtmlIndentation
			isAnimating={shouldAnimate}
			animated={shouldAnimate ? STREAMING_ANIMATION : false}
			dir="auto"
			plugins={plugins}
			remarkPlugins={REMARK_PLUGINS}
			rehypePlugins={rehypePlugins}
			shikiTheme={SHIKI_THEMES}
			disallowedElements={BLOCKED_RAW_ELEMENTS}
			unwrapDisallowed
			controls={compact ? false : FULL_CONTROLS}
			components={MARKDOWN_COMPONENTS}
			codeBlockMaxHeight={compact ? 260 : 480}
			tableMaxHeight={420}
			lineNumbers={!compact}
			icons={STREAMDOWN_ICON_OVERRIDES}
			translations={translations}
			mermaid={MERMAID_OPTIONS}
			className={`inno-markdown${compact ? " inno-markdown--compact" : ""}${className ? ` ${className}` : ""}`}
		>
			{content}
		</Streamdown>
	);
}
