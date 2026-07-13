import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import {
	PanelLeftOpen,
	PanelLeftClose,
	Plus,
	RefreshCw,
	Sparkles,
	Pencil,
	Trash2,
	Archive,
	ArchiveRestore,
	Download,
	ChevronRight,
	Search,
	X,
	FolderKanban,
} from "lucide-react";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import type { WorkspaceMeta } from "../api/workspaces.js";
import { triggerDownload } from "../api/workspace.js";
import type { SessionChannel, SessionMeta } from "../api/sessions.js";
import { useStoreSnapshot } from "./hooks.js";
import { Spinner } from "./ui/Spinner.js";

interface SessionSidebarProps {
	collapsed: boolean;
}

const CHANNEL_FILTER_ORDER = ["web", "feishu", "wechat", "cli", "scheduler"] as const;

/* ── helpers ── */

function formatTime(iso: string): string {
	try {
		const d = new Date(iso);
		const now = new Date();
		const isToday = d.toDateString() === now.toDateString();
		if (isToday) {
			return d.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		}
		return d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return iso;
	}
}

function channelLabel(channel: SessionChannel): string {
	const labels: Record<string, string> = {
		cli: "CLI",
		web: "Web",
		feishu: "Feishu",
		scheduler: "Job",
		qq: "QQ",
		wechat: "WeChat",
		unknown: "?",
	};
	return labels[channel] ?? channel;
}

function channelClass(channel: SessionChannel): string {
	const classes: Record<string, string> = {
		cli: "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]",
		web: "bg-[var(--inno-surface-muted)] text-[var(--inno-text)]",
		feishu: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
		scheduler: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)] ring-1 ring-[var(--inno-warning-border)]/60",
		qq: "bg-cyan-50 text-cyan-600 ring-1 ring-cyan-200/60",
		wechat: "bg-lime-50 text-lime-600 ring-1 ring-lime-200/60",
		unknown: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]",
	};
	return classes[channel] ?? classes.unknown;
}

/**
 * Outline (interaction) badge: the session merely interacted with this channel
 * (e.g. a web session that pushed a file to feishu). Distinct from the solid
 * origin badge (channelClass), which marks where the session was born.
 */
function channelInteractionClass(channel: SessionChannel): string {
	const classes: Record<string, string> = {
		cli: "bg-transparent text-[var(--inno-accent)]",
		web: "bg-transparent text-[var(--inno-text-muted)] ring-1 ring-[var(--inno-border-strong)]",
		feishu: "bg-transparent text-[var(--inno-success)]",
		scheduler: "bg-transparent text-[var(--inno-warning)] ring-1 ring-[var(--inno-warning-border)]",
		qq: "bg-transparent text-cyan-500 ring-1 ring-cyan-300/70",
		wechat: "bg-transparent text-lime-500 ring-1 ring-lime-300/70",
		unknown: "bg-transparent text-[var(--inno-text-subtle)]",
	};
	return classes[channel] ?? classes.unknown;
}

/**
 * Order a session's channel badges: the origin channel first (solid), then the
 * remaining interaction channels (outline). De-duplicates and keeps a stable
 * display order.
 */
function orderedSessionChannels(session: SessionMeta): Array<{ channel: SessionChannel; isOrigin: boolean }> {
	const origin = session.origin;
	const rest = session.channels.filter((c) => c !== origin);
	const ordered: Array<{ channel: SessionChannel; isOrigin: boolean }> = [];
	if (origin) ordered.push({ channel: origin, isOrigin: true });
	for (const c of rest) ordered.push({ channel: c, isOrigin: false });
	return ordered;
}

function channelFilterClass(channel: SessionChannel | null, active: boolean): string {
	if (!active) return "bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] hover:ring-[var(--inno-border-strong)]";
	if (!channel) return "inno-primary-button ring-1 ring-[var(--inno-accent)]";
	const map: Record<string, string> = {
		cli: "bg-[var(--inno-accent)] text-white ring-1 ring-[var(--inno-accent)] hover:bg-[var(--inno-accent)] hover:text-white",
		web: "inno-primary-button ring-1 ring-[var(--inno-accent)]",
		feishu: "bg-[var(--inno-success)] text-white ring-1 ring-[var(--inno-success)] hover:bg-[var(--inno-success)] hover:text-white",
		scheduler: "bg-[var(--inno-warning)] text-white ring-1 ring-[var(--inno-warning)] hover:bg-[var(--inno-warning)] hover:text-white",
		qq: "bg-cyan-600 text-white ring-1 ring-cyan-600 hover:bg-cyan-600 hover:text-white",
		wechat: "bg-lime-600 text-white ring-1 ring-lime-600 hover:bg-lime-600 hover:text-white",
	};
	return map[channel] ?? "inno-primary-button ring-1 ring-[var(--inno-accent)]";
}

/* ── Workspace group definition ── */

interface WsGroup {
	id: string;
	name: string;
	/** Whether rename/delete actions are offered (false for temp + archived bucket). */
	manageable: boolean;
	/** Whether a new chat can be started directly in this workspace (false for synthetic groups). */
	canCreate: boolean;
	sessions: SessionMeta[];
}

/* ── Group header component ── */

function GroupHeader({
	group,
	collapsed,
	active,
	onToggle,
	onSelect,
	onNewChat,
	editing,
	editingName,
	onStartEdit,
	onEditChange,
	onEditSave,
	onEditCancel,
	onDelete,
}: {
	group: WsGroup;
	collapsed: boolean;
	active: boolean;
	onToggle: () => void;
	onSelect: () => void;
	onNewChat: () => void;
	editing: boolean;
	editingName: string;
	onStartEdit: () => void;
	onEditChange: (v: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className={`group/wsh sticky top-0 z-10 flex w-full items-center gap-1.5 px-2 py-1.5 ${active ? "bg-[var(--inno-surface-muted)]" : "bg-[var(--inno-sidebar-bg)]"}`}>
			<button
				className="shrink-0 text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text-muted)]"
				title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
				onClick={onToggle}
			>
				<ChevronRight
					size={12}
					className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
				/>
			</button>
			<button
				className="inno-sidebar-meta flex min-w-0 flex-1 items-center gap-1.5 font-semibold uppercase text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text-muted)]"
				title={group.canCreate ? t("sidebar.loadWorkspace") : undefined}
				onClick={onSelect}
			>
				<FolderKanban size={12} className="shrink-0 text-[var(--inno-text-subtle)]" />
				{editing ? (
					<input
						className="min-w-0 flex-1 rounded border border-[var(--inno-accent)] bg-[var(--inno-surface)] px-1 py-0.5 text-[11px] normal-case text-[var(--inno-text)] outline-none focus-visible:shadow-[var(--inno-ring)]"
						value={editingName}
						autoFocus
						onClick={(e) => { e.stopPropagation(); }}
						onChange={(e) => onEditChange(e.target.value)}
						onBlur={onEditSave}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter") onEditSave();
							if (e.key === "Escape") onEditCancel();
						}}
					/>
				) : (
					<span className="min-w-0 truncate normal-case text-[var(--inno-text-muted)]">{group.name}</span>
				)}
			</button>
			{!editing ? (
				<div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/wsh:opacity-100">
					{group.canCreate ? (
						<button
							className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							title={t("sidebar.newChatInWorkspace")}
							onClick={(e) => { e.stopPropagation(); onNewChat(); }}
						>
							<Plus size={12} />
						</button>
					) : null}
					{group.manageable ? (
						<>
							<button
								className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
								title={t("sidebar.renameWorkspace")}
								onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
							>
								<Pencil size={12} />
							</button>
							<button
								className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)]"
								title={t("sidebar.deleteWorkspace")}
								onClick={(e) => { e.stopPropagation(); onDelete(); }}
							>
								<Trash2 size={12} />
							</button>
						</>
					) : null}
				</div>
			) : null}
			<span className="inno-sidebar-meta rounded-full bg-[var(--inno-surface-muted)] px-1.5 py-0 font-medium text-[var(--inno-text-muted)] tabular-nums">
				{group.sessions.length}
			</span>
		</div>
	);
}

/* ── Session card ── */

function SessionCard({
	session,
	active,
	opening,
	editing,
	editingName,
	generatingId,
	onOpen,
	onStartEdit,
	onEditChange,
	onEditSave,
	onEditCancel,
	onGenerate,
	onArchive,
	onDelete,
	onExport,
}: {
	session: SessionMeta;
	active: boolean;
	opening: boolean;
	editing: boolean;
	editingName: string;
	generatingId: string | null;
	onOpen: () => void;
	onStartEdit: () => void;
	onEditChange: (v: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onGenerate: () => void;
	onArchive: () => void;
	onDelete: () => void;
	onExport: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div
			className={`group/card relative mb-1 w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-all duration-150 ${
				active
					? "border-[var(--inno-border)] bg-[var(--inno-surface-muted)] shadow-sm"
					: "border-transparent hover:border-[var(--inno-border)] hover:bg-[var(--inno-surface)]"
			}`}
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
		>
			{/* Top row: name + time */}
			<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
				{editing ? (
					<input
						className="inno-sidebar-title min-w-0 flex-1 rounded border border-[var(--inno-accent)] bg-[var(--inno-surface)] px-1.5 py-0.5 outline-none focus-visible:shadow-[var(--inno-ring)]"
						value={editingName}
						autoFocus
						onClick={(e) => e.stopPropagation()}
						onChange={(e) => onEditChange(e.target.value)}
						onBlur={onEditSave}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter") onEditSave();
							if (e.key === "Escape") onEditCancel();
						}}
					/>
				) : (
					<div className="inno-sidebar-title min-w-0 truncate font-medium text-[var(--inno-text)] transition-colors group-hover/card:text-[var(--inno-text)]">
						{session.name}
					</div>
				)}
				<span className="inno-sidebar-meta shrink-0 pt-0.5 tabular-nums text-[var(--inno-text-subtle)]">{formatTime(session.updatedAt)}</span>
			</div>

			{/* Preview */}
			{session.preview && session.preview !== session.name ? (
				<div className="inno-sidebar-meta mt-0.5 truncate text-[var(--inno-text-subtle)]">{session.preview}</div>
			) : null}

			{/* Bottom row: channels + actions */}
			<div className="mt-1.5 flex items-center justify-between gap-1">
				<div className="flex flex-wrap items-center gap-1">
					{orderedSessionChannels(session).map(({ channel, isOrigin }) => (
						<span
							key={channel}
							title={isOrigin ? t("sidebar.originChannel", { channel: channelLabel(channel) }) : t("sidebar.interactedChannel", { channel: channelLabel(channel) })}
							className={`rounded px-1.5 py-px text-[9px] font-medium leading-none ${isOrigin ? channelClass(channel) : channelInteractionClass(channel)}`}
						>
							{channelLabel(channel)}
						</span>
					))}
				</div>
				<div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
					{opening ? (
						<Spinner size={12} className="text-[var(--inno-border-strong)]" />
					) : null}
					<button
						className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-40"
						title={t("sidebar.generateTopic")}
						disabled={generatingId === session.id}
						onClick={(e) => { e.stopPropagation(); onGenerate(); }}
					>
						{generatingId === session.id ? (
							<Spinner size={12} />
						) : (
							<Sparkles size={12} />
						)}
					</button>
					<button
						className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						title={t("sidebar.rename")}
						onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
					>
						<Pencil size={12} />
					</button>
					<button
						className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						title={t("sessions.export", "导出为 Markdown")}
						onClick={(e) => { e.stopPropagation(); onExport(); }}
					>
						<Download size={12} />
					</button>
					<button
						className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						title={session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
						onClick={(e) => { e.stopPropagation(); onArchive(); }}
					>
						{session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
					</button>
					<button
						className="rounded p-0.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)]"
						title={t("common.delete")}
						onClick={(e) => { e.stopPropagation(); onDelete(); }}
					>
						<Trash2 size={12} />
					</button>
					<span className="inno-sidebar-meta ml-0.5 tabular-nums text-[var(--inno-text-subtle)]">{session.messageCount}</span>
				</div>
			</div>
		</div>
	);
}

/* ── Main sidebar ── */

export function SessionSidebar({ collapsed }: SessionSidebarProps) {
	const { t } = useTranslation();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [generatingId, setGeneratingId] = useState<string | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(["archived"]));
	const [showSearch, setShowSearch] = useState(false);
	const [editingWsId, setEditingWsId] = useState<string | null>(null);
	const [editingWsName, setEditingWsName] = useState("");

	const state = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		currentSessionId: sessionsStore.currentSessionId,
		isLoading: sessionsStore.isLoading,
		openingSessionId: sessionsStore.openingSessionId,
		channelFilter: sessionsStore.channelFilter,
		searchQuery: sessionsStore.searchQuery,
		availableChannels: sessionsStore.availableChannels,
		filteredSessions: sessionsStore.filteredSessions,
	}));
	const wsState = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));
	const wsActive = useStoreSnapshot(workspaceStore, () => ({
		activeWorkspaceId: workspaceStore.activeWorkspaceId,
	}));
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const [togglingMode, setTogglingMode] = useState(false);

	// Toggle Simple/Normal mode from the top-left logo (flip animation).
	const toggleMode = useCallback(() => {
		if (togglingMode) return;
		const next = !(settingsStore.settings?.simpleMode?.enabled === true);
		setTogglingMode(true);
		void settingsStore.saveSimpleMode(next).finally(() => setTogglingMode(false));
	}, [togglingMode]);

	const orderedChannels = CHANNEL_FILTER_ORDER.filter((ch) => state.availableChannels.includes(ch as SessionChannel));

	useEffect(() => {
		void sessionsStore.load();
		void workspacesStore.load();
	}, []);

	// Build workspace-grouped session list. Non-archived sessions are grouped by
	// their bound workspace (in workspace recency order); archived sessions go to
	// a single trailing group.
	const groups = useMemo<WsGroup[]>(() => {
		const sessionToWs = new Map<string, WorkspaceMeta>();
		for (const w of wsState.list) {
			for (const sid of w.sessionIds ?? []) sessionToWs.set(sid, w);
		}
		const archived: SessionMeta[] = [];
		const byWs = new Map<string, SessionMeta[]>();
		const unknown: SessionMeta[] = [];
		for (const s of state.filteredSessions) {
			// Simple Mode: only show web-originated conversations; hide sessions
			// born in feishu/wechat/cli/scheduler channels.
			if (simpleMode && s.origin && s.origin !== "web") continue;
			if (s.archived) { archived.push(s); continue; }
			const w = sessionToWs.get(s.id);
			if (!w) { unknown.push(s); continue; }
			if (!byWs.has(w.id)) byWs.set(w.id, []);
			byWs.get(w.id)!.push(s);
		}
		const result: WsGroup[] = [];
		// Fixed ordering: user project workspaces (by recency) → channel workspaces
		// (feishu → wechat → cli) → temp workspace → unknown → archived.
		const CHANNEL_WS_ORDER = ["channel-feishu", "channel-wechat", "channel-cli"];
		const channelGroups = new Map<string, WsGroup>();
		const projectGroups: WsGroup[] = [];
		const tempGroups: WsGroup[] = [];
		// When a search/filter is active, only show groups that have matching
		// sessions so the list narrows as expected.
		const filtering = !!state.searchQuery || !!state.channelFilter;
		for (const w of wsState.list) {
			const sessions = byWs.get(w.id) ?? [];
			const isChannel = CHANNEL_WS_ORDER.includes(w.id);
			// Simple Mode: hide channel-backed workspaces entirely (web-only view).
			if (simpleMode && isChannel) continue;
			// Channel and temp workspaces are synthetic/auto-managed — hide them
			// when they have no sessions. Project (user) workspaces always show,
			// even with zero sessions, so they stay visible and deletable after
			// their last session is removed (unless a filter is narrowing the list).
			if (sessions.length === 0 && (w.isTemp || isChannel || filtering)) continue;
			const g: WsGroup = { id: w.id, name: w.name, manageable: !w.isTemp && !isChannel, canCreate: true, sessions };
			if (w.isTemp) {
				tempGroups.push(g);
			} else if (isChannel) {
				channelGroups.set(w.id, g);
			} else {
				projectGroups.push(g);
			}
		}
		// Project workspaces keep their recency order (wsState.list is sorted by updatedAt).
		result.push(...projectGroups);
		// Channel workspaces in fixed order.
		for (const id of CHANNEL_WS_ORDER) {
			const g = channelGroups.get(id);
			if (g) result.push(g);
		}
		result.push(...tempGroups);
		if (unknown.length > 0) {
			result.push({ id: "__unknown__", name: t("sidebar.ungrouped"), manageable: false, canCreate: false, sessions: unknown });
		}
		if (archived.length > 0) {
			result.push({ id: "archived", name: t("sidebar.archived"), manageable: false, canCreate: false, sessions: archived });
		}
		return result;
	}, [wsState.list, state.filteredSessions, state.searchQuery, state.channelFilter, simpleMode, t]);

	// Simple Mode (P7): a flat, recency-sorted list of web conversations — the
	// lightweight way back to a previously generated artifact (PPT, lesson plan,
	// etc.) without exposing workspace groups, channel filters or management UI.
	const recentSessions = useMemo<SessionMeta[]>(() => {
		if (!simpleMode) return [];
		return state.filteredSessions
			.filter((s) => !s.archived && (!s.origin || s.origin === "web"))
			.slice()
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}, [simpleMode, state.filteredSessions]);

	// Session → bound workspace lookup (shared by the Simple Mode list so each
	// row can show which workspace its files live in).
	const sessionToWorkspace = useMemo(() => {
		const map = new Map<string, WorkspaceMeta>();
		for (const w of wsState.list) {
			for (const sid of w.sessionIds ?? []) map.set(sid, w);
		}
		return map;
	}, [wsState.list]);

	const newChat = useCallback(() => {
		void (async () => {
			await sessionsStore.clearSelection();
			chatStore.clear();
			appStore.setRightPanelTab("preview");
			appStore.setWorkspaceMode("collapsed");
		})();
	}, []);

	// Click a workspace group header → load that workspace into the right panel (half screen).
	const selectWorkspace = useCallback((group: WsGroup) => {
		if (!group.canCreate) return; // synthetic groups (未分组 / 已归档)
		void workspaceStore.setActiveWorkspace(group.id);
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(560);
		appStore.setWorkspaceMode("half");
	}, []);

	// Start a new chat pre-bound to this workspace → preview its files (quarter, tree only).
	const newChatIn = useCallback((group: WsGroup) => {
		sessionsStore.beginNewSessionIn(group.id);
		void workspaceStore.setActiveWorkspace(group.id);
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(300);
		appStore.setWorkspaceMode("quarter");
	}, []);

	// Open a session → preview its workspace files (quarter, tree only).
	const openSession = useCallback((session: SessionMeta) => {
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(300);
		appStore.setWorkspaceMode("quarter");
		void sessionsStore.openSession(session.id);
	}, []);

	const saveName = useCallback(
		(id: string) => {
			const name = editingName.trim();
			if (!name) {
				setEditingId(null);
				return;
			}
			void sessionsStore.renameSession(id, name);
			setEditingId(null);
		},
		[editingName],
	);

	const generateName = useCallback((session: SessionMeta) => {
		setGeneratingId(session.id);
		void sessionsStore.generateSessionName(session.id).finally(() => setGeneratingId(null));
	}, []);

	const handleArchive = useCallback((session: SessionMeta) => {
		if (session.archived) {
			void sessionsStore.unarchiveSession(session.id);
		} else {
			void sessionsStore.archiveSession(session.id);
		}
	}, []);

	const handleExport = useCallback((session: SessionMeta) => {
		// Hits the backend export endpoint, which streams a `text/markdown`
		// attachment built from the session's merged messages. The browser
		// follows the Content-Disposition header to name the file.
		triggerDownload(`/api/sessions/${encodeURIComponent(session.id)}/export.md`);
	}, []);

	const handleDelete = useCallback((session: SessionMeta) => {
		const confirmed = typeof window === "undefined" ? true : window.confirm(t("sidebar.confirmDeleteSession", { name: session.name }));
		if (!confirmed) return;
		void sessionsStore.deleteSession(session.id);
	}, [t]);

	const toggleGroup = useCallback((key: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const saveWsName = useCallback((id: string) => {
		const name = editingWsName.trim();
		setEditingWsId(null);
		if (!name) return;
		void workspacesStore.rename(id, name);
	}, [editingWsName]);

	const handleDeleteWorkspace = useCallback((group: WsGroup) => {
		const detail = group.sessions.length > 0
			? t("sidebar.deleteWsWithSessions", { count: group.sessions.length })
			: t("sidebar.deleteWsEmpty");
		const confirmed = typeof window === "undefined" ? true : window.confirm(
			t("sidebar.confirmDeleteWorkspace", { name: group.name, detail }),
		);
		if (!confirmed) return;
		void (async () => {
			await workspacesStore.remove(group.id);
			await Promise.all([workspacesStore.load(), sessionsStore.refresh()]);
		})();
	}, [t]);

	/* ── Collapsed sidebar ── */

	if (collapsed) {
		return (
			<aside className="relative h-full w-0 overflow-visible">
				<button
					className="absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--inno-text-subtle)] transition-colors hover:bg-white/90 hover:text-[var(--inno-text)] hover:shadow-sm"
					title={t("sidebar.expand")}
					onClick={() => appStore.setSidebarCollapsed(false)}
				>
					<PanelLeftOpen size={16} />
				</button>
			</aside>
		);
	}

	/* ── Simple Mode sidebar (P7): minimal recent list + explicit mode switch ── */

	if (simpleMode) {
		return (
			<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
				{/* Header: brand + collapse */}
				<div className="flex items-center justify-between gap-2 border-b border-[var(--inno-border)] px-3 py-2.5">
					<div className="flex min-w-0 items-center gap-2">
						<button
							type="button"
							onClick={toggleMode}
							disabled={togglingMode}
							title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.currentNormalClickSimple")}
							aria-label={simpleMode ? t("mode.switchToNormal") : t("mode.switchToSimple")}
							className="flip-card-scene shrink-0 rounded-lg outline-none focus-visible:shadow-[var(--inno-ring)] disabled:cursor-wait"
						>
							<motion.div
								animate={{ rotateY: simpleMode ? 180 : 0 }}
								transition={{ type: "spring", stiffness: 320, damping: 22 }}
								className="flip-card h-7 w-7"
							>
								<span
									className="flip-card-face absolute inset-0 flex items-center justify-center rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-text)] shadow-sm"
								>
									IA
								</span>
								<span
									className="flip-card-back absolute inset-0 flex items-center justify-center rounded-lg border border-[var(--inno-accent)] bg-[var(--inno-accent)] text-[10px] font-semibold text-white shadow-sm"
								>
									IA
								</span>
							</motion.div>
						</button>
						<h1 className="inno-sidebar-title truncate font-semibold tracking-tight text-[var(--inno-text)]">
							Inno Agent
						</h1>
					</div>
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
						title={t("sidebar.collapse")}
						onClick={() => appStore.setSidebarCollapsed(true)}
					>
						<PanelLeftClose size={14} />
					</button>
				</div>

				{/* Recent conversations — the way back to a generated artifact */}
				<div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-2 sidebar-scroll">
					<div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">{t("sidebar.recent")}</div>
					{state.isLoading ? (
						<div className="flex items-center justify-center py-8">
							<Spinner size={16} className="text-[var(--inno-border-strong)]" />
						</div>
					) : recentSessions.length === 0 ? (
						<div className="inno-sidebar-text px-2 py-8 text-center text-[var(--inno-text-subtle)]">{t("sidebar.noConversations")}</div>
					) : (
						recentSessions.map((session) => {
							const ws = sessionToWorkspace.get(session.id);
							return (
								<div
									key={session.id}
									role="button"
									tabIndex={0}
									onClick={() => openSession(session)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											openSession(session);
										}
									}}
									className={`group/srow relative mb-1 block w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-all duration-150 ${
										state.currentSessionId === session.id
											? "border-[var(--inno-border)] bg-[var(--inno-surface-muted)] shadow-sm"
											: "border-transparent hover:border-[var(--inno-border)] hover:bg-[var(--inno-surface)]"
									}`}
								>
									<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
										<div className="inno-sidebar-title min-w-0 truncate font-medium text-[var(--inno-text)]">{session.name}</div>
										<button
											className="rounded p-0.5 text-[var(--inno-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)] group-hover/srow:opacity-100"
											title={t("sidebar.deleteConversation")}
											onClick={(e) => { e.stopPropagation(); handleDelete(session); }}
										>
											<Trash2 size={12} />
										</button>
									</div>
									{session.preview && session.preview !== session.name ? (
										<div className="inno-sidebar-meta mt-0.5 truncate text-[var(--inno-text-subtle)]">{session.preview}</div>
									) : null}
									<div className="mt-1 flex items-center gap-1.5">
										{ws ? (
											<span
												className="inline-flex max-w-[140px] items-center gap-1 rounded bg-[var(--inno-surface-muted)] px-1.5 py-px text-[9px] font-medium leading-none text-[var(--inno-text-muted)]"
												title={t("sidebar.workspaceLabel", { name: ws.name })}
											>
												<FolderKanban size={12} className="shrink-0" />
												<span className="truncate">{ws.name}</span>
											</span>
										) : null}
										<span className="inno-sidebar-meta tabular-nums text-[var(--inno-text-subtle)]">{formatTime(session.updatedAt)}</span>
									</div>
								</div>
							);
						})
					)}
				</div>

				{/* Footer: new chat (mode switch lives on the IA logo above) */}
				<div className="border-t border-[var(--inno-border)] p-2">
					<button
						className="inno-sidebar-text inno-new-chat-button flex w-full items-center justify-center gap-2 rounded-lg inno-primary-button px-3 py-1.5 font-medium text-white shadow-sm transition-colors"
						onClick={newChat}
					>
						<Plus size={14} /> {t("sidebar.newChat")}
					</button>
				</div>
			</aside>
		);
	}

	/* ── Expanded sidebar ── */

	return (
		<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
			{/* Header */}
			<div className="border-b border-[var(--inno-border)] px-3 py-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<button
							type="button"
							onClick={toggleMode}
							disabled={togglingMode}
							title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.currentNormalClickSimple")}
							aria-label={simpleMode ? t("mode.switchToNormal") : t("mode.switchToSimple")}
							className="flip-card-scene shrink-0 rounded-lg outline-none focus-visible:shadow-[var(--inno-ring)] disabled:cursor-wait"
						>
							<motion.div
								animate={{ rotateY: simpleMode ? 180 : 0 }}
								transition={{ type: "spring", stiffness: 320, damping: 22 }}
								className="flip-card h-7 w-7"
							>
								<span
									className="flip-card-face absolute inset-0 flex items-center justify-center rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-text)] shadow-sm"
								>
									IA
								</span>
								<span
									className="flip-card-back absolute inset-0 flex items-center justify-center rounded-lg border border-[var(--inno-accent)] bg-[var(--inno-accent)] text-[10px] font-semibold text-white shadow-sm"
								>
									IA
								</span>
							</motion.div>
						</button>
						<div className="min-w-0">
							<h1 className="inno-sidebar-title font-semibold tracking-tight text-[var(--inno-text)]">
								Inno Agent{simpleMode ? <span className="font-normal text-[var(--inno-accent)]">{t("mode.simpleTag")}</span> : null}
							</h1>
						</div>
					</div>
					<div className="flex items-center gap-1">
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
							title={t("common.refresh")}
							onClick={() => void sessionsStore.load()}
						>
							<RefreshCw size={14} />
						</button>
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
							title={t("sidebar.collapse")}
							onClick={() => appStore.setSidebarCollapsed(true)}
						>
							<PanelLeftClose size={14} />
						</button>
					</div>
				</div>
			</div>

			{/* Search + Filter bar */}
			<div className="space-y-1.5 border-b border-[var(--inno-border)] px-2 py-1.5">
				{/* Search */}
				<div className="relative">
					{showSearch ? (
						<div className="flex items-center gap-1">
							<div className="relative flex-1">
								<Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)]" />
								<input
									className="inno-sidebar-text w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1 pl-7 pr-7 outline-none placeholder:text-[var(--inno-text-subtle)] focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									placeholder={t("sidebar.searchPlaceholder")}
									value={state.searchQuery}
									autoFocus
									onChange={(e) => sessionsStore.setSearchQuery(e.target.value)}
								/>
								{state.searchQuery && (
									<button
										className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)] hover:text-[var(--inno-text-muted)]"
										onClick={() => sessionsStore.setSearchQuery("")}
									>
										<X size={12} />
									</button>
								)}
							</div>
							<button
								className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text-muted)]"
								onClick={() => { setShowSearch(false); sessionsStore.setSearchQuery(""); }}
							>
								<X size={14} />
							</button>
						</div>
					) : (
						<div className="relative">
							<Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)] pointer-events-none" />
							<button
								className="inno-sidebar-text w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1.5 pl-7 pr-3 text-left text-[var(--inno-text-subtle)] transition-colors hover:border-[var(--inno-border-strong)] hover:bg-[var(--inno-surface-muted)]"
								onClick={() => setShowSearch(true)}
							>
								{t("sidebar.searchPlaceholder")}
							</button>
						</div>
					)}
				</div>

				{/* Channel filter chips — hidden in Simple Mode (web-only view) */}
				{!simpleMode && state.availableChannels.length > 1 && (
					<div className="flex flex-wrap items-center gap-1">
						{orderedChannels.map((ch) => (
							<button
								key={ch}
								className={`inno-channel-filter-chip inno-sidebar-meta rounded-full px-1.5 py-px font-medium transition-colors ${channelFilterClass(ch, state.channelFilter === ch)}`}
								onClick={() => sessionsStore.setChannelFilter(state.channelFilter === ch ? null : ch)}
							>
								{channelLabel(ch)}
							</button>
						))}
						<button
							className={`inno-channel-filter-chip inno-sidebar-meta rounded-full px-1.5 py-px font-medium transition-colors ${channelFilterClass(null, state.channelFilter === null)}`}
							onClick={() => sessionsStore.setChannelFilter(null)}
						>
							{t("sidebar.all")}
						</button>
					</div>
				)}
			</div>

			{/* Session list */}
			<div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 sidebar-scroll">
				{state.isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner size={16} className="text-[var(--inno-border-strong)]" />
					</div>
				) : groups.length === 0 ? (
					<div className="inno-sidebar-text px-2 py-8 text-center text-[var(--inno-text-subtle)]">
						{state.searchQuery || state.channelFilter ? t("sidebar.noMatch") : t("sidebar.noSessions")}
					</div>
				) : (
					groups.map((group) => {
						const isGroupCollapsed = collapsedGroups.has(group.id);
						return (
							<div key={group.id} className="mt-0.5">
								<GroupHeader
									group={group}
									collapsed={isGroupCollapsed}
									active={group.canCreate && wsActive.activeWorkspaceId === group.id}
									onToggle={() => toggleGroup(group.id)}
									onSelect={() => selectWorkspace(group)}
									onNewChat={() => newChatIn(group)}
									editing={editingWsId === group.id}
									editingName={editingWsName}
									onStartEdit={() => { setEditingWsId(group.id); setEditingWsName(group.name); }}
									onEditChange={setEditingWsName}
									onEditSave={() => saveWsName(group.id)}
									onEditCancel={() => setEditingWsId(null)}
									onDelete={() => handleDeleteWorkspace(group)}
								/>
								<AnimatePresence initial={false}>
									{!isGroupCollapsed && (
										<motion.div
											initial={{ height: 0, opacity: 0 }}
											animate={{ height: "auto", opacity: 1 }}
											exit={{ height: 0, opacity: 0 }}
											transition={{ duration: 0.15, ease: "easeInOut" }}
											className="overflow-hidden"
										>
											{group.sessions.map((session) => (
												<SessionCard
													key={session.id}
													session={session}
													active={state.currentSessionId === session.id}
													opening={state.openingSessionId === session.id}
													editing={editingId === session.id}
													editingName={editingName}
													generatingId={generatingId}
													onOpen={() => openSession(session)}
													onStartEdit={() => { setEditingId(session.id); setEditingName(session.name); }}
													onEditChange={setEditingName}
													onEditSave={() => saveName(session.id)}
													onEditCancel={() => setEditingId(null)}
													onGenerate={() => generateName(session)}
													onArchive={() => handleArchive(session)}
													onDelete={() => handleDelete(session)}
													onExport={() => handleExport(session)}
												/>
											))}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						);
					})
				)}
			</div>

			{/* Footer */}
			<div className="border-t border-[var(--inno-border)] p-2">
				<button
					className="inno-sidebar-text inno-new-chat-button flex w-full items-center justify-center gap-2 rounded-lg inno-primary-button px-3 py-1.5 font-medium text-white shadow-sm transition-colors"
					onClick={newChat}
				>
					<Plus size={14} /> {t("sidebar.newChat")}
				</button>
			</div>
		</aside>
	);
}
