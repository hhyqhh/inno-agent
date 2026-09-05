import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { normalizeMarkdownMathForStreamdown } from "../utils/markdown-math.js";
import {
	getMermaidMarkdownRuntime,
	hasMermaidFence,
	preloadMermaidMarkdownRuntime,
} from "../utils/mermaid-runtime.js";
import { settingsStore } from "../stores/settings-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { MarkdownRuntime, type MarkdownRuntimeProps } from "./MarkdownRuntime.js";

export interface MarkdownArtifactProps {
	content: string;
	/** Enables Streamdown's incomplete-markdown repair and streaming caret. */
	streaming?: boolean;
	/** Overrides the character animation while keeping the streaming DOM shape. */
	animate?: boolean;
	/** Compact surfaces (thinking/question cards) hide heavy block controls. */
	compact?: boolean;
	className?: string;
}

const MAX_STREAMING_TRANSFORM_LENGTH = 256 * 1024;

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

export function MarkdownArtifact({ content, streaming = false, animate, compact = false, className }: MarkdownArtifactProps) {
	const mathSingleDollar = useStoreSnapshot(settingsStore, () => settingsStore.settings?.ui?.mathSingleDollar === true);
	// Match Cherry Studio's long-stream guard: once a live answer is very large,
	// skip whole-document transforms and leave incremental parsing to Streamdown.
	const normalizedContent = useMemo(
		() => streaming && content.length > MAX_STREAMING_TRANSFORM_LENGTH
			? content
			: normalizeMarkdownMathForStreamdown(content, { singleDollar: mathSingleDollar }),
		[content, streaming, mathSingleDollar],
	);
	const hasMermaid = hasMermaidFence(normalizedContent);
	const [mermaidRuntime, setMermaidRuntime] = useState(getMermaidMarkdownRuntime);
	const [mermaidRuntimeFailed, setMermaidRuntimeFailed] = useState(false);
	useEffect(() => {
		if (!hasMermaid || mermaidRuntime || mermaidRuntimeFailed) return;
		let active = true;
		void preloadMermaidMarkdownRuntime()
			.then((module) => {
				if (active) setMermaidRuntime(module);
			})
			.catch(() => {
				if (active) setMermaidRuntimeFailed(true);
			});
		return () => {
			active = false;
		};
	}, [hasMermaid, mermaidRuntime, mermaidRuntimeFailed]);
	const MermaidMarkdownRuntime = mermaidRuntime?.default;
	const runtimeProps: MarkdownRuntimeProps = {
		content: normalizedContent,
		streaming,
		...(animate === undefined ? {} : { animate }),
		compact,
		className,
	};

	return (
		<MarkdownErrorBoundary content={normalizedContent} className={className}>
			{hasMermaid ? (
				// Reserve the diagram height only in full mode; compact surfaces
				// (thinking cards) must stay as short as their content.
				<div className={`inno-mermaid-frame w-full${compact ? "" : " min-h-[288px]"}`}>
					{MermaidMarkdownRuntime ? (
						<MermaidMarkdownRuntime {...runtimeProps} />
					) : mermaidRuntimeFailed ? (
						<MarkdownRuntime {...runtimeProps} />
					) : (
						<div className="inno-mermaid-suspense-placeholder" aria-hidden="true" />
					)}
				</div>
			) : (
				<MarkdownRuntime {...runtimeProps} />
			)}
		</MarkdownErrorBoundary>
	);
}
