import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { PanelRightOpen, PanelRightClose, Columns2, Maximize2, BookOpen, BriefcaseBusiness, FolderKanban, Settings, Sparkles, UserRound, FileStack } from "lucide-react";
import type { RightPanelTab, WorkspaceMode } from "../stores/app-store.js";
import { WorkspaceBrowser } from "./WorkspaceBrowser.js";
import { Notebook } from "./Notebook.js";
import { SourcesPanel } from "./SourcesPanel.js";
import { JobsPanel } from "./JobsPanel.js";
import { LearnerProfilePanel } from "./LearnerProfilePanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { SettingsPanel } from "./SettingsPanel.js";

interface WorkspacePanelProps {
	activeTab: RightPanelTab;
	mode: WorkspaceMode;
	width: number;
	onTabChange(tab: RightPanelTab): void;
	onModeChange(mode: WorkspaceMode): void;
	onWidthChange(width: number): void;
}

const TAB_ORDER: RightPanelTab[] = ["preview", "notebook", "sources", "profile", "jobs", "skills", "settings"];

const TAB_ICONS: Record<RightPanelTab, React.ReactNode> = {
	notebook: <BookOpen size={13} />,
	sources: <FileStack size={13} />,
	preview: <FolderKanban size={13} />,
	profile: <UserRound size={13} />,
	jobs: <BriefcaseBusiness size={13} />,
	skills: <Sparkles size={13} />,
	settings: <Settings size={13} />,
};

function WorkspaceContent({ activeTab }: { activeTab: RightPanelTab }) {
	switch (activeTab) {
		case "notebook":
			return <Notebook />;
		case "sources":
			return <SourcesPanel />;
		case "preview":
			return <WorkspaceBrowser />;
		case "profile":
			return <LearnerProfilePanel />;
		case "skills":
			return <SkillsPanel />;
		case "jobs":
			return <JobsPanel />;
		case "settings":
			return <SettingsPanel />;
	}
}

export function WorkspacePanel({ activeTab, mode, width, onTabChange, onModeChange, onWidthChange }: WorkspacePanelProps) {
	const { t } = useTranslation();
	const [isResizing, setIsResizing] = useState(false);

	useEffect(() => {
		if (!isResizing) return;

		const handlePointerMove = (event: PointerEvent) => {
			onWidthChange(window.innerWidth - event.clientX);
		};
		const handlePointerUp = () => setIsResizing(false);

		document.body.classList.add("workspace-resizing");
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp, { once: true });
		return () => {
			document.body.classList.remove("workspace-resizing");
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
		};
	}, [isResizing, onWidthChange]);

	const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setIsResizing(true);
	}, []);

	if (mode === "collapsed") {
		return (
			<aside className="relative h-full w-0 overflow-visible">
				<button
					className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/90 hover:text-slate-700 hover:shadow-sm"
					title={t("workspace.openWorkspace") ?? ""}
					onClick={() => onModeChange("half")}
				>
					<PanelRightOpen size={16} />
				</button>
			</aside>
		);
	}

	const compact = mode !== "full" && width < 500;

	return (
		<aside className="workspace-panel inno-workspace-scope relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]">
			{mode === "half" || mode === "quarter" ? (
				<button
					className="workspace-resize-handle"
					aria-label={t("workspace.resize") ?? ""}
					title={`${t("workspace.resize")} (${width}px)`}
					onPointerDown={startResize}
				/>
			) : null}

			<div className="flex h-10 items-center gap-1 border-b border-slate-200 bg-[var(--inno-workspace-chrome)] px-2">
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
					{TAB_ORDER.map((tab) => {
						const label = t(`workspace.tabs.${tab}`);
						const isActive = activeTab === tab;
						return (
							<button
								key={tab}
								className={`inno-workspace-tab flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md transition-colors ${compact ? "w-7 justify-center px-0" : "px-2"} ${isActive ? "bg-white font-medium text-blue-700 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:bg-white hover:text-slate-950"}`}
								title={compact ? label : undefined}
								aria-label={compact ? label : undefined}
								onClick={() => onTabChange(tab)}
							>
								{TAB_ICONS[tab]}
								{compact ? null : label}
							</button>
						);
					})}
				</div>
				<div className="ml-1 flex shrink-0 items-center gap-1 border-l border-slate-200 pl-1">
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
						title={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						onClick={() => onModeChange(mode === "full" ? "half" : "full")}
					>
						{mode === "full" ? <Columns2 size={14} /> : <Maximize2 size={14} />}
					</button>
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
						title={t("workspace.collapse") ?? ""}
						onClick={() => onModeChange("collapsed")}
					>
						<PanelRightClose size={14} />
					</button>
				</div>
			</div>

			<div
				className="flex-1 min-h-0 overflow-hidden bg-[var(--inno-workspace-bg)]"
				style={{
					background:
						"linear-gradient(90deg, rgba(37, 99, 235, 0.035) 1px, transparent 1px), linear-gradient(rgba(37, 99, 235, 0.035) 1px, transparent 1px), var(--inno-workspace-bg)",
					backgroundSize: "36px 36px",
				}}
			>
				<AnimatePresence mode="wait">
					<motion.div
						key={activeTab}
						className="h-full"
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: -6 }}
						transition={{ duration: 0.18, ease: "easeOut" }}
					>
						<WorkspaceContent activeTab={activeTab} />
					</motion.div>
				</AnimatePresence>
			</div>
		</aside>
	);
}
