import { useTranslation } from "react-i18next";
import MDEditor from "@uiw/react-md-editor";
import { notebookStore } from "../../stores/notebook-store.js";
import type { WikiPageFrontmatter, WikiPageType } from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { useStoreSnapshot } from "../hooks.js";
import "@earendil-works/pi-web-ui";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

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

function FrontmatterHeader({ frontmatter }: { frontmatter: WikiPageFrontmatter }) {
	const { t } = useTranslation();
	const statusColors: Record<string, string> = {
		draft: "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-100",
		reviewed: "bg-green-50 text-green-700 ring-1 ring-green-100",
		outdated: "bg-red-50 text-red-700 ring-1 ring-red-100",
	};
	const confidenceColors: Record<string, string> = {
		low: "bg-red-50 text-red-700 ring-1 ring-red-100",
		medium: "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-100",
		high: "bg-green-50 text-green-700 ring-1 ring-green-100",
	};

	return (
		<div className="border-b border-slate-200 bg-white px-4 py-3">
			<h3 className="mb-1.5 truncate text-base font-medium text-slate-950">{frontmatter.title}</h3>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className={`rounded px-1.5 py-0.5 ${typeColor(frontmatter.type)}`}>{t(`notebook.types.${frontmatter.type}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${statusColors[frontmatter.status] ?? ""}`}>{t(`notebook.status.${frontmatter.status}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${confidenceColors[frontmatter.confidence] ?? ""}`}>{t(`notebook.confidence.${frontmatter.confidence}`)}</span>
				{frontmatter.contested ? <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700 ring-1 ring-red-100">{t("notebook.contested")}</span> : null}
				<span className="text-slate-500">{frontmatter.updated}</span>
			</div>
			{frontmatter.tags.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1">
					{frontmatter.tags.map((tag) => (
						<span key={tag} className="rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 ring-1 ring-blue-100">
							#{tag}
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

export function PageView() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(notebookStore, () => ({
		currentPage: notebookStore.currentPage,
		isEditing: notebookStore.isEditing,
		isLoading: notebookStore.isLoadingPage,
		editBuffer: notebookStore.editBuffer,
	}));
	const parsed = state.currentPage ? parseFrontmatter(state.currentPage.content) : null;

	if (state.isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-slate-500">
				<span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
			</div>
		);
	}
	if (!state.currentPage || !parsed) {
		return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("notebook.page.empty")}</div>;
	}

	if (state.isEditing) {
		return (
			<div className="flex h-full flex-col" data-color-mode="light">
				{parsed.frontmatter ? <FrontmatterHeader frontmatter={parsed.frontmatter} /> : null}
				<div className="min-h-0 flex-1 overflow-hidden">
					<MDEditor
						value={state.editBuffer}
						onChange={(value) => notebookStore.updateEditBuffer(value ?? "")}
						height="100%"
						preview="live"
						visibleDragbar={false}
						style={{ height: "100%" }}
					/>
				</div>
				<div className="flex gap-2 border-t border-slate-200 p-3">
					<button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800" onClick={() => void notebookStore.savePage()}>
						{t("common.save")}
					</button>
					<button className="rounded-md bg-slate-100 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-200 hover:text-slate-950" onClick={() => notebookStore.cancelEditing()}>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{parsed.frontmatter ? <FrontmatterHeader frontmatter={parsed.frontmatter} /> : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<markdown-artifact content={parsed.body} />
			</div>
			<div className="flex gap-2 border-t border-slate-200 p-3">
				<button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800" onClick={() => notebookStore.startEditing()}>
					{t("common.edit")}
				</button>
				<button className="rounded-md bg-slate-100 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-200 hover:text-slate-950" onClick={() => notebookStore.setView("graph")}>
					{t("notebook.page.backToGraph")}
				</button>
			</div>
		</div>
	);
}
