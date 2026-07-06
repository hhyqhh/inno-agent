import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network, ScrollText, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";
import { notebookStore } from "../stores/notebook-store.js";
import type { WikiPageType } from "../types/wiki.js";
import { useStoreSnapshot } from "./hooks.js";
import { GraphView } from "./notebook/GraphView.js";
import { PageView } from "./notebook/PageView.js";

const FILTER_TYPES: (WikiPageType | "all")[] = ["all", "source-summary", "entity", "concept", "analysis"];

function typeColor(type?: WikiPageType): string {
	switch (type) {
		case "source-summary":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100";
		case "entity":
			return "bg-green-50 text-green-700 ring-1 ring-green-100";
		case "concept":
			return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
		case "analysis":
			return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

export function Notebook({
	onOpenNoteId,
	onOpenNote,
}: {
	onOpenNoteId?: (noteId: string) => void;
	onOpenNote?: (rawPath: string) => void;
}) {
	const { t } = useTranslation();
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const state = useStoreSnapshot(notebookStore, () => ({
		pages: notebookStore.filteredPages,
		filterType: notebookStore.filterType,
		searchQuery: notebookStore.searchQuery,
		view: notebookStore.view,
		currentPagePath: notebookStore.currentPage?.path ?? null,
		selectedNodeId: notebookStore.selectedNodeId,
		isLoadingPages: notebookStore.isLoadingPages,
		isDeletingPage: notebookStore.isDeletingPage,
		deletingPagePath: notebookStore.deletingPagePath,
	}));

	async function handleDelete(path: string, title: string) {
		const ok = window.confirm(t("notebook.delete.confirm", { title }));
		if (!ok) return;
		try {
			await notebookStore.deletePage(path);
		} catch {
			// store logs the error; nothing else to do
		}
	}

	useEffect(() => {
		void notebookStore.loadAll();
	}, []);

	return (
		<div className={`grid h-full min-h-0 gap-3 p-3 transition-[grid-template-columns] duration-200 ${sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}>
			<aside className={`flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] transition-opacity duration-200 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				<div className="border-b border-[var(--inno-border)] p-2">
					<input
						type="text"
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
						placeholder={t("notebook.search") ?? ""}
						value={state.searchQuery}
						onChange={(event) => notebookStore.setSearchQuery(event.target.value)}
					/>
				</div>
				<div className="flex flex-wrap gap-1 border-b border-[var(--inno-border)] px-2 py-2">
					{FILTER_TYPES.map((type) => (
						<button
							key={type}
							className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
								state.filterType === type
									? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100"
									: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
							}`}
							onClick={() => notebookStore.setFilterType(type)}
						>
							{t(`notebook.filter.${type}`)}
						</button>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.pages.length === 0 ? (
						<p className="p-4 text-center text-sm text-[var(--inno-text-muted)]">{t("notebook.noPages")}</p>
					) : null}
					{state.pages.map((page) => {
						const selected = state.currentPagePath === page.path || state.selectedNodeId === page.path;
						const isThisPageDeleting = state.deletingPagePath === page.path;
						const title = page.frontmatter?.title || page.path;
						return (
							<div
								key={page.path}
								className={`group relative border-b border-[var(--inno-border)] transition-colors ${selected ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"}`}
							>
								<button
									className="w-full px-3 py-2 pr-9 text-left text-sm"
									onClick={() => void notebookStore.selectPage(page.path)}
								>
									<div className="truncate font-medium text-[var(--inno-text)]">{title}</div>
									<div className="mt-1 flex items-center gap-1.5">
										<span className={`rounded px-1.5 text-xs ${typeColor(page.frontmatter?.type)}`}>
											{page.frontmatter?.type ? t(`notebook.types.${page.frontmatter.type}`) : t("notebook.types.unknown")}
										</span>
										<span className="truncate text-xs text-[var(--inno-text-muted)]">{page.frontmatter?.updated || ""}</span>
									</div>
								</button>
								<button
									className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-[var(--inno-text-muted)] hover:bg-red-50 hover:text-red-600 disabled:opacity-50 ${isThisPageDeleting ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
									title={t("notebook.delete.button")}
									disabled={state.isDeletingPage}
									onClick={(e) => {
										e.stopPropagation();
										void handleDelete(page.path, title);
									}}
								>
									<Trash2 size={13} />
								</button>
							</div>
						);
					})}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="@container flex items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2">
					<div className="flex items-center gap-2">
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							onClick={() => setSidebarOpen((v) => !v)}
							title={sidebarOpen ? t("common.collapseSidebar", "Collapse sidebar") : t("common.expandSidebar", "Expand sidebar")}
						>
							{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
						</button>
						<div className="inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5 text-xs">
							<button
								className={`inline-flex items-center gap-1 rounded px-3 py-1 ${state.view === "graph" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
								onClick={() => notebookStore.setView("graph")}
								title={t("notebook.view.graph")}
							>
								<Network size={13} />
								<span className="hidden @[680px]:inline">{t("notebook.view.graph")}</span>
							</button>
							<button
								className={`inline-flex items-center gap-1 rounded px-3 py-1 ${state.view === "page" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
								onClick={() => notebookStore.setView("page")}
								title={t("notebook.view.page")}
							>
								<ScrollText size={13} />
								<span className="hidden @[680px]:inline">{t("notebook.view.page")}</span>
							</button>
						</div>
					</div>
					<div className="text-xs text-[var(--inno-text-muted)]">{state.currentPagePath ?? ""}</div>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden">
					{state.view === "graph" ? <GraphView /> : <PageView onOpenNoteId={onOpenNoteId} onOpenNote={onOpenNote} />}
				</div>
			</section>
		</div>
	);
}
