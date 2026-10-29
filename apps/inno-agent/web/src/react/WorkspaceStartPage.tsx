import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, FolderClosed, PencilLine, RefreshCw, Search, Sparkles } from "lucide-react";
import { workspaceStore, previewTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import type { WorkspaceTreeNode } from "../types/workspace.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { kindFromName } from "./chat/smart-input/kinds.js";
import { useStoreSnapshot } from "./hooks.js";
import { Button, IconButton, Input, MenuOption, SegmentedControl } from "./ui/index.js";

const COLLAPSED_COUNT = 6;
const FILE_FILTERS = ["all", "doc", "ppt", "xls", "image"] as const;
type FileFilter = typeof FILE_FILTERS[number];
type FileEvent = "opened" | "modified" | "aiUpdated";
interface StartFile { name: string; path: string; workspaceId: string | null }
interface RecentFile extends StartFile { occurredAt: number; event: FileEvent }

function collectFiles(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
	return nodes.flatMap((node) => node.type === "file" ? [node] : collectFiles(node.children ?? []));
}

/** The start page only projects the existing tab, history and activity owners. */
export function WorkspaceStartPage() {
	const { t, i18n } = useTranslation();
	const listId = useId();
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<"current" | "all">("current");
	const [kind, setKind] = useState<FileFilter>("all");
	const [aiOnly, setAiOnly] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const state = useStoreSnapshot(workspaceStore, () => ({
		tree: workspaceStore.tree, tabs: workspaceStore.previewTabs, recent: workspaceStore.recentFiles,
		workspaceId: workspaceStore.activeWorkspaceId, loading: workspaceStore.isLoadingTree, error: workspaceStore.error,
		activity: workspaceStore.activity, activityError: workspaceStore.activityError,
	}));
	const workspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.workspaces);
	useEffect(() => { void workspaceStore.loadActivity(); }, [state.workspaceId, state.tree]);
	useEffect(() => { setExpanded(false); }, [state.workspaceId, query, scope, kind, aiOnly]);
	const workspaceName = (id: string | null) => id === null ? t("workspace.tempWorkspaceLabel")
		: workspaces.find((item) => item.id === id)?.name
			|| (id === state.workspaceId ? state.tree?.name : null) || t("workspaceStart.currentWorkspace");
	const treeFiles = collectFiles(state.tree?.children ?? []);
	const treeByPath = new Map(treeFiles.map((file) => [file.path, file]));
	const aiByPath = new Map(state.activity.files.filter((file) => treeByPath.has(file.path)).map((file) => [file.path, file.lastSeenAt]));
	const hasAiWrite = (file: StartFile) => file.workspaceId === state.workspaceId && aiByPath.has(file.path);
	const matches = (file: StartFile) => {
		const fileKind = kindFromName(file.name);
		return (scope === "all" || file.workspaceId === state.workspaceId)
			&& (kind === "all" || fileKind === kind || (kind === "doc" && fileKind === "pdf"))
			&& (!aiOnly || hasAiWrite(file))
			&& `${file.name} ${file.path} ${workspaceName(file.workspaceId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
	};
	const allDrafts = state.tabs.filter((tab) => tab.file && tab.isEditing && tab.editBuffer !== (tab.file.content ?? ""))
		.map((tab) => ({ ...tab, workspaceId: tab.workspaceId ?? null }));
	const drafts = allDrafts.filter(matches);
	const draftKeys = new Set(allDrafts.map(previewTabKey));
	// Merge metadata before filtering or folding: the old per-section caps hid
	// matching files, and cross-section deduplication erased their AI provenance.
	const files = new Map<string, RecentFile>();
	const add = (file: StartFile, value: string | number, event: FileEvent) => {
		const occurredAt = typeof value === "number" ? value : Date.parse(value);
		if (!Number.isFinite(new Date(occurredAt).getTime())) return;
		const key = previewTabKey(file);
		const previous = files.get(key);
		if (!previous || occurredAt > previous.occurredAt) files.set(key, { ...file, occurredAt, event });
	};
	for (const file of state.recent) {
		if (!file.workspaceId?.startsWith("channel-") && (file.workspaceId === state.workspaceId || file.workspaceId === null
			|| workspaces.some((workspace) => workspace.id === file.workspaceId))) add(file, file.openedAt, "opened");
	}
	for (const file of treeFiles) {
		const owned = { name: file.name, path: file.path, workspaceId: state.workspaceId };
		if (file.updatedAt) add(owned, file.updatedAt, "modified");
		const aiAt = aiByPath.get(file.path);
		if (aiAt) add(owned, aiAt, "aiUpdated");
	}
	const recent = [...files.values()].filter((file) => !draftKeys.has(previewTabKey(file)) && matches(file))
		.sort((a, b) => b.occurredAt - a.occurredAt || previewTabKey(a).localeCompare(previewTabKey(b)));
	const visible = expanded ? recent : recent.slice(0, COLLAPSED_COUNT);
	const now = new Date();
	const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
	const group = (value: number) => {
		const day = new Date(value).toDateString();
		return day === now.toDateString() ? "today" : day === yesterday.toDateString() ? "yesterday" : "earlier";
	};
	const date = (value: number) => {
		const parsed = new Date(value);
		const text = new Intl.DateTimeFormat(i18n?.language || "zh-CN", group(value) === "today"
			? { hour: "2-digit", minute: "2-digit" }
			: { year: parsed.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "short", day: "numeric" }).format(parsed);
		return <time dateTime={parsed.toISOString()}>{text}</time>;
	};
	// Opening a file navigates the active start tab in place; drafts reactivate
	// their existing tab so the unsaved edit buffer remains owned by the store.
	const row = (file: StartFile, event?: RecentFile) => {
		const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
		const location = [scope === "all" ? workspaceName(file.workspaceId) : "", directory].filter(Boolean).join(" · ");
		return <MenuOption key={previewTabKey(file)} onClick={() => event
			? void workspaceStore.selectFile(file.path, undefined, file.workspaceId, { replaceStartTab: true })
			: workspaceStore.activatePreview(previewTabKey(file))}
			title={`${workspaceName(file.workspaceId)} / ${file.path}`} className="min-h-14 gap-3 px-3 py-2">
			<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--inno-surface-muted)]"><FileTypeIcon kind={kindFromName(file.name)} size={20} /></span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-base">{file.name}</span>
				{location || hasAiWrite(file) ? <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--inno-text-subtle)]">
					{location ? <span className="truncate">{location}</span> : null}
					{hasAiWrite(file) ? <span className="inline-flex shrink-0 items-center gap-1 text-[var(--inno-text-muted)]"><Sparkles size={12} aria-hidden="true" />{t("workspaceStart.aiBadge")}</span> : null}
				</span> : null}
			</span>
			<span className="shrink-0 text-right text-xs text-[var(--inno-text-muted)]">{event
				? <><span className="block">{date(event.occurredAt)}</span><span className="block text-[var(--inno-text-subtle)]">{t(`workspaceStart.${event.event}`)}</span></>
				: <span className="text-[var(--inno-warning)]">{t("workspaceStart.unsavedBadge")}</span>}</span>
		</MenuOption>;
	};
	return (
		<div className="workspace-scroll h-full overflow-y-auto bg-[var(--inno-background)] text-[var(--inno-text)]">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
				<header className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<h2 className="text-lg font-medium">{t("workspaceStart.heading")}</h2>
						<p className="mt-1 flex min-w-0 items-center gap-2 text-sm text-[var(--inno-text-muted)]"><FolderClosed size={14} className="shrink-0" /><span className="truncate">{workspaceName(state.workspaceId)}</span></p>
					</div>
					<IconButton size="sm" aria-label={t("workspaceStart.refresh")} title={t("workspaceStart.refresh")} disabled={state.loading} onClick={() => { void workspaceStore.loadTree(); void workspaceStore.loadActivity(); }}><RefreshCw size={16} className={state.loading ? "animate-spin" : ""} /></IconButton>
				</header>
				<div className="flex flex-col gap-3">
					<div className="relative"><Search size={16} className="inno-ui-input-leading-adornment" /><Input hasLeadingAdornment value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("workspaceStart.search")} placeholder={t("workspaceStart.search")} /></div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<SegmentedControl value={scope} onValueChange={setScope} ariaLabel={t("workspaceStart.scope")} items={[{ value: "current", label: t("workspaceStart.scopeCurrent") }, { value: "all", label: t("workspaceStart.scopeAll") }]} />
						<Button size="xs" variant={aiOnly ? "primary" : "secondary"} aria-pressed={aiOnly} title={t("workspaceStart.aiActivityHint")} onClick={() => setAiOnly(!aiOnly)}><Sparkles size={14} />{t("workspaceStart.aiFilter")}</Button>
					</div>
					<div role="group" aria-label={t("workspaceStart.fileType")} className="flex flex-wrap gap-2">
						{FILE_FILTERS.map((value) => <Button key={value} size="xs" shape="pill" variant={kind === value ? "primary" : "secondary"} aria-pressed={kind === value} onClick={() => setKind(value)}>{t(`workspaceStart.types.${value}`)}</Button>)}
					</div>
				</div>
				{state.error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{t("workspaceStart.loadFailed")}</p> : null}
				{drafts.length ? <section aria-label={t("workspaceStart.unsaved")} className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-2">
					<div className="flex items-center gap-2 px-3 py-2 text-sm font-medium"><PencilLine size={16} className="text-[var(--inno-warning)]" /><h3>{t("workspaceStart.unsaved")}</h3><span className="text-xs text-[var(--inno-text-subtle)]">{drafts.length}</span></div>
					{drafts.map((file) => row(file))}
				</section> : null}
				<section aria-label={t("workspaceStart.recent")}>
					<div className="flex items-center justify-between gap-2 border-b border-[var(--inno-border)] pb-3 text-sm"><h3 className="font-medium">{t("workspaceStart.recent")}</h3><span className="text-xs text-[var(--inno-text-subtle)]">{t("workspaceStart.fileCount", { count: recent.length })}</span></div>
					<div id={listId}>
						{["today", "yesterday", "earlier"].map((key) => {
							const entries = visible.filter((file) => group(file.occurredAt) === key);
							return entries.length ? <div key={key} role="group" aria-label={t(`workspaceStart.${key}`)} className="mt-3"><h4 className="px-3 py-1 text-xs text-[var(--inno-text-subtle)]">{t(`workspaceStart.${key}`)}</h4>{entries.map((file) => row(file, file))}</div> : null;
						})}
					</div>
					{recent.length > COLLAPSED_COUNT ? <div className="mt-3 flex justify-center"><Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{t(expanded ? "workspaceStart.showLess" : "workspaceStart.showMore", { count: recent.length - COLLAPSED_COUNT })}</Button></div> : null}
					{!recent.length && !drafts.length ? <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-[var(--inno-text-muted)]"><FolderClosed size={28} strokeWidth={1.5} className="text-[var(--inno-text-subtle)]" /><p role="status">{t(state.loading ? "workspaceStart.loading" : query.trim() || kind !== "all" || aiOnly ? "workspaceStart.noMatches" : "workspaceStart.empty")}</p></div> : null}
				</section>
				{state.activityError ? <p className="text-xs text-[var(--inno-text-subtle)]">{t("workspaceStart.activityFailed")}</p> : null}
			</div>
		</div>
	);
}
