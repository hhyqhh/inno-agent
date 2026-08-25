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
		if (readyRef.current) crepeRef.current?.setReadonly(readOnly);
	}, [readOnly]);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		root.replaceChildren();
		readyRef.current = false;
		setReady(false);
		setError(null);
		markdownRef.current = valueRef.current;

		let disposed = false;
		const isChinese = i18n.language.startsWith("zh");
		const crepe = new Crepe({
			root,
			defaultValue: valueRef.current,
			features: {
				[Crepe.Feature.TopBar]: true,
			},
			featureConfigs: {
				[Crepe.Feature.Placeholder]: {
					text: isChinese ? "开始输入内容..." : "Start writing...",
					mode: "block",
				},
			},
		});

		crepeRef.current = crepe;
		crepe.setReadonly(readOnlyRef.current);
		crepe.on((listener) => {
			listener.markdownUpdated((_, markdown) => {
				markdownRef.current = markdown;
				if (!applyingExternalValueRef.current && markdown !== valueRef.current) {
					onChangeRef.current(markdown);
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
				if (!disposed) {
					setError(createError instanceof Error ? createError.message : t("common.error"));
				}
			});

		return () => {
			disposed = true;
			readyRef.current = false;
			if (crepeRef.current === crepe) crepeRef.current = null;
			void crepe.destroy();
			root.replaceChildren();
		};
	}, [editorKey, i18n.language, t]);

	useEffect(() => {
		if (!ready || !crepeRef.current || value === markdownRef.current) return;

		applyingExternalValueRef.current = true;
		markdownRef.current = value;
		try {
			crepeRef.current.editor.action(replaceAll(value, true));
		} finally {
			applyingExternalValueRef.current = false;
		}
	}, [ready, value]);

	return (
		<div className="inno-milkdown-editor flex min-h-0 flex-1 flex-col">
			{error ? (
				<div className="border-b border-[var(--inno-danger)]/20 bg-[var(--inno-danger-bg)] px-4 py-2 text-xs text-[var(--inno-danger)]">
					{t("common.error")}: {error}. {t("notes.editorFallback")}
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
					aria-label={t("notes.sourceEditorLabel")}
				/>
			) : (
				<div ref={rootRef} className="inno-milkdown-editor-root min-h-0 flex-1" aria-label={t("notes.editorLabel")} />
			)}
		</div>
	);
}
