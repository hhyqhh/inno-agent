import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { replaceAll } from "@milkdown/kit/utils";
import { AlignLeft, CalendarDays, ChevronRight, Hash, Tag, Type, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
	isRecordDateKey,
	isTagsKey,
	isTitleKey,
	parseEditorFrontmatter,
	parseTagList,
	serializeEditorFrontmatter,
	serializeTagList,
	type EditorFrontmatter,
	type FrontmatterAttribute,
	type ParsedMarkdownFrontmatter,
} from "../lib/km-frontmatter.js";
import "../styles/milkdown-editor.css";

export type NoteUiLanguage = "zh" | "en";

export interface MilkdownMarkdownEditorProps {
	fileKey: string;
	value: string;
	onChange: (value: string) => void;
	readOnly?: boolean;
	uiLanguage?: NoteUiLanguage;
}

function propertyLabel(key: string, uiLanguage: NoteUiLanguage): string {
	if (isTagsKey(key)) return uiLanguage === "en" ? "Tags" : "标签";
	if (isRecordDateKey(key)) return uiLanguage === "en" ? "Record date" : "记录日期";
	if (isTitleKey(key)) return "title";
	return key.trim();
}

function PropertyIcon({ propertyKey }: { propertyKey: string }) {
	if (isTagsKey(propertyKey)) return <Tag size={14} aria-hidden="true" />;
	if (isRecordDateKey(propertyKey)) return <CalendarDays size={14} aria-hidden="true" />;
	if (isTitleKey(propertyKey)) return <Type size={14} aria-hidden="true" />;
	return <AlignLeft size={14} aria-hidden="true" />;
}

function TagsPropertyEditor({
	value,
	readOnly,
	uiLanguage,
	onChange,
}: {
	value: string;
	readOnly: boolean;
	uiLanguage: NoteUiLanguage;
	onChange: (nextValue: string) => void;
}) {
	const tags = parseTagList(value);
	const [draft, setDraft] = useState("");

	function commitDraft(raw: string) {
		const nextTags = parseTagList(raw).filter((tag) => !tags.includes(tag));
		if (nextTags.length === 0) {
			setDraft("");
			return;
		}
		onChange(serializeTagList([...tags, ...nextTags]));
		setDraft("");
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" || event.key === "," || event.key === "，") {
			event.preventDefault();
			commitDraft(draft);
		} else if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
			onChange(serializeTagList(tags.slice(0, -1)));
		}
	}

	return (
		<div className="milkdown-property-tags">
			{tags.map((tag) => (
				<span key={tag} className="milkdown-property-tag-pill">
					<Hash size={11} aria-hidden="true" />
					<span className="milkdown-property-tag-text">{tag}</span>
					{!readOnly ? (
						<button
							type="button"
							className="milkdown-property-tag-remove"
							onClick={() => onChange(serializeTagList(tags.filter((entry) => entry !== tag)))}
							aria-label={uiLanguage === "en" ? `Remove tag ${tag}` : `移除标签 ${tag}`}
						>
							<X size={12} />
						</button>
					) : null}
				</span>
			))}
			{!readOnly ? (
				<input
					className="milkdown-property-tag-input"
					value={draft}
					placeholder={uiLanguage === "en" ? "Add tag" : "添加标签"}
					onChange={(event) => setDraft(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
					onBlur={() => commitDraft(draft)}
				/>
			) : null}
		</div>
	);
}

export function MilkdownMarkdownEditor({
	fileKey,
	value,
	onChange,
	readOnly = false,
	uiLanguage = "zh",
}: MilkdownMarkdownEditorProps) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const crepeRef = useRef<Crepe | null>(null);
	const readyRef = useRef(false);
	const applyingExternalValueRef = useRef(false);
	const initialParsed = parseEditorFrontmatter(value);
	const [frontmatter, setFrontmatter] = useState<ParsedMarkdownFrontmatter & { implicit?: boolean }>(initialParsed);
	const [propertiesExpanded, setPropertiesExpanded] = useState(false);
	const frontmatterRef = useRef(initialParsed);
	const editorMarkdownRef = useRef(initialParsed.body);
	const readOnlyRef = useRef(readOnly);
	const valueRef = useRef(value);
	const onChangeRef = useRef(onChange);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		valueRef.current = value;
		const parsed = parseEditorFrontmatter(value);
		frontmatterRef.current = parsed;
		setFrontmatter(parsed);
		if (!readyRef.current) {
			editorMarkdownRef.current = parsed.body;
		}
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
		setPropertiesExpanded(false);
	}, [fileKey]);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		root.replaceChildren();
		readyRef.current = false;
		setReady(false);
		setError(null);
		const parsed = parseEditorFrontmatter(valueRef.current);
		frontmatterRef.current = parsed;
		setFrontmatter(parsed);
		editorMarkdownRef.current = parsed.body;

		let disposed = false;
		const crepe = new Crepe({
			root,
			defaultValue: parsed.body,
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
				editorMarkdownRef.current = markdown;
				const nextValue = serializeEditorFrontmatter(frontmatterRef.current, markdown);
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
				if (disposed) return;
				setError(
					createError instanceof Error
						? createError.message
						: uiLanguage === "en"
							? "Failed to load editor."
							: "编辑器加载失败。",
				);
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
	}, [fileKey, uiLanguage]);

	useEffect(() => {
		const parsed = parseEditorFrontmatter(value);
		if (!ready || !crepeRef.current || parsed.body === editorMarkdownRef.current) {
			return;
		}
		applyingExternalValueRef.current = true;
		editorMarkdownRef.current = parsed.body;
		try {
			crepeRef.current.editor.action(replaceAll(parsed.body, true));
		} finally {
			applyingExternalValueRef.current = false;
		}
	}, [ready, value]);

	function updateAttribute(index: number, patch: Partial<FrontmatterAttribute>) {
		const nextFrontmatter: EditorFrontmatter = {
			...frontmatterRef.current,
			hasFrontmatter: true,
			implicit: false,
			attributes: frontmatterRef.current.attributes.map((attribute, attributeIndex) =>
				attributeIndex === index ? { ...attribute, ...patch } : attribute,
			),
		};
		frontmatterRef.current = nextFrontmatter;
		setFrontmatter(nextFrontmatter);
		onChangeRef.current(serializeEditorFrontmatter(nextFrontmatter, editorMarkdownRef.current));
	}

	const previewTags = frontmatter.attributes.flatMap((attribute) =>
		isTagsKey(attribute.key) ? parseTagList(attribute.value) : [],
	);

	return (
		<div className="milkdown-editor-shell">
			{error ? <div className="milkdown-editor-loading">{error}</div> : null}
			{!error && !ready ? (
				<div className="milkdown-editor-loading">
					{uiLanguage === "en" ? "Preparing editor..." : "正在准备编辑器..."}
				</div>
			) : null}
			<div className="milkdown-editor-host">
				{frontmatter.attributes.length > 0 ? (
					<section
						className={`milkdown-note-properties ${propertiesExpanded ? "expanded" : "collapsed"}`}
						aria-label={uiLanguage === "en" ? "Note properties" : "笔记属性"}
					>
						<div className="milkdown-note-properties-header">
							<button
								type="button"
								className="milkdown-note-properties-toggle"
								aria-expanded={propertiesExpanded}
								onClick={() => setPropertiesExpanded((current) => !current)}
							>
								<ChevronRight size={15} aria-hidden="true" className="milkdown-note-properties-chevron" />
								<span className="milkdown-note-properties-heading">
									{uiLanguage === "en" ? "Properties" : "笔记属性"}
								</span>
								<span className="milkdown-note-properties-count">{frontmatter.attributes.length}</span>
							</button>
						</div>
						{propertiesExpanded ? (
							<div className="milkdown-note-properties-body">
								{frontmatter.attributes.map((attribute, index) => (
									<div className="milkdown-property-row" key={`${attribute.key}-${index}`}>
										<div className="milkdown-property-label">
											<PropertyIcon propertyKey={attribute.key} />
											<span>{propertyLabel(attribute.key, uiLanguage)}</span>
										</div>
										<div className="milkdown-property-value">
											{isTagsKey(attribute.key) ? (
												<TagsPropertyEditor
													value={attribute.value}
													readOnly={readOnly}
													uiLanguage={uiLanguage}
													onChange={(nextValue) => updateAttribute(index, { value: nextValue })}
												/>
											) : (
												<input
													className="milkdown-property-inline-input"
													value={attribute.value}
													readOnly={readOnly}
													placeholder={uiLanguage === "en" ? "Empty" : "空"}
													onChange={(event) => updateAttribute(index, { value: event.currentTarget.value })}
												/>
											)}
										</div>
									</div>
								))}
							</div>
						) : null}
						{!propertiesExpanded && previewTags.length > 0 ? (
							<div className="milkdown-note-properties-preview">
								{previewTags.slice(0, 4).map((tag) => (
									<span key={tag} className="milkdown-property-tag-pill">
										<Hash size={11} aria-hidden="true" />
										<span className="milkdown-property-tag-text">{tag}</span>
									</span>
								))}
							</div>
						) : null}
					</section>
				) : null}
				<div ref={rootRef} className="milkdown-editor-root" />
			</div>
		</div>
	);
}
