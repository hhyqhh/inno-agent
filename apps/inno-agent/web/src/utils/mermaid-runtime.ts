const MERMAID_FENCE_RE = /(?:^|\n)[ \t>]*(?:[*+-][ \t]+|\d{1,9}[.)][ \t]+)?(?:`{3,}|~{3,})[ \t]*mermaid\b/i;

type MermaidMarkdownRuntimeModule = typeof import("../react/MermaidMarkdownRuntime.js");

let mermaidRuntimeModule: MermaidMarkdownRuntimeModule | null = null;
let mermaidRuntimePromise: Promise<MermaidMarkdownRuntimeModule> | null = null;

/** Detects the fenced diagrams handled by the Mermaid markdown runtime. */
export function hasMermaidFence(content: string): boolean {
	return MERMAID_FENCE_RE.test(content);
}

/** Returns the resolved module without causing a render-time suspension. */
export function getMermaidMarkdownRuntime(): MermaidMarkdownRuntimeModule | null {
	return mermaidRuntimeModule;
}

/**
 * Starts the Mermaid runtime load once and shares it with MarkdownArtifact.
 * Keeping this in a small utility lets session hydration wait for the same
 * chunk without pulling the renderer into the initial bundle.
 */
export function preloadMermaidMarkdownRuntime(): Promise<MermaidMarkdownRuntimeModule> {
	mermaidRuntimePromise ??= Promise.all([
		import("../react/MermaidMarkdownRuntime.js"),
		// Resolve the custom toolbar together with the Mermaid runtime so the
		// session never swaps from the stable loading shell to a second fallback.
		import("../react/markdown/MermaidArtifactRenderer.js"),
	]).then(([module]) => {
		mermaidRuntimeModule = module;
		return module;
	});
	return mermaidRuntimePromise;
}
