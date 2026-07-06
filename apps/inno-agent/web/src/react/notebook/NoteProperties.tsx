import { ChevronRight, CalendarDays, Hash, Tag, Type, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatRecordDateDisplay, parseTagList } from "../../lib/note-frontmatter.js";
import { RecordDatePropertyEditor } from "./RecordDatePropertyEditor.js";

export interface NotePropertiesProps {
	title: string;
	tags: string[];
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
	readOnly,
	uiLanguage,
	onChange,
}: {
	value: string[];
	readOnly: boolean;
	uiLanguage: "zh" | "en";
	onChange: (tags: string[]) => void;
}) {
	const { t } = useTranslation();
	const tags = value;
	const [draft, setDraft] = useState("");

	function commitDraft(raw: string) {
		const nextTags = parseTagList(raw).filter((tag) => !tags.includes(tag));
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
					onChange={(event) => setDraft(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
					onBlur={() => commitDraft(draft)}
				/>
			) : null}
		</div>
	);
}

export function NoteProperties({
	title,
	tags,
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
					<div className="inno-note-properties-preview" aria-hidden="true">
						{recordDate ? (
							<span className="inno-note-properties-date-preview">
								<CalendarDays size={12} />
								{formatRecordDateDisplay(recordDate, uiLanguage)}
							</span>
						) : null}
						{tags.slice(0, 4).map((tag) => (
							<TagPill key={tag} tag={tag} readOnly uiLanguage={uiLanguage} />
						))}
						{tags.length > 4 ? (
							<span className="inno-note-properties-more">+{tags.length - 4}</span>
						) : null}
					</div>
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
