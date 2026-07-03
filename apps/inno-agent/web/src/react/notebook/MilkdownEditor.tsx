import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { replaceAll } from "@milkdown/kit/utils";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface MilkdownEditorProps {
	value: string;
	onChange: (markdown: string) => void;
	editorKey?: string;
	readOnly?: boolean;
}

function splitMarkdownFrontmatter(markdown: string): { frontmatter: string; body: string } {
	const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	if (!match) {
		return { frontmatter: "", body: markdown };
	}
	return {
		frontmatter: match[0].endsWith("\n") ? match[0] : `${match[0]}\n`,
		body: markdown.slice(match[0].length),
	};
}

export function MilkdownEditor({ value, onChange, editorKey, readOnly = false }: MilkdownEditorProps) {
	const { i18n, t } = useTranslation();
	const rootRef = useRef<HTMLDivElement>(null);
	const crepeRef = useRef<Crepe | null>(null);
	const readyRef = useRef(false);
	const applyingExternalValueRef = useRef(false);
	const valueRef = useRef(value);
	const onChangeRef = useRef(onChange);
	const markdownRef = useRef(value);
	const readOnlyRef = useRef(readOnly);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		valueRef.current = value;
	}, [value]);

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		readOnlyRef.current = readOnly;
		if (readyRef.current) {
			crepeRef.current?.setReadonly(readOnly);
		}
	}, [readOnly]);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}

		root.replaceChildren();
		readyRef.current = false;
		setReady(false);
		setError(null);
		markdownRef.current = splitMarkdownFrontmatter(valueRef.current).body;

		let disposed = false;
		const uiLanguage = i18n.language.startsWith("zh") ? "zh" : "en";
		const initial = splitMarkdownFrontmatter(valueRef.current);
		const crepe = new Crepe({
			root,
			defaultValue: initial.body,
			features: {
				[Crepe.Feature.TopBar]: true,
			},
			featureConfigs: {
				[Crepe.Feature.Placeholder]: {
					text: uiLanguage === "en" ? "Start writing..." : "开始输入内容...",
					mode: "block",
				},
			},
		});

		crepeRef.current = crepe;
		crepe.setReadonly(readOnlyRef.current);
		crepe.on((listener) => {
			listener.markdownUpdated((_, markdown) => {
				markdownRef.current = markdown;
				const frontmatter = splitMarkdownFrontmatter(valueRef.current).frontmatter;
				const nextValue = frontmatter ? `${frontmatter}${markdown}` : markdown;
				if (!applyingExternalValueRef.current && nextValue !== valueRef.current) {
					onChangeRef.current(nextValue);
				}
			});
		});

		void crepe
			.create()
			.then(() => {
				if (disposed) {
					void crepe.destroy();
					return;
				}
				readyRef.current = true;
				setReady(true);
				crepe.setReadonly(readOnlyRef.current);
			})
			.catch((createError) => {
				if (disposed) {
					return;
				}
				setError(createError instanceof Error ? createError.message : t("common.error"));
			});

		return () => {
			disposed = true;
			readyRef.current = false;
			if (crepeRef.current === crepe) {
				crepeRef.current = null;
			}
			void crepe.destroy();
			root.replaceChildren();
		};
	}, [editorKey, i18n.language, t]);

	useEffect(() => {
		const nextBody = splitMarkdownFrontmatter(value).body;
		if (!ready || !crepeRef.current || nextBody === markdownRef.current) {
			return;
		}

		applyingExternalValueRef.current = true;
		markdownRef.current = nextBody;
		try {
			crepeRef.current.editor.action(replaceAll(nextBody, true));
		} finally {
			applyingExternalValueRef.current = false;
		}
	}, [ready, value]);

	return (
		<div className="inno-milkdown-editor flex min-h-0 flex-1 flex-col">
			{error ? (
				<div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
					{t("common.error")}: {error}
					<span className="ml-2 text-red-500">已切换到 Markdown 源码模式。</span>
				</div>
			) : null}
			{!error && !ready ? (
				<div className="p-4 text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</div>
			) : null}
			{error ? (
				<textarea
					className="min-h-0 flex-1 resize-none border-0 bg-[var(--inno-surface)] p-4 font-mono text-sm leading-relaxed text-[var(--inno-text)] outline-none"
					value={value}
					readOnly={readOnly}
					onChange={(event) => onChange(event.target.value)}
					aria-label={i18n.language.startsWith("zh") ? "Markdown 源码编辑器" : "Markdown source editor"}
				/>
			) : (
				<div
					ref={rootRef}
					className="inno-milkdown-editor-root min-h-0 flex-1"
					aria-label={i18n.language.startsWith("zh") ? "Markdown 编辑器" : "Markdown editor"}
				/>
			)}
		</div>
	);
}
