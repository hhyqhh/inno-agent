import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, LayoutTemplate, LoaderCircle, Plus, Search } from "lucide-react";
import { noteTemplateStore } from "../../stores/note-template-store.js";
import { useStoreSnapshot } from "../hooks.js";

export function TemplateSidebar({ viewSelector, onBack }: { viewSelector?: ReactNode; onBack(): void }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(noteTemplateStore, () => ({
		templates: noteTemplateStore.filteredTemplates,
		selectedId: noteTemplateStore.selectedId,
		query: noteTemplateStore.query,
		isLoading: noteTemplateStore.isLoading,
	}));
	const custom = state.templates.filter((template) => template.source === "custom");
	const system = state.templates.filter((template) => template.source === "system");

	const group = (label: string, templates: typeof state.templates) => (
		<div className="py-1">
			<div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--inno-text-subtle)]">{label}</div>
			{templates.map((template) => (
				<button key={template.id} type="button" className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-sm transition-colors ${state.selectedId === template.id ? "border-l-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-l-transparent text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]"}`} onClick={() => noteTemplateStore.select(template.id)}>
					<LayoutTemplate size={14} className="shrink-0" />
					<span className="min-w-0 flex-1 truncate">{template.label}</span>
					{template.hidden ? <span className="text-[9px] text-[var(--inno-text-subtle)]">{t("notes.templates.hidden", "隐藏")}</span> : null}
				</button>
			))}
		</div>
	);

	return (
		<aside className="flex min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)]">
			<div className="space-y-2 border-b border-[var(--inno-border)] p-3">
				{viewSelector}
				<div className="flex items-center justify-between gap-2">
					<button type="button" className="inline-flex items-center gap-1 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]" onClick={onBack}><ArrowLeft size={13} />{t("notes.templates.back", "返回资料")}</button>
					<button type="button" className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--inno-accent)] px-2 text-xs font-medium text-white hover:opacity-90" onClick={() => noteTemplateStore.startCreate()}><Plus size={13} />{t("common.new", "新建")}</button>
				</div>
				<div className="relative">
					<Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)]" />
					<input className="h-8 w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] pl-8 pr-2 text-xs outline-none focus:border-[var(--inno-accent)] focus:ring-2 focus:ring-[var(--inno-accent-soft)]" value={state.query} onChange={(event) => noteTemplateStore.setQuery(event.target.value)} placeholder={t("notes.templates.search", "搜索模板…")} />
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{state.isLoading ? <div className="flex items-center gap-2 p-4 text-xs text-[var(--inno-text-muted)]"><LoaderCircle size={13} className="animate-spin" />{t("common.loading")}</div> : null}
				{group(t("notes.templates.mine", "我的模板"), custom)}
				{group(t("notes.templates.system", "内置模板"), system)}
			</div>
		</aside>
	);
}
