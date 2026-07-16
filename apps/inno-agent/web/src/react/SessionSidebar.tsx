import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
	ChevronRight,
	Search,
	X,
	FolderKanban,
	Folder,
	FolderOpen,
	MoreHorizontal,
	Pin,
	PinOff,
} from "lucide-react";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import type { WorkspaceMeta } from "../api/workspaces.js";
import type { SessionChannel, SessionMeta } from "../api/sessions.js";
import { useStoreSnapshot } from "./hooks.js";
import { Spinner } from "./ui/Spinner.js";
import { InnoLogoIcon, InnoLogoIconAlt, InnoLogoText, NewChatSimple, NewChatNormal } from "./ui/InnoLogo.js";
import { ModeSwitch } from "./ModeSwitch.js";

interface SessionSidebarProps {
	collapsed: boolean;
}

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
	pinned,
	onTogglePin,
	onOpenMenu,
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
	pinned: boolean;
	onTogglePin: () => void;
	onOpenMenu: (ref: HTMLButtonElement) => void;
}) {
	const { t } = useTranslation();
	const badgeRef = useRef<HTMLButtonElement>(null);
	const openMenu = useCallback(() => {
		if (badgeRef.current) onOpenMenu(badgeRef.current);
	}, [onOpenMenu]);
	return (
		<div className={`group/wsh sticky top-0 z-10 flex w-full items-center gap-1.5 ${active ? "bg-[var(--inno-surface-muted)]" : "bg-[var(--inno-sidebar-bg)]"}`}>
			<button
				className="shrink-0 text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text-muted)]"
				title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
				onClick={onToggle}
			>
				{collapsed ? <Folder size={12} /> : <FolderOpen size={12} />}
			</button>
			<button
				className="inno-sidebar-meta flex min-w-0 flex-1 items-center gap-1.5 font-semibold uppercase text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text-muted)] focus:outline-none focus-visible:outline-none"
				title={group.canCreate ? t("sidebar.loadWorkspace") : undefined}
				onClick={onSelect}
			>
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
			<button
				ref={badgeRef}
				className="group/count inno-sidebar-meta relative flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--inno-surface-muted)] px-1.5 py-0 font-medium text-[var(--inno-text-muted)] tabular-nums transition-colors hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)]"
				title={t("sidebar.workspaceMenu")}
				onClick={(e) => { e.stopPropagation(); openMenu(); }}
			>
				{pinned && <Pin size={9} className="absolute -top-0.5 -right-0.5 text-[var(--inno-accent)]" />}
				<span aria-hidden className="group-hover/wsh:hidden">{group.sessions.length}</span>
				<span aria-hidden className="hidden group-hover/wsh:inline">…</span>
			</button>
		</div>
	);
}

/* ── Workspace header popup menu ── */

interface WorkspaceMenuProps {
	group: WsGroup;
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	onClose: () => void;
	onRename: () => void;
	onTogglePin: () => void;
	onNewChat: () => void;
	onDelete: () => void;
	pinned: boolean;
}

function WorkspaceMenu({ group, anchorRef, onClose, onRename, onTogglePin, onNewChat, onDelete, pinned }: WorkspaceMenuProps) {
	const { t } = useTranslation();
	const menuRef = useRef<HTMLDivElement>(null);

	// Close on any outside click / Esc.
	useEffect(() => {
		const onDocClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("mousedown", onDocClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	// Position the menu below the anchor badge.
	const pos = useMemo(() => {
		const r = anchorRef.current?.getBoundingClientRect();
		if (!r) return null;
		return { top: r.bottom + 4, left: Math.min(r.right, window.innerWidth - 160) };
	}, [anchorRef]);

	if (!pos) return null;

	const menuItems: Array<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; show: boolean }> = [
		{ icon: <Pencil size={12} />, label: t("sidebar.renameWorkspace"), onClick: () => { onRename(); onClose(); }, show: group.manageable },
		{ icon: pinned ? <PinOff size={12} /> : <Pin size={12} />, label: pinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace"), onClick: () => { onTogglePin(); onClose(); }, show: true },
		{ icon: <Plus size={12} />, label: t("sidebar.newChatInWorkspace"), onClick: () => { onNewChat(); onClose(); }, show: group.canCreate },
		{ icon: <Trash2 size={12} />, label: t("sidebar.deleteWorkspace"), onClick: () => { onDelete(); onClose(); }, danger: true, show: group.manageable },
	];
	const visible = menuItems.filter((m) => m.show);

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[100] whitespace-nowrap rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1 shadow-lg"
			style={{ top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
		>
			{visible.map((item) => (
				<button
					key={item.label}
					className={`flex w-full items-center gap-2 pl-2 pr-8 py-1 text-left leading-tight transition-colors hover:bg-[var(--inno-surface-muted)] ${item.danger ? "text-[var(--inno-danger)]" : "text-[var(--inno-text)]"}`}
						style={{ fontSize: "11px" }}
					onClick={item.onClick}
				>
					{item.icon}
					<span>{item.label}</span>
				</button>
			))}
		</div>,
		document.body,
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
}) {
	const { t } = useTranslation();
	return (
		<div
			className={`group/card relative mb-0 w-full cursor-pointer rounded-lg border border-transparent pl-[15px] pr-1.5 py-1 text-left transition-all duration-150 ${
				active
					? "border-[var(--inno-border)] bg-white"
					: ""
			}`}
			role="button"
			tabIndex={0}
			onMouseDown={(e) => e.preventDefault()}
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
	/** Pinned workspace IDs — stored in localStorage so they survive reloads. */
	const [pinnedWsIds, setPinnedWsIds] = useState<Set<string>>(() => {
		try {
			const raw = localStorage.getItem("inno-pinned-workspaces");
			return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
		} catch { return new Set(); }
	});
	const [wsMenuId, setWsMenuId] = useState<string | null>(null);
	const wsMenuBtnRef = useRef<HTMLButtonElement | null>(null);
	const wsMenuRef = useRef<HTMLDivElement | null>(null);

	const togglePinWorkspace = useCallback((id: string) => {
		setPinnedWsIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			try { localStorage.setItem("inno-pinned-workspaces", JSON.stringify([...next])); } catch { /* ignore */ }
			return next;
		});
	}, []);
	const [editingWsName, setEditingWsName] = useState("");

	const state = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		currentSessionId: sessionsStore.currentSessionId,
		isLoading: sessionsStore.isLoading,
		openingSessionId: sessionsStore.openingSessionId,
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
		const filtering = !!state.searchQuery;
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
		// Float pinned workspaces to the top (stable within pinned / unpinned).
		if (pinnedWsIds.size > 0) {
			result.sort((a, b) => {
				const pa = pinnedWsIds.has(a.id) ? 0 : 1;
				const pb = pinnedWsIds.has(b.id) ? 0 : 1;
				return pa - pb;
			});
		}
		return result;
	}, [wsState.list, state.filteredSessions, state.searchQuery, simpleMode, t, pinnedWsIds]);

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

	// Workspace-header popup menu (rendered via portal). Resolved before any
	// early-return branch so it appears regardless of sidebar mode.
	const activeWsMenu = useMemo(() => {
		if (!wsMenuId) return null;
		const g = groups.find((gr) => gr.id === wsMenuId);
		if (!g) return null;
		return (
			<WorkspaceMenu
				group={g}
				anchorRef={wsMenuBtnRef}
				onClose={() => setWsMenuId(null)}
				onRename={() => { setEditingWsId(g.id); setEditingWsName(g.name); setWsMenuId(null); }}
				onTogglePin={() => togglePinWorkspace(g.id)}
				onNewChat={() => { void newChatIn(g); setWsMenuId(null); }}
				onDelete={() => { setWsMenuId(null); handleDeleteWorkspace(g); }}
				pinned={pinnedWsIds.has(g.id)}
			/>
		);
	}, [wsMenuId, groups, togglePinWorkspace, newChatIn, handleDeleteWorkspace, pinnedWsIds]);

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
			<>
			<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
				{/* Header: brand + collapse */}
				<div className="flex items-center justify-between gap-2 pr-3 ml-[30px] mt-[40px]">
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
								className="flip-card h-[30px] w-[30px]"
							>
								<span
									className="flip-card-face absolute inset-0 flex items-center justify-center rounded-lg"
								>
									<InnoLogoIcon className="h-[30px] w-[30px]" />
								</span>
								<span
									className="flip-card-back absolute inset-0 flex items-center justify-center rounded-lg"
								>
									<InnoLogoIconAlt className="h-[30px] w-[30px]" />
								</span>
							</motion.div>
						</button>
						<h1 className="inno-sidebar-title truncate font-semibold tracking-tight text-[var(--inno-text)]">
							<InnoLogoText className="h-[30px] w-auto" />
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

			<div className="mt-[20px]">
				<ModeSwitch simpleMode={simpleMode} />
			</div>

			{/* New chat button (simple mode) */}
				<div className="mt-[20px] flex justify-center">
					<button
					className="flex items-center justify-center overflow-hidden rounded-xl transition-opacity !hover:bg-transparent hover:opacity-90"
					onClick={newChat}
					onMouseDown={(e) => e.preventDefault()}
					title={t("sidebar.newChat")}
				>
					<NewChatSimple className="h-10 w-full" />
				</button>
				</div>

				{/* Recent conversations */}
				<div className="w-[310px] flex-1 min-h-0 overflow-y-auto sidebar-scroll mx-auto mt-[20px] px-0">
					<div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">{t("sidebar.recent")}</div>
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
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => openSession(session)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											openSession(session);
										}
									}}
									className={`group/srow relative mb-1 block w-full cursor-pointer rounded-xl border border-transparent py-2 pl-[3px] -ml-[3px] text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none focus:outline-none focus:ring-0 focus:shadow-none ${
										state.currentSessionId === session.id
											? "border-[var(--inno-border)] bg-white"
											: ""
									}`}
								>
									<div className="inno-sidebar-title min-w-0 truncate pr-5 font-medium text-[var(--inno-text)]">{session.name}</div>
									<button
										className="absolute right-0 top-0 rounded p-0.5 text-[var(--inno-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)] group-hover/srow:opacity-100"
										title={t("sidebar.deleteConversation")}
										onClick={(e) => { e.stopPropagation(); handleDelete(session); }}
									>
										<Trash2 size={12} />
									</button>
									<div className="mt-1 flex items-center gap-1.5">
										{ws ? (
											<span
												className="inline-flex max-w-[140px] items-center gap-1 rounded bg-[var(--inno-surface-muted)] py-px text-[9px] font-medium leading-none text-[var(--inno-text-muted)]"
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

				{/* Footer: search bar */}
				<div className="shrink-0 bg-[var(--inno-sidebar-bg)] px-2 pt-1.5 pb-20 flex justify-center">
					<div className="relative">
						{showSearch ? (
							<div className="relative w-[304px]">
								<Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)]" />
								<input
									className="inno-sidebar-text w-full rounded-full border-none bg-white py-3 pl-8 pr-8 text-[13px] outline-none placeholder:text-[var(--inno-text-subtle)] focus-visible:ring-2 focus-visible:ring-[#555AFF]/30"
									placeholder={t("sidebar.searchPlaceholder")}
									value={state.searchQuery}
									autoFocus
									onChange={(e) => sessionsStore.setSearchQuery(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Escape") { setShowSearch(false); sessionsStore.setSearchQuery(""); } }}
								/>
								{state.searchQuery && (
									<button
										className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)] hover:text-[var(--inno-text-muted)]"
										onClick={() => sessionsStore.setSearchQuery("")}
									>
										<X size={12} />
									</button>
								)}
							</div>
						) : (
							<div className="relative">
								<Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555AFF]/60 pointer-events-none" />
								<button
									className="inno-sidebar-text w-[304px] rounded-full border-none bg-white py-3 pl-8 pr-3 text-left text-[13px] text-[var(--inno-text-subtle)] transition-colors hover:bg-gray-50"
									onClick={() => setShowSearch(true)}
								>
									{t("sidebar.searchPlaceholder")}
								</button>
							</div>
						)}
					</div>
				</div>
			</aside>
			{activeWsMenu}
			</>
		);
	}

	/* ── Expanded sidebar ── */

	return (
		<>
		<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
			{/* Header */}
			<div className="pr-3 ml-[30px] mt-[40px]">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<div className="shrink-0 rounded-lg">
							<InnoLogoIcon className="h-[30px] w-[30px]" />
						</div>
						<div className="min-w-0">
							<h1 className="inno-sidebar-title font-semibold tracking-tight text-[var(--inno-text)]">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									xmlnsXlink="http://www.w3.org/1999/xlink"
									fill="none"
									version="1.1"
									viewBox="0 0 135 28"
									className="h-[28px] w-auto"
									role="img"
									aria-label="Inno Agent"
								>
									<defs>
										<linearGradient
											x1="109.80696827173233"
											y1="28"
											x2="10.937461294233799"
											y2="-16.727383852005005"
											gradientUnits="userSpaceOnUse"
											id="innoLogoGradient"
										>
											<stop offset="0%" stopColor="#5376FF" stopOpacity="1" />
											<stop offset="34.98755395412445%" stopColor="#9568EF" stopOpacity="1" />
											<stop offset="68.57143044471741%" stopColor="#5F61F8" stopOpacity="1" />
											<stop offset="99.28572177886963%" stopColor="#584CFF" stopOpacity="1" />
										</linearGradient>
									</defs>
									<g>
										<path
											d="M21.264,5.7439995L21.264,13.4L6.3600001,13.4Q6.2639999,16.688,5.3759999,19.208Q4.4879999,21.728001,2.52,24.872L0.24000001,23.167999Q1.5600001,21.247999,2.2920001,19.652Q3.0239999,18.056,3.348,16.184Q3.6719999,14.312,3.6719999,11.648L3.6719999,5.7439995L11.400001,5.7439995L10.752,3.7999992L13.440001,3.4160004L13.704,4.184Q14.112,5.3600006,14.232,5.7439995L21.264,5.7439995ZM6.3839998,10.904L18.6,10.904L18.6,8.1440001L6.3839998,8.1440001L6.3839998,10.904ZM9.1680002,25.448L6.5279999,25.448L6.5279999,15.704L20.952,15.704L20.952,25.448L18.288,25.448L18.288,24.271999L9.1680002,24.271999L9.1680002,25.448ZM18.288,21.992001L18.288,18.032L9.1680002,18.032L9.1680002,21.992001L18.288,21.992001ZM31.824001,17.144001Q32.496002,17.096001,32.748001,17Q33,16.903999,33.084,16.676001Q33.167999,16.448,33.216003,15.872Q33.216003,15.559999,33.264,14.792L33.312,13.304L29.136002,13.304L29.136002,20.816Q29.136002,21.608,29.220001,21.908001Q29.304001,22.208,29.592001,22.327999Q29.880001,22.448,30.624001,22.52Q31.320002,22.591999,32.040001,22.591999Q32.664001,22.591999,33.264,22.52Q33.84,22.448,34.128002,22.304001Q34.416,22.16,34.548,21.884001Q34.68,21.608,34.800003,21.007999Q34.896,20.552,35.016003,19.351999L37.512001,20.119999Q37.368,21.440001,37.223999,22.256001Q37.008003,23.312,36.66,23.84Q36.312,24.368,35.604,24.620001Q34.896,24.872,33.552002,24.944Q32.952003,24.992001,31.704002,24.992001Q30.480001,24.992001,29.856001,24.944Q28.632002,24.872,27.960001,24.572001Q27.288002,24.271999,26.988001,23.563999Q26.688002,22.856001,26.688002,21.559999L26.688002,12.056Q25.968,12.632,25.584002,12.896L24.048,10.88Q26.064001,9.4399996,27.996002,7.2559996Q29.928001,5.0720005,30.864002,3.1040001L33.192001,4.2800007Q32.808002,5.0240002,32.736,5.1679993Q34.032001,6.1520004,35.459999,7.3999996Q36.888,8.6479998,37.824001,9.632L36.360001,11.768Q35.712002,11.048,35.664001,11Q35.664001,12.008,35.616001,13.532Q35.568001,15.056,35.52,16.472Q35.472,17.576,35.208,18.188Q34.944,18.799999,34.32,19.087999Q33.695999,19.375999,32.52,19.472L31.248001,19.568001L30.552002,17.216L31.824001,17.144001ZM42.504002,3.8719997L44.928001,3.9920006L44.928001,22.327999Q44.928001,23.504,44.676003,24.068001Q44.424004,24.632,43.740002,24.896Q43.056,25.16,41.616001,25.304001L40.176003,25.448L39.288002,22.736L40.896004,22.568001Q41.568001,22.496,41.892002,22.388Q42.216003,22.280001,42.360001,22.016001Q42.504002,21.752001,42.504002,21.200001L42.504002,3.8719997ZM38.280003,5.7199993L40.751999,5.816L40.751999,19.544001L38.280003,19.544001L38.280003,5.7199993ZM35.616001,10.952Q33.864002,9.1519995,31.440001,7.1599998Q30,9.1040001,27.984001,10.952L35.616001,10.952ZM48.496002,17.672001Q48.496002,17.063999,48.592003,16.784Q48.688004,16.504,48.960003,16.407999Q49.232002,16.312,49.824001,16.312Q50.416004,16.312,50.688004,16.407999Q50.960003,16.504,51.064003,16.784Q51.168003,17.063999,51.168003,17.672001Q51.168003,18.279999,51.064003,18.552Q50.960003,18.823999,50.688004,18.92Q50.416004,19.015999,49.824001,19.015999Q49.232002,19.015999,48.960003,18.92Q48.688004,18.823999,48.592003,18.552Q48.496002,18.279999,48.496002,17.672001ZM56.032001,11.896L56.032001,23L53.776001,23L53.776001,11.896L56.032001,11.896ZM66.256004,17.08L66.256004,23L64.096001,23L64.096001,17.672001Q64.096001,16.728001,63.800003,16.351999Q63.504002,15.976,62.656002,15.976Q61.856003,15.976,61.376003,16.264Q60.896,16.552,60.672001,17.256001L60.672001,23L58.512001,23L58.512001,14.36L60.672001,14.36L60.672001,15.431999Q61.024002,14.808,61.728001,14.504Q62.432003,14.2,63.376003,14.2Q64.944,14.2,65.600006,14.912Q66.256004,15.624,66.256004,17.08ZM76.384003,17.08L76.384003,23L74.224007,23L74.224007,17.672001Q74.224007,16.728001,73.928001,16.351999Q73.632004,15.976,72.784004,15.976Q71.984001,15.976,71.504005,16.264Q71.024002,16.552,70.800003,17.256001L70.800003,23L68.640007,23L68.640007,14.36L70.800003,14.36L70.800003,15.431999Q71.152,14.808,71.856003,14.504Q72.560005,14.2,73.504005,14.2Q75.072006,14.2,75.728004,14.912Q76.384003,15.624,76.384003,17.08ZM78.32,18.68Q78.32,16.983999,78.800003,16Q79.279999,15.016,80.192001,14.608Q81.104004,14.2,82.496002,14.2Q83.888,14.2,84.807999,14.608Q85.728004,15.016,86.208,16Q86.688004,16.983999,86.688004,18.68Q86.688004,20.375999,86.208,21.360001Q85.728004,22.344,84.807999,22.752001Q83.888,23.16,82.496002,23.16Q81.104004,23.16,80.192001,22.752001Q79.279999,22.344,78.800003,21.360001Q78.32,20.375999,78.32,18.68ZM82.496002,21.511999Q83.279999,21.511999,83.704002,21.256001Q84.128006,21,84.304001,20.4Q84.480003,19.799999,84.480003,18.68Q84.480003,17.576,84.296005,16.968Q84.112,16.360001,83.68,16.096001Q83.248001,15.832,82.496002,15.832Q81.728004,15.832,81.304001,16.096001Q80.880005,16.360001,80.704002,16.968Q80.528,17.576,80.528,18.68Q80.528,19.784,80.712006,20.392Q80.896004,21,81.32,21.256001Q81.744003,21.511999,82.496002,21.511999ZM90.880005,20.152L89.856003,23L87.536003,23L91.68,11.896L94.704002,11.896L98.832001,23L96.431999,23L95.456001,20.152L90.880005,20.152ZM94.784004,18.264L93.279999,13.896L93.088005,13.896L91.536003,18.264L94.784004,18.264ZM103.26401,26.200001Q102.11201,26.200001,100.86401,25.992001L100.86401,24.264Q101.92001,24.52,103.12,24.52Q104.54401,24.52,105.176,24.007999Q105.80801,23.496,105.80801,22.247999L105.80801,21.704Q105.52,22.344,104.90401,22.672001Q104.288,23,103.16801,23Q101.18401,23,100.41601,21.879999Q99.648003,20.76,99.648003,18.6Q99.648003,16.568001,100.43201,15.384Q101.216,14.2,103.16801,14.2Q104.32001,14.2,104.92801,14.544Q105.536,14.888,105.80801,15.544L105.80801,14.36L107.936,14.36L107.936,22.344Q107.936,24.232,106.84801,25.216Q105.76,26.200001,103.26401,26.200001ZM103.76,21.4Q104.62401,21.4,105.09601,21.08Q105.56801,20.76,105.73601,20.16Q105.90401,19.559999,105.90401,18.6Q105.90401,17.672001,105.73601,17.071999Q105.56801,16.472,105.09601,16.152Q104.62401,15.832,103.76,15.832Q102.608,15.832,102.24001,16.559999Q101.872,17.288,101.872,18.6Q101.872,19.976,102.24801,20.688Q102.62401,21.4,103.76,21.4ZM117.69601,19.128L112.08001,19.48Q112.12801,20.504,112.69601,20.976Q113.26401,21.448,114.48001,21.448Q115.23201,21.448,116.04801,21.264Q116.86401,21.08,117.32801,20.84L117.32801,22.568001Q116.91201,22.808001,116.01601,22.983999Q115.12001,23.16,114.09601,23.16Q112.70401,23.16,111.79201,22.752001Q110.88,22.344,110.40001,21.360001Q109.92001,20.375999,109.92001,18.68Q109.92001,16.983999,110.40001,16Q110.88,15.016,111.80001,14.608Q112.72001,14.2,114.11201,14.2Q116.20801,14.2,116.992,15.184Q117.77601,16.167999,117.77601,17.959999Q117.77601,18.439999,117.69601,19.128ZM115.79201,17.688Q115.79201,16.792,115.44801,16.312Q115.10401,15.832,114.11201,15.832Q113.00801,15.832,112.56801,16.335999Q112.12801,16.84,112.08001,17.976L115.79201,17.688ZM127.45601,17.08L127.45601,23L125.29601,23L125.29601,17.672001Q125.29601,16.728001,125.00001,16.351999Q124.70401,15.976,123.85601,15.976Q123.05601,15.976,122.57601,16.264Q122.09601,16.552,121.87201,17.256001L121.87201,23L119.71201,23L119.71201,14.36L121.87201,14.36L121.87201,15.431999Q122.22401,14.808,122.92801,14.504Q123.63201,14.2,124.57601,14.2Q126.14401,14.2,126.80001,14.912Q127.45601,15.624,127.45601,17.08ZM133.18401,21.4Q133.61601,21.4,133.92001,21.336L133.92001,23.016001Q133.36002,23.096001,132.832,23.096001Q131.744,23.096001,131.14401,22.856001Q130.54401,22.615999,130.272,22.007999Q130.00002,21.4,130.00002,20.264L130.00002,16.071999L128.832,16.071999L128.832,14.36L130.00002,14.36L130.00002,12.311999L132.16,12.311999L132.16,14.36L134.00002,14.36L134.00002,16.071999L132.16,16.071999L132.16,20.087999Q132.16,20.632,132.24001,20.903999Q132.32001,21.176001,132.53601,21.288Q132.75201,21.4,133.18401,21.4Z"
											fill="url(#innoLogoGradient)"
											fillOpacity="1"
										/>
									</g>
								</svg>
								{simpleMode ? <span className="ml-1 font-normal text-[var(--inno-text-accent)]">{t("mode.simpleTag")}</span> : null}
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
			<div className="mt-[20px]">
				<ModeSwitch simpleMode={simpleMode} />
			</div>

			{/* New chat button (normal mode) */}
			<div className="mt-[20px] flex justify-center">
				<button
				className="flex items-center justify-center overflow-hidden rounded-xl transition-opacity !hover:bg-transparent hover:opacity-90"
				onClick={newChat}
				onMouseDown={(e) => e.preventDefault()}
				title={t("sidebar.newChat")}
			>
				<NewChatNormal className="h-10 w-full" />
			</button>
			</div>

			{/* Session list */}
			<div className="w-[310px] flex-1 min-h-0 overflow-y-auto sidebar-scroll mx-auto mt-[20px] px-0">
				{state.isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner size={16} className="text-[var(--inno-border-strong)]" />
					</div>
				) : groups.length === 0 ? (
					<div className="inno-sidebar-text px-2 py-8 text-center text-[var(--inno-text-subtle)]">
						{state.searchQuery ? t("sidebar.noMatch") : t("sidebar.noSessions")}
					</div>
				) : (
					groups.map((group) => {
						const isGroupCollapsed = collapsedGroups.has(group.id);
						return (
							<div key={group.id} className="mt-3">
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
									pinned={pinnedWsIds.has(group.id)}
									onTogglePin={() => togglePinWorkspace(group.id)}
									onOpenMenu={(el) => { wsMenuBtnRef.current = el; setWsMenuId((prev) => prev === group.id ? null : group.id); }}
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

			{/* Footer: search bar */}
			<div className="shrink-0 bg-[var(--inno-sidebar-bg)] px-2 pt-1.5 pb-20 flex justify-center">
				<div className="relative">
					{showSearch ? (
						<div className="relative w-[304px]">
							<Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)]" />
							<input
								className="inno-sidebar-text w-full rounded-full border-none bg-white py-3 pl-8 pr-8 text-[13px] outline-none placeholder:text-[var(--inno-text-subtle)] focus-visible:ring-2 focus-visible:ring-[#555AFF]/30"
								placeholder={t("sidebar.searchPlaceholder")}
								value={state.searchQuery}
								autoFocus
								onChange={(e) => sessionsStore.setSearchQuery(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Escape") { setShowSearch(false); sessionsStore.setSearchQuery(""); } }}
							/>
							{state.searchQuery && (
								<button
									className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--inno-text-subtle)] hover:text-[var(--inno-text-muted)]"
									onClick={() => sessionsStore.setSearchQuery("")}
								>
									<X size={12} />
								</button>
							)}
						</div>
					) : (
						<div className="relative">
							<Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555AFF]/60 pointer-events-none" />
							<button
								className="inno-sidebar-text w-[304px] rounded-full border-none bg-white py-3 pl-8 pr-3 text-left text-[13px] text-[var(--inno-text-subtle)] transition-colors hover:bg-gray-50"
								onClick={() => setShowSearch(true)}
							>
								{t("sidebar.searchPlaceholder")}
							</button>
						</div>
					)}
				</div>
			</div>
		</aside>
		{activeWsMenu}
		</>
	);
}
