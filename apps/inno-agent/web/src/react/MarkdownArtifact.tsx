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
import { recoverFromDynamicImportError } from "../utils/dynamic-import-recovery.js";

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

const MARKDOWN_RETRY_DELAYS_MS = [0, 100, 300, 1_000] as const;
const REDUNDANT_FENCE_LANGUAGES = new Set([
	"",
	"text",
	"txt",
	"plain",
	"plaintext",
	"markdown",
	"md",
	"mdx",
	"ecmarkdown",
]);
const NESTED_ECHARTS_LANGUAGES = new Set(["echarts", "echart", "json"]);

interface MarkdownFence {
	marker: string;
	info: string;
}

function parseFenceLine(line: string): MarkdownFence | null {
	const match = /^ {0,3}([`~]{3,})([^\r\n]*)$/.exec(line);
	if (!match) return null;
	return { marker: match[1], info: match[2].trim() };
}

function isClosingFence(line: string, openingMarker: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith(openingMarker[0])) return false;
	let markerLength = 0;
	while (markerLength < trimmed.length && trimmed[markerLength] === openingMarker[0]) markerLength += 1;
	return markerLength >= openingMarker.length && trimmed.slice(markerLength).trim().length === 0;
}

/**
 * Models occasionally return a fenced Markdown block inside another generic
 * text fence, for example ````text -> ```json -> ... -> ``` -> ````. The
 * outer fence makes Streamdown treat the inner fence as literal code, so the
 * ECharts renderer never sees the JSON. Unwrap only this exact, unambiguous
 * shape and only for chart-capable inner languages; ordinary Markdown/code
 * examples keep their original semantics.
 */
function unwrapRedundantEChartsFence(source: string): string {
	let current = source;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const lines = current.replace(/\r\n?/g, "\n").split("\n");
		let first = 0;
		while (first < lines.length && !lines[first]!.trim()) first += 1;
		let last = lines.length - 1;
		while (last >= first && !lines[last]!.trim()) last -= 1;
		if (first >= last) return current;

		const outer = parseFenceLine(lines[first]!);
		if (!outer || !REDUNDANT_FENCE_LANGUAGES.has(outer.info.toLowerCase()) || !isClosingFence(lines[last]!, outer.marker)) return current;

		let innerFirst = first + 1;
		while (innerFirst < last && !lines[innerFirst]!.trim()) innerFirst += 1;
		let innerLast = last - 1;
		while (innerLast >= innerFirst && !lines[innerLast]!.trim()) innerLast -= 1;
		if (innerFirst >= innerLast) return current;

		const inner = parseFenceLine(lines[innerFirst]!);
		if (!inner || !NESTED_ECHARTS_LANGUAGES.has(inner.info.toLowerCase())) return current;
		if (isClosingFence(lines[innerLast]!, inner.marker)) {
			current = lines.slice(innerFirst, innerLast + 1).join("\n");
			continue;
		}
		// A same-length wrapper can share its closing line with the inner fence:
		// ```text -> ```json -> ... -> ```. Treat that final line as the inner
		// close too, but only after the outer fence has otherwise matched fully.
		if (!isClosingFence(lines[last]!, inner.marker)) return current;
		current = lines.slice(innerFirst, last + 1).join("\n");
	}
	return current;
}

interface MarkdownErrorBoundaryProps {
	content: string;
	className?: string;
	children: ReactNode;
}

interface MarkdownErrorBoundaryState {
	failed: boolean;
	retryCount: number;
}

/** A markdown failure should be recoverable on a cold start. The first render
 * can race a lazy chunk or a highlighter initialization; showing the whole
 * source immediately makes valid Markdown look broken, and a failed boundary
 * otherwise stays stuck until the message text changes. */
class MarkdownErrorBoundary extends Component<MarkdownErrorBoundaryProps, MarkdownErrorBoundaryState> {
	state: MarkdownErrorBoundaryState = { failed: false, retryCount: 0 };
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		console.error("[inno] Markdown rendering failed; falling back to plain text", error);
		// A stale or unavailable Vite chunk needs a fresh module graph. Reuse the
		// app-wide guarded recovery so this path does not leave the message in a
		// permanent source-only state.
		if (recoverFromDynamicImportError(error)) return;

		const delay = MARKDOWN_RETRY_DELAYS_MS[this.state.retryCount];
		if (delay === undefined) return;
		this.clearRetryTimer();
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.setState((state) => state.failed
				? { failed: false, retryCount: state.retryCount + 1 }
				: null);
		}, delay);
	}

	componentDidUpdate(previous: MarkdownErrorBoundaryProps) {
		if (previous.content === this.props.content) return;
		this.clearRetryTimer();
		if (this.state.failed || this.state.retryCount !== 0) {
			this.setState({ failed: false, retryCount: 0 });
		}
	}

	componentWillUnmount() {
		this.clearRetryTimer();
	}

	private clearRetryTimer() {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	render() {
		if (this.state.failed) {
			const retrying = this.state.retryCount < MARKDOWN_RETRY_DELAYS_MS.length;
			return (
				<div className={`inno-markdown ${this.props.className ?? ""}`} aria-busy={retrying || undefined}>
					{retrying ? (
						<div className="inno-markdown-retry-status" role="status" aria-live="polite">正在恢复 Markdown 渲染…</div>
					) : (
						<pre className="whitespace-pre-wrap break-words font-mono text-xs">{this.props.content}</pre>
					)}
				</div>
			);
		}
		return this.props.children;
	}
}

export function MarkdownArtifact({ content, streaming = false, animate, compact = false, className }: MarkdownArtifactProps) {
	const mathSingleDollar = useStoreSnapshot(settingsStore, () => settingsStore.settings?.ui?.mathSingleDollar === true);
	const unwrappedContent = useMemo(() => unwrapRedundantEChartsFence(content), [content]);
	// Match Cherry Studio's long-stream guard: once a live answer is very large,
	// skip whole-document transforms and leave incremental parsing to Streamdown.
	const normalizedContent = useMemo(
		() => streaming && unwrappedContent.length > MAX_STREAMING_TRANSFORM_LENGTH
			? unwrappedContent
			: normalizeMarkdownMathForStreamdown(unwrappedContent, { singleDollar: mathSingleDollar }),
		[unwrappedContent, streaming, mathSingleDollar],
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
	const resetKey = [
		streaming ? "streaming" : "static",
		compact ? "compact" : "full",
		hasMermaid ? (mermaidRuntime ? "mermaid-ready" : mermaidRuntimeFailed ? "mermaid-failed" : "mermaid-loading") : "plain",
	].join("\u0000");

	return (
		<MarkdownErrorBoundary key={resetKey} content={normalizedContent} className={className}>
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
