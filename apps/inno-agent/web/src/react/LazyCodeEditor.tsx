import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { Extension } from "@codemirror/state";

interface LazyCodeEditorProps {
	value: string;
	lang: string;
	readOnly?: boolean;
	onChange?(value: string): void;
}

const CodeMirror = lazy(() => import("@uiw/react-codemirror"));
const languageCache = new Map<string, Promise<Extension[]>>();

async function loadLanguage(lang: string): Promise<Extension[]> {
	const cached = languageCache.get(lang);
	if (cached) return cached;
	const promise = loadLanguageUncached(lang);
	languageCache.set(lang, promise);
	return promise;
}

async function loadLanguageUncached(lang: string): Promise<Extension[]> {
	switch (lang) {
		case "typescript":
		case "tsx":
			return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true })];
		case "javascript":
		case "jsx":
			return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true })];
		case "python":
			return [(await import("@codemirror/lang-python")).python()];
		case "json":
			return [(await import("@codemirror/lang-json")).json()];
		case "html":
			return [(await import("@codemirror/lang-html")).html()];
		case "css":
		case "scss":
		case "less":
			return [(await import("@codemirror/lang-css")).css()];
		case "xml":
			return [(await import("@codemirror/lang-xml")).xml()];
		case "yaml":
		case "toml":
			return [(await import("@codemirror/lang-yaml")).yaml()];
		case "sql":
			return [(await import("@codemirror/lang-sql")).sql()];
		case "markdown":
			return [(await import("@codemirror/lang-markdown")).markdown()];
		case "java":
		case "kotlin":
			return [(await import("@codemirror/lang-java")).java()];
		case "c":
		case "cpp":
			return [(await import("@codemirror/lang-cpp")).cpp()];
		case "rust":
			return [(await import("@codemirror/lang-rust")).rust()];
		case "go":
			return [(await import("@codemirror/lang-go")).go()];
		default:
			return [];
	}
}

function CodeEditorFallback() {
	return (
		<div className="flex h-full items-center justify-center bg-[var(--inno-surface)] text-xs text-[var(--inno-text-muted)]">
			Loading editor...
		</div>
	);
}

export function LazyCodeEditor({ value, lang, readOnly = false, onChange }: LazyCodeEditorProps) {
	const [extensions, setExtensions] = useState<Extension[]>([]);
	const basicSetup = useMemo(() => ({
		foldGutter: true,
		lineNumbers: true,
		highlightActiveLine: !readOnly,
	}), [readOnly]);
	// 12px strains touch users (and iOS auto-zooms inputs under 16px); coarse
	// pointers get a larger editing font.
	const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

	useEffect(() => {
		let cancelled = false;
		void loadLanguage(lang).then((loaded) => {
			if (!cancelled) setExtensions(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, [lang]);

	return (
		<div className="h-full overflow-hidden">
			<Suspense fallback={<CodeEditorFallback />}>
				<CodeMirror
					value={value}
					height="100%"
					readOnly={readOnly}
					editable={!readOnly}
					extensions={extensions}
					onChange={(next) => onChange?.(next)}
					basicSetup={basicSetup}
					style={{ height: "100%", fontSize: coarsePointer ? "14px" : "12px" }}
				/>
			</Suspense>
		</div>
	);
}
