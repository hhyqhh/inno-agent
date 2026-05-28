import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network, FileText, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { notebookStore } from "../stores/notebook-store.js";
import type { WikiPageType } from "../types/wiki.js";
import { useStoreSnapshot } from "./hooks.js";
import { GraphView } from "./notebook/GraphView.js";
import { PageView } from "./notebook/PageView.js";

const FILTER_TYPES: (WikiPageType | "all")[] = ["all", "source-summary", "entity", "concept", "analysis"];

function typeColor(type?: WikiPageType): string {
	switch (type) {
		case "source-summary":
			return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
		case "entity":
			return "bg-green-50 text-green-700 ring-1 ring-green-100";
		case "concept":
			return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
		case "analysis":
			return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
		default:
			return "bg-slate-100 text-slate-500";
	}
}

export function Notebook() {
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
	}));

	useEffect(() => {
		void notebookStore.loadAll();
	}, []);

	return (
		<div className={`grid h-full min-h-0 gap-3 p-3 transition-[grid-template-columns] duration-200 ${sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}>
			<aside className={`flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition-opacity duration-200 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				<div className="border-b border-slate-100 p-2">
					<input
						type="text"
						className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
						placeholder={t("notebook.search") ?? ""}
						value={state.searchQuery}
						onChange={(event) => notebookStore.setSearchQuery(event.target.value)}
					/>
				</div>
				<div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 py-2">
					{FILTER_TYPES.map((type) => (
						<button
							key={type}
							className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
								state.filterType === type
									? "bg-blue-50 text-blue-700 ring-1 ring-blue-100"
									: "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-950"
							}`}
							onClick={() => notebookStore.setFilterType(type)}
						>
							{t(`notebook.filter.${type}`)}
						</button>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.pages.length === 0 ? (
						<p className="p-4 text-center text-sm text-slate-500">{t("notebook.noPages")}</p>
					) : null}
					{state.pages.map((page) => {
						const selected = state.currentPagePath === page.path || state.selectedNodeId === page.path;
						return (
							<button
								key={page.path}
								className={`w-full border-b border-slate-100 px-3 py-2 text-left text-sm transition-colors ${selected ? "bg-blue-50" : "hover:bg-slate-50"}`}
								onClick={() => void notebookStore.selectPage(page.path)}
							>
								<div className="truncate font-medium text-slate-950">{page.frontmatter?.title || page.path}</div>
								<div className="mt-1 flex items-center gap-1.5">
									<span className={`rounded px-1.5 text-xs ${typeColor(page.frontmatter?.type)}`}>
										{page.frontmatter?.type ? t(`notebook.types.${page.frontmatter.type}`) : t("notebook.types.unknown")}
									</span>
									<span className="truncate text-xs text-slate-500">{page.frontmatter?.updated || ""}</span>
								</div>
							</button>
						);
					})}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
				<div className="@container flex items-center justify-between border-b border-slate-100 bg-white px-3 py-2">
					<div className="flex items-center gap-2">
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
							onClick={() => setSidebarOpen((v) => !v)}
							title={sidebarOpen ? t("common.collapseSidebar", "Collapse sidebar") : t("common.expandSidebar", "Expand sidebar")}
						>
							{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
						</button>
						<div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
							<button
								className={`inline-flex items-center gap-1 rounded px-3 py-1 ${state.view === "graph" ? "bg-white shadow text-slate-950" : "text-slate-500"}`}
								onClick={() => notebookStore.setView("graph")}
								title={t("notebook.view.graph")}
							>
								<Network size={13} />
								<span className="hidden @[680px]:inline">{t("notebook.view.graph")}</span>
							</button>
							<button
								className={`inline-flex items-center gap-1 rounded px-3 py-1 ${state.view === "page" ? "bg-white shadow text-slate-950" : "text-slate-500"}`}
								onClick={() => notebookStore.setView("page")}
								title={t("notebook.view.page")}
							>
								<FileText size={13} />
								<span className="hidden @[680px]:inline">{t("notebook.view.page")}</span>
							</button>
						</div>
					</div>
					<div className="text-xs text-slate-500">{state.currentPagePath ?? ""}</div>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{state.view === "graph" ? <GraphView /> : <PageView />}
				</div>
			</section>
		</div>
	);
}
