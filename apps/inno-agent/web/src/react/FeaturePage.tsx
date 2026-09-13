import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useDragDropManager } from "react-dnd";
import type { AppPage } from "../stores/app-store.js";
import { Spinner } from "./ui/Spinner.js";

const Notebook = lazy(() => import("./Notebook.js").then((mod) => ({ default: mod.Notebook })));
const JobsPanel = lazy(() => import("./JobsPanel.js").then((mod) => ({ default: mod.JobsPanel })));
const LearnerProfilePanel = lazy(() => import("./LearnerProfilePanel.js").then((mod) => ({ default: mod.LearnerProfilePanel })));
const SkillsPanel = lazy(() => import("./SkillsPanel.js").then((mod) => ({ default: mod.SkillsPanel })));

export type FeaturePageId = Exclude<AppPage, "chat">;

const PAGE_TITLE_KEYS: Record<FeaturePageId, string> = {
	notebook: "notebook.title",
	skills: "skills.title",
	learner: "profile.title",
	jobs: "jobs.title",
};

function PageFallback() {
	return (
		<div className="flex h-full items-center justify-center">
			<Spinner size={18} className="text-[var(--inno-border-strong)]" />
		</div>
	);
}

function PageContent({ page }: { page: FeaturePageId }) {
	// The app owns one drag-drop context shared by the workbench and the
	// workspace panel, so page transitions never register a second HTML5 backend.
	const dndManager = useDragDropManager();
	switch (page) {
		case "notebook":
			return <Notebook />;
		case "skills":
			return <SkillsPanel dndManager={dndManager} />;
		case "learner":
			return <LearnerProfilePanel />;
		case "jobs":
			return <JobsPanel />;
	}
}

/**
 * Full-width main-area host for the workbench pages (new page-based IA).
 * The panels render inside the same components used by the right panel during
 * the transition; per-page redesign phases restyle them in place.
 */
export function FeaturePage({ page }: { page: FeaturePageId }) {
	const { t } = useTranslation();
	return (
		<div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--inno-background)]">
			<header className="inno-feature-header flex shrink-0 items-center justify-between gap-2 border-b border-[var(--inno-border)] px-5 py-3">
				<h1 className="text-[15px] font-medium text-[var(--inno-text)]">{t(PAGE_TITLE_KEYS[page])}</h1>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Suspense fallback={<PageFallback />}>
					<PageContent page={page} />
				</Suspense>
			</div>
		</div>
	);
}
