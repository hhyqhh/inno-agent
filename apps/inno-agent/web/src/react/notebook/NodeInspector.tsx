import { useTranslation } from "react-i18next";
import { notebookStore } from "../../stores/notebook-store.js";
import { useStoreSnapshot } from "../hooks.js";

export function NodeInspector() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(notebookStore, () => ({
		nodes: notebookStore.nodes,
		selectedNodeId: notebookStore.selectedNodeId,
		detail: notebookStore.selectedNodeDetail,
		isLoadingDetail: notebookStore.isLoadingNodeDetail,
	}));
	const node = state.nodes.find((n) => n.id === state.selectedNodeId) ?? null;

	function editTags() {
		if (!node || node.type === "tag") return;
		const raw = window.prompt(t("notebook.inspector.editTagsPrompt"), node.tags.join(", "));
		if (raw === null) return;
		const tags = raw.split(/[\s,\uFF0C;\uFF1B\u3001|]+/).map((tag) => tag.trim()).filter(Boolean);
		void notebookStore.updatePageTags(node.id, tags);
	}

	if (!node) {
		return (
			<aside className="flex h-full flex-col overflow-y-auto border-l border-[var(--inno-border)] bg-[var(--inno-surface)] p-3 text-sm text-[var(--inno-text-muted)]">
				<div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--inno-text-muted)]">{t("notebook.inspector.title")}</div>
				<p>{t("notebook.inspector.empty")}</p>
			</aside>
		);
	}
	return (
		<aside className="flex h-full flex-col overflow-y-auto border-l border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
			<div className="mb-1 truncate text-sm font-medium text-[var(--inno-text)]">{node.title}</div>
			<div className="mb-2 truncate text-xs text-[var(--inno-text-muted)]">{node.id}</div>
			<div className="mb-3 inline-block rounded bg-[var(--inno-surface-muted)] px-2 py-0.5 text-xs text-[var(--inno-text-muted)]">
				{t(`notebook.types.${node.type}`)}
			</div>
			<div className="flex gap-2">
				<button
					className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white disabled:opacity-50"
					disabled={node.type === "tag"}
					onClick={() => void notebookStore.selectPage(node.id)}
				>
					{t("notebook.inspector.openPage")}
				</button>
				{node.type !== "tag" ? (
					<button
						className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
						onClick={editTags}
					>
						{t("notebook.inspector.editTags")}
					</button>
				) : (
					<button
						className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
						onClick={() => notebookStore.searchByTag(node.id.slice(4))}
					>
						{t("notebook.inspector.searchTag", "查找标签")}
					</button>
				)}
			</div>
			{state.isLoadingDetail ? (
				<div className="mt-3 text-xs text-[var(--inno-text-muted)]">{t("common.loading")}</div>
			) : null}
			{state.detail?.relatedPages.length ? (
				<div className="mt-4">
					<div className="mb-2 text-xs font-medium text-[var(--inno-text-muted)]">{t("notebook.inspector.relatedPages")}</div>
					<div className="space-y-1">
						{state.detail.relatedPages.map((page) => (
							<button
								key={page.path}
								type="button"
								className="w-full rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5 text-left text-xs hover:bg-slate-200"
								onClick={() => void notebookStore.selectPage(page.path)}
							>
								<div className="truncate font-medium text-[var(--inno-text)]">{page.frontmatter?.title ?? page.path}</div>
								<div className="line-clamp-2 text-[var(--inno-text-muted)]">{page.bodyPreview}</div>
							</button>
						))}
					</div>
				</div>
			) : null}
			{state.detail?.relatedSources.length ? (
				<div className="mt-4">
					<div className="mb-2 text-xs font-medium text-[var(--inno-text-muted)]">{t("notebook.inspector.relatedSources")}</div>
					<div className="space-y-1">
						{state.detail.relatedSources.map((source) => (
							<div key={source.id} className="rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5 text-xs">
								<div className="truncate font-medium text-[var(--inno-text)]">{source.title}</div>
								<div className="truncate text-[var(--inno-text-muted)]">{source.rawPath}</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</aside>
	);
}
