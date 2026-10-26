import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clock3, FileText, FolderClosed, PencilLine, RefreshCw, Search, Sparkles } from "lucide-react";
import { workspaceStore, previewTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import type { WorkspaceTreeNode } from "../types/workspace.js";
import { useStoreSnapshot } from "./hooks.js";
import { IconButton, Input, MenuOption, SegmentedControl } from "./ui/index.js";

function collectFiles(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
	return nodes.flatMap((node) => node.type === "file" ? [node] : collectFiles(node.children ?? []));
}

interface StartFile { name: string; path: string; workspaceId: string | null }

/** The start page only projects the existing tab, history and activity owners. */
export function WorkspaceStartPage() {
	const { t, i18n } = useTranslation();
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<"current" | "all">("current");
	const state = useStoreSnapshot(workspaceStore, () => ({
		tree: workspaceStore.tree, tabs: workspaceStore.previewTabs, recent: workspaceStore.recentFiles,
		workspaceId: workspaceStore.activeWorkspaceId, loading: workspaceStore.isLoadingTree, error: workspaceStore.error,
		activity: workspaceStore.activity, activityError: workspaceStore.activityError,
	}));
	const workspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.workspaces);
	useEffect(() => { void workspaceStore.loadActivity(); }, [state.workspaceId, state.tree]);
	const workspaceName = (id: string | null) => workspaces.find((item) => item.id === id)?.name
		|| (id === state.workspaceId ? state.tree?.name || t("workspaceStart.currentWorkspace") : t("workspace.tempWorkspaceLabel"));
	const matches = (file: StartFile) => `${file.name} ${file.path} ${workspaceName(file.workspaceId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
	const drafts = state.tabs.filter((tab) => tab.file && tab.isEditing && tab.editBuffer !== (tab.file.content ?? ""))
		.map((tab) => ({ ...tab, workspaceId: tab.workspaceId ?? null })).filter(matches);
	const seen = new Set(drafts.map(previewTabKey));
	const takeUnique = <T extends StartFile,>(files: T[], limit: number): T[] => {
		const result: T[] = [];
		for (const file of files) {
			const key = previewTabKey(file);
			if (seen.has(key) || !matches(file)) continue;
			seen.add(key); result.push(file);
			if (result.length === limit) break;
		}
		return result;
	};
	const history = state.recent.filter((file) => !file.workspaceId?.startsWith("channel-")
		&& (file.workspaceId === state.workspaceId || file.workspaceId === null || workspaces.some((workspace) => workspace.id === file.workspaceId)));
	const recent = takeUnique(history.filter((file) => scope === "all" || file.workspaceId === state.workspaceId), 8);
	const treeFiles = collectFiles(state.tree?.children ?? []);
	const treeByPath = new Map(treeFiles.map((file) => [file.path, file]));
	const activity = takeUnique(state.activity.files.flatMap((entry) => {
		const file = treeByPath.get(entry.path);
		return file ? [{ name: file.name, path: file.path, workspaceId: state.workspaceId, occurredAt: entry.lastSeenAt }] : [];
	}), 5);
	const modified = takeUnique(treeFiles.filter((file) => file.updatedAt && Number.isFinite(Date.parse(file.updatedAt)))
		.sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!))
		.map((file) => ({ name: file.name, path: file.path, workspaceId: state.workspaceId, updatedAt: file.updatedAt! })), 4);
	const date = (value: string | number) => {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) return null;
		const now = new Date();
		const today = parsed.toDateString() === now.toDateString();
		const text = new Intl.DateTimeFormat(i18n?.language || "zh-CN", today
			? { hour: "2-digit", minute: "2-digit" }
			: { year: parsed.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "short", day: "numeric" }).format(parsed);
		return <time dateTime={parsed.toISOString()}>{text}</time>;
	};
	// The start page is rendered for the active start tab; opening a file from
	// it navigates that tab in place instead of appending a new file tab.
	const open = (file: StartFile) => { void workspaceStore.selectFile(file.path, undefined, file.workspaceId, { replaceStartTab: true }); };
	const row = (file: StartFile, trailing: ReactNode, draft = false) => {
		const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : t("workspaceStart.rootFolder");
		const location = file.workspaceId !== state.workspaceId || scope === "all" ? `${workspaceName(file.workspaceId)} · ${directory}` : directory;
		return <MenuOption key={previewTabKey(file)} onClick={() => draft ? workspaceStore.activatePreview(previewTabKey(file)) : open(file)} title={`${workspaceName(file.workspaceId)} / ${file.path}`} className="px-3 py-2">
			<FileText size={16} className="shrink-0 text-[var(--inno-text-muted)]" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm">{file.name}</span>
				<span className="block truncate text-xs text-[var(--inno-text-subtle)]">{location}</span>
			</span>
			<span className="shrink-0 text-xs text-[var(--inno-text-muted)]">{trailing}</span>
		</MenuOption>;
	};
	const section = (title: string, icon: ReactNode, count: number, children: ReactNode, control?: ReactNode) => (
		<section aria-label={title} className="border-t border-[var(--inno-border)] pt-5">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-3">
				<div className="flex items-center gap-2 text-sm text-[var(--inno-text-muted)]">{icon}<h3 className="font-medium">{title}</h3><span className="text-xs text-[var(--inno-text-subtle)]">{count}</span></div>
				{control}
			</div>
			{children}
		</section>
	);
	return (
		<div className="workspace-scroll h-full overflow-y-auto bg-[var(--inno-chat-bg)] text-[var(--inno-text)]">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
				<header>
					<div className="mb-5 flex min-w-0 items-center gap-2 text-xs text-[var(--inno-text-muted)]"><FolderClosed size={14} className="shrink-0" /><span className="truncate">{workspaceName(state.workspaceId)}</span></div>
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-medium">{t("workspaceStart.heading")}</h2>
						<IconButton size="xs" aria-label={t("workspaceStart.refresh")} title={t("workspaceStart.refresh")} disabled={state.loading} onClick={() => { void workspaceStore.loadTree(); void workspaceStore.loadActivity(); }}><RefreshCw size={16} className={state.loading ? "animate-spin" : ""} /></IconButton>
					</div>
					<p className="mt-2 text-sm text-[var(--inno-text-muted)]">{t("workspaceStart.description")}</p>
				</header>
				<div className="relative"><Search size={16} className="inno-ui-input-leading-adornment" /><Input hasLeadingAdornment value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("workspaceStart.search")} placeholder={t("workspaceStart.search")} /></div>
				{state.error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{t("workspaceStart.loadFailed")}</p> : null}
				{drafts.length ? section(t("workspaceStart.unsaved"), <PencilLine size={16} />, drafts.length, drafts.map((tab) => row(tab, <span className="text-[var(--inno-warning)]">{t("files.unsavedChanges")}</span>, true))) : null}
				{history.length ? section(t("workspaceStart.recent"), <Clock3 size={16} />, recent.length,
					recent.length ? recent.map((file) => row(file, date(file.openedAt))) : <p className="px-3 py-3 text-sm text-[var(--inno-text-subtle)]">{t(query.trim() ? "workspaceStart.noMatches" : "workspaceStart.noRecent")}</p>,
					<SegmentedControl value={scope} onValueChange={setScope} ariaLabel={t("workspaceStart.scope")} items={[{ value: "current", label: t("workspaceStart.scopeCurrent") }, { value: "all", label: t("workspaceStart.scopeAll") }]} />) : null}
				{activity.length ? section(t("workspaceStart.aiActivity"), <Sparkles size={16} />, activity.length, <>{activity.map((file) => row(file, date(file.occurredAt)))}<p className="mt-2 px-3 text-xs leading-relaxed text-[var(--inno-text-subtle)]">{t("workspaceStart.aiActivityHint")}</p></>) : null}
				{state.activityError ? <p className="text-xs text-[var(--inno-text-subtle)]">{t("workspaceStart.activityFailed")}</p> : null}
				{modified.length ? section(t("workspaceStart.modified"), <FolderClosed size={16} />, modified.length, modified.map((file) => row(file, date(file.updatedAt)))) : null}
				{!drafts.length && !recent.length && !activity.length && !modified.length ? <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-[var(--inno-text-muted)]"><FolderClosed size={28} strokeWidth={1.5} className="text-[var(--inno-text-subtle)]" /><p role="status">{t(state.loading ? "workspaceStart.loading" : query.trim() ? "workspaceStart.noMatches" : "workspaceStart.empty")}</p></div> : null}
				<footer className="text-xs leading-relaxed text-[var(--inno-text-subtle)]">{t("workspaceStart.hint")}</footer>
			</div>
		</div>
	);
}
