import { useTranslation } from "react-i18next";
import MDEditor from "@uiw/react-md-editor";
import { notebookStore } from "../../stores/notebook-store.js";
import type { WikiPageFrontmatter, WikiPageType } from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { useStoreSnapshot } from "../hooks.js";
import "@earendil-works/pi-web-ui";
import { Spinner } from "../ui/Spinner.js";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

function typeColor(type?: WikiPageType): string {
	switch (type) {
		case "source-summary":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		case "entity":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "concept":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "analysis":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

function FrontmatterHeader({ frontmatter }: { frontmatter: WikiPageFrontmatter }) {
	const { t } = useTranslation();
	const statusColors: Record<string, string> = {
		draft: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
		reviewed: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
		outdated: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
	};
	const confidenceColors: Record<string, string> = {
		low: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
		medium: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
		high: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
	};

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-3">
			<h3 className="mb-1.5 truncate text-base font-medium text-[var(--inno-text)]">{frontmatter.title}</h3>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className={`rounded px-1.5 py-0.5 ${typeColor(frontmatter.type)}`}>{t(`notebook.types.${frontmatter.type}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${statusColors[frontmatter.status] ?? ""}`}>{t(`notebook.status.${frontmatter.status}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${confidenceColors[frontmatter.confidence] ?? ""}`}>{t(`notebook.confidence.${frontmatter.confidence}`)}</span>
				{frontmatter.contested ? <span className="rounded bg-[var(--inno-danger-bg)] px-1.5 py-0.5 text-[var(--inno-danger)]">{t("notebook.contested")}</span> : null}
				<span className="text-[var(--inno-text-muted)]">{frontmatter.updated}</span>
			</div>
			{frontmatter.tags.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1">
					{frontmatter.tags.map((tag) => (
						<span key={tag} className="rounded-full bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">
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
			<div className="flex h-full items-center justify-center bg-[var(--inno-workspace-bg,#fafafa)] text-[var(--inno-text-muted)]">
				<Spinner size={20} />
			</div>
		);
	}
	if (!state.currentPage || !parsed) {
		return <div className="flex h-full items-center justify-center bg-[var(--inno-workspace-bg,#fafafa)] text-sm text-[var(--inno-text-muted)]">{t("notebook.page.empty")}</div>;
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
				<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
					<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => void notebookStore.savePage()}>
						{t("common.save")}
					</button>
					<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => notebookStore.cancelEditing()}>
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
				<markdown-artifact content={normalizeMarkdownMath(parsed.body)} />
			</div>
			<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
				<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => notebookStore.startEditing()}>
					{t("common.edit")}
				</button>
				<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => notebookStore.setView("graph")}>
					{t("notebook.page.backToGraph")}
				</button>
			</div>
		</div>
	);
}
