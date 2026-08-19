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
		markdownRef.current = valueRef.current;

		let disposed = false;
		const uiLanguage = i18n.language.startsWith("zh") ? "zh" : "en";
		const crepe = new Crepe({
			root,
			defaultValue: valueRef.current,
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
		if (!ready || !crepeRef.current || value === markdownRef.current) {
			return;
		}

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
			{error ? <div className="p-4 text-sm text-red-600">{error}</div> : null}
			{!error && !ready ? (
				<div className="p-4 text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</div>
			) : null}
			<div
				ref={rootRef}
				className="inno-milkdown-editor-root min-h-0 flex-1"
				aria-label={i18n.language.startsWith("zh") ? "Markdown 编辑器" : "Markdown editor"}
			/>
		</div>
	);
}
