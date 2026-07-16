import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Eye, FileEdit, LoaderCircle, Save, Trash2 } from "lucide-react";
import { noteTemplateStore } from "../../stores/note-template-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { MilkdownEditor } from "../notebook/MilkdownEditor.js";

function splitTags(value: string): string[] {
	return value.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
}

function normalizeMarkdown(value: string): string {
	return value.replace(/\r\n/g, "\n").trimEnd();
}

const inputClass = "h-9 w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 text-sm outline-none focus:border-[var(--inno-accent)] focus:ring-2 focus:ring-[var(--inno-accent-soft)]";

export function TemplateEditor() {
	const { t } = useTranslation();
	const [preview, setPreview] = useState(false);
	const acceptInitialEditorSyncRef = useRef(true);
	const state = useStoreSnapshot(noteTemplateStore, () => ({
		selected: noteTemplateStore.selected,
		draft: noteTemplateStore.draft,
		isNew: noteTemplateStore.isNew,
		isDirty: noteTemplateStore.isDirty,
		isSaving: noteTemplateStore.isSaving,
		error: noteTemplateStore.error,
	}));
	const editable = state.isNew || state.selected?.editable === true;
	const title = state.isNew ? t("notes.templates.create", "新建自定义模板") : state.selected?.label;
	const tagsText = useMemo(() => state.draft?.tags.join(", ") ?? "", [state.draft?.tags]);
	useEffect(() => {
		acceptInitialEditorSyncRef.current = true;
	}, [state.selected?.id, state.isNew, preview, editable]);

	if (!state.draft) {
		return <section className="flex min-h-0 items-center justify-center bg-[var(--inno-surface)] text-sm text-[var(--inno-text-muted)]">{t("notes.templates.selectHint", "选择一个模板，或新建自定义模板")}</section>;
	}

	const updateLabel = (label: string) => {
		noteTemplateStore.updateDraft({ label, labelEn: label, defaultTitle: label, defaultTitleEn: label });
	};

	return (
		<section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-surface)]">
			<header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--inno-border)] px-4">
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-sm font-semibold text-[var(--inno-text)]">{title}</h2>
					{!state.isNew && state.selected ? <p className="text-[10px] text-[var(--inno-text-subtle)]">{state.selected.source === "system" ? t("notes.templates.builtIn", "内置模板") : t("notes.templates.custom", "自定义模板")}</p> : null}
				</div>
				{!editable && state.selected ? <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--inno-accent)] px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={state.isSaving} onClick={() => void noteTemplateStore.duplicate(state.selected!.id)}><Copy size={13} />{t("notes.templates.copy", "复制为自定义模板")}</button> : null}
				{editable && !state.isNew && state.selected ? <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50" disabled={state.isSaving} onClick={() => { if (window.confirm(t("notes.templates.deleteConfirm", "确定删除这个模板吗？"))) void noteTemplateStore.remove(state.selected!.id); }}><Trash2 size={13} />{t("common.delete", "删除")}</button> : null}
				{editable ? <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--inno-accent)] px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={state.isSaving || !state.isDirty || !state.draft.id || !state.draft.label || !state.draft.body.trim()} onClick={() => void noteTemplateStore.save()}>{state.isSaving ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />}{state.isNew ? t("common.create", "创建") : t("common.save", "保存")}</button> : null}
			</header>
			{state.error ? <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{state.error}</div> : null}
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-[760px] space-y-5 px-5 py-5">
					{!editable ? <div className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">{t("notes.templates.readOnlyHint", "该模板随应用发布，不能直接修改。复制后即可编辑。")}</div> : null}
					<label className="block space-y-1.5 text-xs text-[var(--inno-text-muted)]">{t("notes.templates.name", "模板名称")}<input className={inputClass} value={state.draft.label} readOnly={!editable} onChange={(event) => updateLabel(event.target.value)} /></label>
					<label className="block space-y-1.5 text-xs text-[var(--inno-text-muted)]">{t("notes.templates.description", "描述")}<textarea className="min-h-20 w-full resize-y rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm text-[var(--inno-text)] outline-none focus:border-[var(--inno-accent)] focus:ring-2 focus:ring-[var(--inno-accent-soft)]" value={state.draft.description} readOnly={!editable} onChange={(event) => noteTemplateStore.updateDraft({ description: event.target.value })} /></label>
					<label className="block space-y-1.5 text-xs text-[var(--inno-text-muted)]">{t("notes.templates.tags", "默认标签")}<input key={`${state.selected?.id ?? "new"}:${tagsText}`} className={inputClass} defaultValue={tagsText} readOnly={!editable} onBlur={(event) => noteTemplateStore.updateDraft({ tags: splitTags(event.target.value) })} placeholder={t("notes.templates.tagsHint", "使用逗号或空格分隔")} /></label>
					<div>
						<div className="mb-2 flex items-center justify-between gap-3">
							<h3 className="text-xs font-medium text-[var(--inno-text-muted)]">{t("notes.templates.markdown", "Markdown 正文")}</h3>
							<div className="inline-flex rounded-md bg-[var(--inno-surface-muted)] p-0.5 text-xs">
								<button type="button" className={`inline-flex items-center gap-1 rounded px-2 py-1 ${!preview ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow-sm" : "text-[var(--inno-text-muted)]"}`} onClick={() => setPreview(false)}><FileEdit size={12} />{t("common.edit", "编辑")}</button>
								<button type="button" className={`inline-flex items-center gap-1 rounded px-2 py-1 ${preview ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow-sm" : "text-[var(--inno-text-muted)]"}`} onClick={() => setPreview(true)}><Eye size={12} />{t("common.preview", "预览")}</button>
							</div>
						</div>
						<div className="h-[420px] overflow-hidden border-y border-[var(--inno-border)]">
							<MilkdownEditor
								key={`${state.selected?.id ?? "new"}:${preview}:${editable}`}
								editorKey={`note-template:${state.selected?.id ?? "new"}`}
								value={state.draft.body}
								readOnly={preview || !editable}
								onChange={(body) => {
									if (!editable) return;
									if (acceptInitialEditorSyncRef.current && !noteTemplateStore.isDirty) {
										acceptInitialEditorSyncRef.current = false;
										noteTemplateStore.syncDraft({ body });
										return;
									}
									acceptInitialEditorSyncRef.current = false;
									if (!noteTemplateStore.isDirty && normalizeMarkdown(body) === normalizeMarkdown(state.draft!.body)) {
										noteTemplateStore.syncDraft({ body });
									} else {
										noteTemplateStore.updateDraft({ body });
									}
								}}
							/>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
