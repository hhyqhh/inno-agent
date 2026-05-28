import { useTranslation } from "react-i18next";
import { notebookStore } from "../../stores/notebook-store.js";
import { useStoreSnapshot } from "../hooks.js";

export function NodeInspector() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(notebookStore, () => ({
		nodes: notebookStore.nodes,
		selectedNodeId: notebookStore.selectedNodeId,
	}));
	const node = state.nodes.find((n) => n.id === state.selectedNodeId) ?? null;

	if (!node) {
		return (
			<aside className="flex h-full flex-col overflow-y-auto border-l border-slate-200 bg-white p-3 text-sm text-slate-500">
				<div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{t("notebook.inspector.title")}</div>
				<p>{t("notebook.inspector.empty")}</p>
			</aside>
		);
	}
	return (
		<aside className="flex h-full flex-col overflow-y-auto border-l border-slate-200 bg-white p-3">
			<div className="mb-1 truncate text-sm font-medium text-slate-950">{node.title}</div>
			<div className="mb-2 truncate text-xs text-slate-500">{node.id}</div>
			<div className="mb-3 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
				{t(`notebook.types.${node.type}`)}
			</div>
			{node.tags.length > 0 ? (
				<div className="mb-3">
					<div className="mb-1 text-xs font-medium text-slate-500">{t("notebook.inspector.tags")}</div>
					<div className="flex flex-wrap gap-1">
						{node.tags.map((tag) => (
							<span key={tag} className="rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
								#{tag}
							</span>
						))}
					</div>
				</div>
			) : null}
			<button
				className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
				disabled={node.type === "tag"}
				onClick={() => void notebookStore.selectPage(node.id)}
			>
				{t("notebook.inspector.openPage")}
			</button>
		</aside>
	);
}
