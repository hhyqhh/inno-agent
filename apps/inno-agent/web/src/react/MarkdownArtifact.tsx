import { Component, lazy, Suspense, useMemo, type ReactNode } from "react";
import { normalizeMarkdownMathForStreamdown } from "../utils/markdown-math.js";
import { settingsStore } from "../stores/settings-store.js";
import { useStoreSnapshot } from "./hooks.js";
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

/** The chat view has no error boundary above it, so a renderer crash (e.g. a
 * streamdown upgrade that changes plugin internals) must degrade to plain
 * text for this message instead of blanking the whole conversation. */
class MarkdownErrorBoundary extends Component<{ content: string; className?: string; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		console.error("[inno] Markdown rendering failed; falling back to plain text", error);
	}

	componentDidUpdate(previous: { content: string }) {
		if (this.state.failed && previous.content !== this.props.content) {
			this.setState({ failed: false });
		}
	}

	render() {
		if (this.state.failed) {
			return (
				<div className={`inno-markdown ${this.props.className ?? ""}`}>
					<pre className="whitespace-pre-wrap break-words font-mono text-xs">{this.props.content}</pre>
				</div>
			);
		}
		return this.props.children;
	}
}

export function MarkdownArtifact({ content, streaming = false, compact = false, className }: MarkdownArtifactProps) {
	const mathSingleDollar = useStoreSnapshot(settingsStore, () => settingsStore.settings?.ui?.mathSingleDollar === true);
	// Match Cherry Studio's long-stream guard: once a live answer is very large,
	// skip whole-document transforms and leave incremental parsing to Streamdown.
	const normalizedContent = useMemo(
		() => streaming && content.length > MAX_STREAMING_TRANSFORM_LENGTH
			? content
			: normalizeMarkdownMathForStreamdown(content, { singleDollar: mathSingleDollar }),
		[content, streaming, mathSingleDollar],
	);
	const runtimeProps: MarkdownRuntimeProps = {
		content: normalizedContent,
		streaming,
		compact,
		className,
	};

	return (
		<MarkdownErrorBoundary content={normalizedContent} className={className}>
			{MERMAID_FENCE_RE.test(normalizedContent) ? (
				<Suspense fallback={<div className={`inno-markdown whitespace-pre-wrap ${className ?? ""}`}>{normalizedContent}</div>}>
					<MermaidMarkdownRuntime {...runtimeProps} />
				</Suspense>
			) : (
				<MarkdownRuntime {...runtimeProps} />
			)}
		</MarkdownErrorBoundary>
	);
}
