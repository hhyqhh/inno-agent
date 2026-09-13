import { lazy, Suspense, useEffect, useState } from "react";

interface LazyMarkdownEditorProps {
	value: string;
	onChange(value: string): void;
}

const MarkdownEditor = lazy(async () => {
	const [, , mod] = await Promise.all([
		import("@uiw/react-md-editor/markdown-editor.css"),
		import("@uiw/react-markdown-preview/markdown.css"),
		import("@uiw/react-md-editor"),
	]);
	return { default: mod.default };
});

function MarkdownEditorFallback() {
	return (
		<div className="flex h-full items-center justify-center bg-[var(--inno-surface)] text-xs text-[var(--inno-text-muted)]">
			Loading editor...
		</div>
	);
}

export function LazyMarkdownEditor({ value, onChange }: LazyMarkdownEditorProps) {
	// The side-by-side "live" preview is unusable at phone widths; narrow
	// screens default to the edit-only view (the toolbar can still toggle it).
	const [narrow, setNarrow] = useState(
		() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
	);
	useEffect(() => {
		const mql = window.matchMedia("(max-width: 767px)");
		const onChangeMql = (event: MediaQueryListEvent) => setNarrow(event.matches);
		mql.addEventListener("change", onChangeMql);
		return () => mql.removeEventListener("change", onChangeMql);
	}, []);
	return (
		<div className="h-full overflow-hidden" data-color-mode="light">
			<Suspense fallback={<MarkdownEditorFallback />}>
				<MarkdownEditor
					value={value}
					onChange={(next) => onChange(next ?? "")}
					height="100%"
					preview={narrow ? "edit" : "live"}
					visibleDragbar={false}
					style={{ height: "100%" }}
				/>
			</Suspense>
		</div>
	);
}
