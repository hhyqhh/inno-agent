import { lazy, Suspense, useMemo } from "react";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { MarkdownRuntime, type MarkdownRuntimeProps } from "./MarkdownRuntime.js";

export interface MarkdownArtifactProps {
	content: string;
	/** Enables Streamdown's incomplete-markdown repair and streaming caret. */
	streaming?: boolean;
	/** Compact surfaces (thinking/question cards) hide heavy block controls. */
	compact?: boolean;
	className?: string;
}

const MERMAID_FENCE_RE = /(?:^|\n)[ \t>]*(?:[*+-][ \t]+|\d{1,9}[.)][ \t]+)?(?:`{3,}|~{3,})[ \t]*mermaid\b/i;
const MAX_STREAMING_TRANSFORM_LENGTH = 256 * 1024;

// Mermaid adds a sizeable parser. Only fetch it for replies that actually
// contain a Mermaid fence; ordinary chat stays on the small runtime.
const MermaidMarkdownRuntime = lazy(() => import("./MermaidMarkdownRuntime.js"));

export function MarkdownArtifact({ content, streaming = false, compact = false, className }: MarkdownArtifactProps) {
	// Match Cherry Studio's long-stream guard: once a live answer is very large,
	// skip whole-document transforms and leave incremental parsing to Streamdown.
	const normalizedContent = useMemo(
		() => streaming && content.length > MAX_STREAMING_TRANSFORM_LENGTH ? content : normalizeMarkdownMath(content),
		[content, streaming],
	);
	const runtimeProps: MarkdownRuntimeProps = {
		content: normalizedContent,
		streaming,
		compact,
		className,
	};

	if (MERMAID_FENCE_RE.test(normalizedContent)) {
		return (
			<Suspense fallback={<div className={`inno-markdown whitespace-pre-wrap ${className ?? ""}`}>{normalizedContent}</div>}>
				<MermaidMarkdownRuntime {...runtimeProps} />
			</Suspense>
		);
	}

	return <MarkdownRuntime {...runtimeProps} />;
}
