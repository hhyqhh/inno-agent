import { ChevronRight, CalendarDays, Hash, Tag, Type, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatRecordDateDisplay, parseTagList } from "../../lib/note-frontmatter.js";
import { RecordDatePropertyEditor } from "./RecordDatePropertyEditor.js";

export interface NotePropertiesProps {
	title: string;
	tags: string[];
	availableTags?: string[];
	recordDate: string;
	readOnly?: boolean;
	editorKey?: string;
	onTitleChange: (title: string) => void;
	onTagsChange: (tags: string[]) => void;
	onRecordDateChange: (recordDate: string) => void;
}
function TagPill({
	tag,
	readOnly,
	uiLanguage,
	onRemove,
}: {
	tag: string;
	readOnly: boolean;
	uiLanguage: "zh" | "en";
	onRemove?: () => void;
}) {
	return (
		<span className="inno-note-property-tag-pill">
			<Hash size={11} aria-hidden="true" />
			<span className="inno-note-property-tag-text">{tag}</span>
			{!readOnly && onRemove ? (
				<button
					type="button"
					className="inno-note-property-tag-remove"
					onClick={onRemove}
					aria-label={uiLanguage === "en" ? `Remove tag ${tag}` : `移除标签 ${tag}`}
				>
					<X size={12} />
				</button>
			) : null}
		</span>
	);
}

function TagsPropertyEditor({
	value,
	availableTags,
	readOnly,
	uiLanguage,
	onChange,
}: {
	value: string[];
	availableTags: string[];
	readOnly: boolean;
	uiLanguage: "zh" | "en";
	onChange: (tags: string[]) => void;
}) {
	const { t } = useTranslation();
	const tags = value;
	const [draft, setDraft] = useState("");
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const selectedKeys = new Set(tags.map((tag) => tag.trim().toLowerCase()));
	const query = draft.trim().toLowerCase();
	const suggestions = availableTags
		.filter((tag) => !selectedKeys.has(tag.trim().toLowerCase()))
		.filter((tag) => !query || tag.toLowerCase().includes(query))
		.slice(0, 8);

	function commitDraft(raw: string) {
		const nextTags = parseTagList(raw).filter((tag) => !selectedKeys.has(tag.trim().toLowerCase()));
		if (nextTags.length === 0) {
			setDraft("");
			return;
		}
		onChange([...tags, ...nextTags]);
		setDraft("");
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" || /^[\s,\uFF0C;\uFF1B\u3001|]$/.test(event.key)) {
			event.preventDefault();
			commitDraft(draft);
		} else if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
			onChange(tags.slice(0, -1));
		}
	}

	return (
		<div className="inno-note-property-tags">
			{tags.map((tag) => (
				<TagPill
					key={tag}
					tag={tag}
					readOnly={readOnly}
					uiLanguage={uiLanguage}
					onRemove={() => onChange(tags.filter((entry) => entry !== tag))}
				/>
			))}
			{!readOnly ? (
				<input
					className="inno-note-property-tag-input"
					value={draft}
					placeholder={t("notes.properties.addTag")}
					aria-label={t("notes.properties.addTag")}
					onChange={(event) => {
						setDraft(event.currentTarget.value);
						setSuggestionsOpen(true);
					}}
					onFocus={() => setSuggestionsOpen(true)}
					onKeyDown={handleKeyDown}
					onBlur={() => {
						commitDraft(draft);
						setSuggestionsOpen(false);
					}}
				/>
			) : null}
			{!readOnly && suggestionsOpen && suggestions.length > 0 ? (
				<div className="inno-note-property-tag-suggestions" role="listbox" aria-label={t("notes.properties.existingTags")}>
					<div className="inno-note-property-tag-suggestions-label">{t("notes.properties.existingTags")}</div>
					{suggestions.map((tag) => (
						<button
							key={tag}
							type="button"
							className="inno-note-property-tag-suggestion"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								onChange([...tags, tag]);
								setDraft("");
							}}
						>
							<Hash size={11} aria-hidden="true" />
							<span>{tag}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function NotePropertiesPreview({
	tags,
	recordDate,
	uiLanguage,
}: {
	tags: string[];
	recordDate: string;
	uiLanguage: "zh" | "en";
}) {
	const previewRef = useRef<HTMLDivElement>(null);
	const dateMeasureRef = useRef<HTMLSpanElement>(null);
	const moreMeasureRef = useRef<HTMLSpanElement>(null);
	const tagMeasureRefs = useRef<Array<HTMLSpanElement | null>>([]);
	const [visibleTagCount, setVisibleTagCount] = useState(0);
	const formattedDate = recordDate ? formatRecordDateDisplay(recordDate, uiLanguage) : "";

	useLayoutEffect(() => {
		const preview = previewRef.current;
		if (!preview) return;

		const updateVisibleTagCount = () => {
			const gap = Number.parseFloat(getComputedStyle(preview).columnGap) || 0;
			const availableWidth = preview.clientWidth;
			let usedWidth = formattedDate ? (dateMeasureRef.current?.offsetWidth ?? 0) : 0;
			let nextVisibleCount = 0;
			const moreWidth = moreMeasureRef.current?.offsetWidth ?? 0;

			for (let index = 0; index < tags.length; index += 1) {
				const tagWidth = tagMeasureRefs.current[index]?.offsetWidth ?? 0;
				const widthWithTag = usedWidth + (usedWidth > 0 ? gap : 0) + tagWidth;
				const hasHiddenTags = index < tags.length - 1;
				const requiredWidth = widthWithTag + (hasHiddenTags ? gap + moreWidth : 0);
				if (requiredWidth > availableWidth) break;
				usedWidth = widthWithTag;
				nextVisibleCount = index + 1;
			}

			setVisibleTagCount((current) => current === nextVisibleCount ? current : nextVisibleCount);
		};

		updateVisibleTagCount();
		const resizeObserver = new ResizeObserver(updateVisibleTagCount);
		resizeObserver.observe(preview);
		return () => resizeObserver.disconnect();
	}, [formattedDate, tags]);

	const hiddenTagCount = tags.length - visibleTagCount;

	return (
		<div ref={previewRef} className="inno-note-properties-preview" aria-hidden="true">
			{formattedDate ? (
				<span className="inno-note-properties-date-preview">
					<CalendarDays size={12} />
					{formattedDate}
				</span>
			) : null}
			{tags.slice(0, visibleTagCount).map((tag) => (
				<TagPill key={tag} tag={tag} readOnly uiLanguage={uiLanguage} />
			))}
			{hiddenTagCount > 0 ? (
				<span className="inno-note-properties-more">+{hiddenTagCount}</span>
			) : null}
			<div className="inno-note-properties-preview-measure">
				{formattedDate ? (
					<span ref={dateMeasureRef} className="inno-note-properties-date-preview">
						<CalendarDays size={12} />
						{formattedDate}
					</span>
				) : null}
				{tags.map((tag, index) => (
					<span key={tag} ref={(element) => { tagMeasureRefs.current[index] = element; }}>
						<TagPill tag={tag} readOnly uiLanguage={uiLanguage} />
					</span>
				))}
				<span ref={moreMeasureRef} className="inno-note-properties-more">+{tags.length}</span>
			</div>
		</div>
	);
}

export function NoteProperties({
	title,
	tags,
	availableTags = [],
	recordDate,
	readOnly = false,
	editorKey,
	onTitleChange,
	onTagsChange,
	onRecordDateChange,
}: NotePropertiesProps) {
	const { t, i18n } = useTranslation();
	const uiLanguage = i18n.language.startsWith("zh") ? "zh" : "en";
	const [expanded, setExpanded] = useState(false);
	const propertyCount = 3;
	useEffect(() => {
		setExpanded(false);
	}, [editorKey]);

	return (
		<section
			className={`inno-note-properties ${expanded ? "expanded" : "collapsed"}`}
			aria-label={t("notes.properties.heading")}
		>
			<div className="inno-note-properties-header">
				<button
					type="button"
					className="inno-note-properties-toggle"
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
				>
					<ChevronRight size={15} aria-hidden="true" className="inno-note-properties-chevron" />
					<span className="inno-note-properties-heading">{t("notes.properties.heading")}</span>
					<span className="inno-note-properties-count">{propertyCount}</span>
				</button>
				{!expanded ? (
					<NotePropertiesPreview tags={tags} recordDate={recordDate} uiLanguage={uiLanguage} />
				) : null}
			</div>
			{expanded ? (
				<div className="inno-note-properties-body">
					<div className="inno-note-property-row">
						<div className="inno-note-property-label">
							<Type size={14} aria-hidden="true" />
							<span>{t("notes.properties.title")}</span>
						</div>
						<div className="inno-note-property-value">
							<input
								className="inno-note-property-inline-input"
								value={title}
								readOnly={readOnly}
								placeholder={t("notes.titlePlaceholder") ?? ""}
								aria-label={t("notes.properties.title")}
								onChange={(event) => onTitleChange(event.currentTarget.value)}
							/>
						</div>
					</div>
					<div className="inno-note-property-row">
						<div className="inno-note-property-label">
							<CalendarDays size={14} aria-hidden="true" />
							<span>{t("notes.properties.recordDateKey")}</span>
						</div>
						<div className="inno-note-property-value">
							<RecordDatePropertyEditor
								value={recordDate}
								readOnly={readOnly}
								uiLanguage={uiLanguage}
								onChange={onRecordDateChange}
							/>
						</div>
					</div>
					<div className="inno-note-property-row">
						<div className="inno-note-property-label">
							<Tag size={14} aria-hidden="true" />
							<span>{t("notes.properties.tags")}</span>
						</div>
						<div className="inno-note-property-value">
							<TagsPropertyEditor
								value={tags}
								availableTags={availableTags}
								readOnly={readOnly}
								uiLanguage={uiLanguage}
								onChange={onTagsChange}
							/>
						</div>
					</div>
				</div>
			) : null}
		</section>
	);
}
