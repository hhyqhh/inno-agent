import {
	useUITransition,
	Spinner,
	ContextMenu,
	type ContextMenuItem,
	Button,
	IconButton,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	DropdownMenu,
	DropdownMenuActionItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuOptionItem,
	DropdownMenuRadioGroup,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Tooltip,
	SegmentedControl,
	ResizeHandle,
	type ResizePoint,
} from "./ui/index.js";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDragDropManager } from "react-dnd";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import {
	Plus,
	Check,
	RefreshCw,
	Sparkles,
	Pencil,
	Trash2,
	Archive,
	ArchiveRestore,
	Pin,
	PinOff,
	Download,
	Clapperboard,
	FolderClosed,
	FolderOpen,
	MoreHorizontal,
	Search,
	Filter,
	ArrowUpDown,
	PanelLeftClose,
	ChevronUp,
	ChevronDown,
	SquarePen,
	BookOpen,
	Puzzle,
	UserRound,
	CalendarClock,
	MessageSquare,
	Settings as SettingsIcon,
	Sun,
	Moon,
	Languages,
} from "lucide-react";
import { appStore, type AppPage } from "../stores/app-store.js";
import { CHAT_ONLY_BP, canOpenWorkspaceBesideSidebar, DESKTOP_SIDEBAR_MIN_WIDTH, getEffectiveWorkspaceWidth, getMaximumSidebarWidth, WORKSPACE_DEFAULT_WIDTH } from "../stores/app-layout.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { themeStore } from "../stores/theme-store.js";
import { setLocale } from "../i18n/index.js";
import type { WorkspaceMeta } from "../api/workspaces.js";
import { triggerDownload } from "../api/workspace.js";
import { exportSessionShowcase } from "../api/sessions.js";
import type { SessionChannel, SessionMeta } from "../api/sessions.js";
import { useStoreSnapshot, useTitleMarquee } from "./hooks.js";
import { getLongPressHandlers } from "./ui/long-press.js";
import { useSidebarPreview } from "./use-sidebar-preview.js";

const SidebarWorkspaceBrowser = lazy(() => import("./WorkspaceBrowser.js").then((module) => ({ default: module.WorkspaceBrowser })));
type SidebarView = "messages" | "files";

export function startNewChat(): void {
	void (async () => {
		await sessionsStore.clearSelection();
		chatStore.clear();
		appStore.setPage("chat");
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceMode("collapsed");
		if (typeof window !== "undefined" && window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`).matches) {
			appStore.setSidebarCollapsed(true);
		}
	})();
}

interface SessionSidebarProps {
	collapsed: boolean;
	isDesktopWindow: boolean;
	onOpenSearch: () => void;
	onPreviewFile: (minimumWidth: number) => void | Promise<void>;
	chatContent?: ReactNode;
	workspaceContent?: ReactNode;
}

interface DesktopSidebarPreviewProps {
	label: string;
	panelRef: RefObject<HTMLElement | null>;
	isPreview: boolean;
	isImmediateDismiss: boolean;
	isCollapsing: boolean;
	isCollapseSettled: boolean;
	visible: boolean;
	onCollapseTransitionEnd: (part: "panel" | "chatTrack") => void;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	onFocusLeave: () => void;
	resizeHandle?: ReactNode;
	children: ReactNode;
}

function DesktopSidebarPreview({
	label,
	panelRef,
	isPreview,
	isImmediateDismiss,
	isCollapsing,
	isCollapseSettled,
	visible,
	onCollapseTransitionEnd,
	onPointerEnter,
	onPointerLeave,
	onFocusLeave,
	resizeHandle,
	children,
}: DesktopSidebarPreviewProps) {
	return (
		<section
			ref={panelRef}
			id="session-sidebar-panel"
			className={`inno-desktop-sidebar-panel${visible ? " is-visible" : ""}${isPreview ? " is-preview" : " is-pinned"}${isImmediateDismiss ? " is-immediate-dismiss" : ""}${isCollapsing ? " is-collapsing" : ""}${isCollapseSettled ? " is-collapse-settled" : ""}`}
			aria-label={label}
			aria-hidden={!visible}
			inert={!visible}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "clip-path") onCollapseTransitionEnd("panel");
			}}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			onFocusCapture={onPointerEnter}
			onBlurCapture={(event: FocusEvent<HTMLElement>) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusLeave();
			}}
		>
			<div className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden bg-[var(--inno-sidebar-bg)]">
				{children}
			</div>
			{resizeHandle}
		</section>
	);
}

const CHANNEL_FILTER_ORDER = ["web", "feishu", "wechat", "cli", "scheduler"] as const;
const WORKSPACE_SORT_STORAGE_KEY = "inno.sidebarWorkspaceSort";
const WORKSPACE_CUSTOM_ORDER_STORAGE_KEY = "inno.sidebarWorkspaceCustomOrder";
const PINNED_SESSIONS_STORAGE_KEY = "inno.sidebarPinnedSessions";
const PINNED_WORKSPACES_STORAGE_KEY = "inno.sidebarPinnedWorkspaces";

type WorkspaceSort = "recent" | "oldest" | "nameAsc" | "nameDesc" | "custom";

function readWorkspaceSort(): WorkspaceSort {
	if (typeof window === "undefined") return "recent";
	const saved = window.localStorage.getItem(WORKSPACE_SORT_STORAGE_KEY);
	return saved === "oldest" || saved === "nameAsc" || saved === "nameDesc" || saved === "custom"
		? saved
		: "recent";
}

function readWorkspaceCustomOrder(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const saved = JSON.parse(window.localStorage.getItem(WORKSPACE_CUSTOM_ORDER_STORAGE_KEY) ?? "[]");
		return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string"))] : [];
	} catch {
		return [];
	}
}

function readPinnedSessionIds(): Set<string> {
	if (typeof window === "undefined") return new Set();
	try {
		const saved = JSON.parse(window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY) ?? "[]");
		return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function readPinnedWorkspaceIds(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const saved = JSON.parse(window.localStorage.getItem(PINNED_WORKSPACES_STORAGE_KEY) ?? "[]");
		return Array.isArray(saved)
			? [...new Set(saved.filter((id): id is string => typeof id === "string"))]
			: [];
	} catch {
		return [];
	}
}

/* ── helpers ── */

function formatTime(iso: string): string {
	try {
		const date = new Date(iso);
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();
		if (isToday) {
			return date.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		}
		return date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return iso;
	}
}

function channelLabel(channel: SessionChannel, t: (key: string) => string): string {
	const labels: Record<string, string> = {
		cli: "CLI",
		web: "Web",
		feishu: "Feishu",
		qq: "QQ",
		wechat: "WeChat",
		unknown: "?",
	};
	// The scheduler badge is user-facing copy (打卡/Check-in), not a brand name —
	// resolve it through i18n like the rest of the UI.
	return channel === "scheduler" ? t("sidebar.channelScheduler") : labels[channel] ?? channel;
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

function menuLabel(icon: ReactNode, label: string) {
	return (
		<span className="flex items-center gap-2">
			{icon}
			<span>{label}</span>
		</span>
	);
}

function menuPosition(element: HTMLElement): { x: number; y: number } {
	const rect = element.getBoundingClientRect();
	return { x: rect.left, y: rect.bottom };
}

type TitleMarqueeState = ReturnType<typeof useTitleMarquee<HTMLDivElement>>;

function SessionTitleRow({
	session,
	titleState,
	editing,
	editingName,
	onEditChange,
	onEditSave,
	onEditCancel,
}: {
	session: SessionMeta;
	titleState: TitleMarqueeState;
	editing: boolean;
	editingName: string;
	onEditChange: (value: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
}) {
	const {
		titleViewportRef,
		titleMeasureRef,
		titleOverflowing,
		marqueeActive,
		marqueeShift,
		titleMarqueeDuration,
	} = titleState;

	return (
		<div className="flex min-w-0 items-start gap-1.5">
			{editing ? (
				<Input
					size="sm"
					className="inno-sidebar-title min-w-0 flex-1 rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-1.5 py-0.5 outline-none"
					value={editingName}
					autoFocus
					onClick={(event) => event.stopPropagation()}
					onChange={(event) => onEditChange(event.target.value)}
					onBlur={onEditSave}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Enter") onEditSave();
						if (event.key === "Escape") onEditCancel();
					}}
				/>
			) : (
				<div ref={titleViewportRef} className="relative min-w-0 flex-1 overflow-hidden">
					<span
						className={`inno-sidebar-title ${marqueeActive ? "inno-sidebar-title-marquee" : "block overflow-hidden whitespace-nowrap"}${titleOverflowing ? " inno-sidebar-title-fade" : ""} font-medium text-[var(--inno-text)]`}
						style={marqueeActive ? ({
							"--inno-title-shift": `-${marqueeShift}px`,
							"--inno-title-duration": `${titleMarqueeDuration}s`,
						} as CSSProperties) : undefined}
					>
						{session.name}
						{titleOverflowing ? <span aria-hidden="true" className="inno-sidebar-title-marquee-tail" /> : null}
					</span>
					<span ref={titleMeasureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 -z-10 w-max whitespace-nowrap">
						{session.name}
					</span>
				</div>
			)}
			<span className="inno-sidebar-meta shrink-0 pt-0.5 tabular-nums text-[var(--inno-text-subtle)]">{formatTime(session.updatedAt)}</span>
		</div>
	);
}

/* ── Workspace group definition ── */

interface WsGroup {
	id: string;
	name: string;
	section: "recent" | "projects" | "channels" | "archived";
	/** Latest visible conversation activity; 0 means the workspace has no visible conversations. */
	activityAt: number;
	/** Whether rename/delete actions are offered (false for temp + archived bucket). */
	manageable: boolean;
	/** Whether the group participates in automatic and custom workspace ordering. */
	sortable: boolean;
	/** Whether a new chat can be started directly in this workspace (false for synthetic groups). */
	canCreate: boolean;
	sessions: SessionMeta[];
}

/* ── Group header component ── */

function GroupHeader({
	group,
	collapsed,
	isPinned,
	onToggle,
	onEnterWorkspace,
	onNewChat,
	onTogglePin,
	editing,
	editingName,
	onStartEdit,
	onEditChange,
	onEditSave,
	onEditCancel,
	onDelete,
	reorderMode,
	dragging,
	canMoveUp,
	canMoveDown,
	onDragStart,
	onDragOver,
	onDragEnd,
	onMoveUp,
	onMoveDown,
}: {
	group: WsGroup;
	collapsed: boolean;
	isPinned: boolean;
	onToggle: () => void;
	onEnterWorkspace: () => void;
	onNewChat: () => void;
	onTogglePin: () => void;
	editing: boolean;
	editingName: string;
	onStartEdit: () => void;
	onEditChange: (v: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onDelete: () => void;
	reorderMode: boolean;
	dragging: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onDragStart: () => void;
	onDragOver: () => void;
	onDragEnd: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}) {
	const { t } = useTranslation();
	const emptyWorkspace = group.canCreate && group.sessions.length === 0;
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [hovered, setHovered] = useState(false);
	const titleState = useTitleMarquee<HTMLDivElement>(group.name, false);
	const menuItems: ContextMenuItem[] = [
		...(group.canCreate
			? [{ label: menuLabel(<Plus size={14} aria-hidden="true" />, t("sidebar.newChatInWorkspace")), onSelect: onNewChat }]
			: []),
		...(group.sortable
			? [{ label: menuLabel(isPinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />, t(isPinned ? "sidebar.unpinWorkspace" : "sidebar.pinWorkspace")), onSelect: onTogglePin }]
			: []),
		...(isPinned && canMoveUp
			? [{ label: menuLabel(<ChevronUp size={14} aria-hidden="true" />, t("sidebar.movePinnedWorkspaceUp")), onSelect: onMoveUp }]
			: []),
		...(isPinned && canMoveDown
			? [{ label: menuLabel(<ChevronDown size={14} aria-hidden="true" />, t("sidebar.movePinnedWorkspaceDown")), onSelect: onMoveDown }]
			: []),
		...(group.manageable
			? [
				{ label: menuLabel(<Pencil size={14} aria-hidden="true" />, t("sidebar.renameWorkspace")), onSelect: onStartEdit },
				{ label: menuLabel(<Trash2 size={14} aria-hidden="true" />, t("sidebar.deleteWorkspace")), danger: true, onSelect: onDelete },
			]
			: []),
	];
	const canDrag = reorderMode || isPinned;
	const compactGroup = group.section === "projects" || group.section === "channels" || group.section === "archived";
	const actionLayout = compactGroup
		? `inno-sidebar-workspace-actions--compact${hovered || reorderMode ? " inno-sidebar-workspace-actions--compact-flow" : ""}`
		: "absolute top-1/2 -translate-y-1/2";
	const actionVisibility = reorderMode
		? "pointer-events-auto opacity-100"
		: group.section === "projects"
			? "pointer-events-none opacity-0 group-hover/wsh:pointer-events-auto group-hover/wsh:opacity-100 group-focus-visible/wsh:pointer-events-auto group-focus-visible/wsh:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
			: "pointer-events-none opacity-0 group-hover/wsh:pointer-events-auto group-hover/wsh:opacity-100 group-focus-within/wsh:pointer-events-auto group-focus-within/wsh:opacity-100 max-md:pointer-events-auto max-md:opacity-100";
	return (
		<div
			draggable={canDrag}
			onDragStart={(e) => {
				if (!canDrag) return;
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", group.id);
				onDragStart();
			}}
			onDragOver={(e) => {
				if (!canDrag) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				onDragOver();
			}}
			onDragEnd={onDragEnd}
			onContextMenu={(event) => {
				if (reorderMode || menuItems.length === 0) return;
				event.preventDefault();
				setMenu({ x: event.clientX, y: event.clientY });
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocusCapture={() => setHovered(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false);
			}}
			className={`inno-sidebar-workspace-header group/wsh relative flex w-full items-center gap-1 rounded-lg px-2 ${compactGroup ? "inno-sidebar-workspace-header--compact" : "py-2"} transition-opacity ${canDrag ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-45" : ""}`}
		>
			<button
				className="inno-sidebar-workspace-button flex min-w-0 flex-1 items-center gap-2 text-[12px] font-medium text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text)]"
				aria-label={emptyWorkspace ? t("sidebar.loadWorkspace") : collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
				aria-expanded={emptyWorkspace ? undefined : !collapsed}
				onClick={() => {
					if (reorderMode) return;
					if (emptyWorkspace) onEnterWorkspace();
					else onToggle();
				}}
			>
				{collapsed
						? <FolderClosed size={14} className="shrink-0 text-[var(--inno-text-subtle)]" aria-hidden="true" />
						: <FolderOpen size={14} className="shrink-0 text-[var(--inno-text-subtle)]" aria-hidden="true" />}
				<div ref={titleState.titleViewportRef} className="inno-sidebar-workspace-title-viewport relative flex min-w-0 flex-1 items-center overflow-hidden">
					{editing ? (
						<Input
							size="sm"
							className="inno-sidebar-title min-w-0 flex-1 rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-1 py-0.5 text-[11px] normal-case text-[var(--inno-text)] outline-none"
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
						<span
							className={`inno-sidebar-title block min-w-0 overflow-hidden whitespace-nowrap text-ellipsis${hovered && titleState.titleOverflowing ? " inno-sidebar-title-fade" : ""}${group.section === "projects" && collapsed ? " inno-sidebar-workspace-title--collapsed" : ""} font-medium text-[var(--inno-text-subtle)]`}
						>
							{group.name}
						</span>
					)}
					<span ref={titleState.titleMeasureRef} aria-hidden="true" className="inno-sidebar-title pointer-events-none invisible absolute left-0 top-0 -z-10 w-max whitespace-nowrap font-medium">
						{group.name}
					</span>
				</div>
			</button>
			<div className="inno-sidebar-workspace-trailing relative flex shrink-0 items-center">
				<div className={`inno-sidebar-workspace-actions ${actionLayout} z-10 flex shrink-0 items-center gap-1 transition-opacity ${actionVisibility}`}>
					{group.canCreate ? (
						<IconButton
							size="compact"
							className="inno-sidebar-workspace-action"
							aria-label={t("sidebar.newChatInWorkspace")}
							title={t("sidebar.newChatInWorkspace")}
							onClick={(event) => { event.stopPropagation(); onNewChat(); }}
						>
							<Plus size={13} />
						</IconButton>
					) : null}
					{group.sortable ? (
						<IconButton
							size="compact"
							className="inno-sidebar-workspace-action"
							aria-label={t(isPinned ? "sidebar.unpinWorkspace" : "sidebar.pinWorkspace")}
							title={t(isPinned ? "sidebar.unpinWorkspace" : "sidebar.pinWorkspace")}
							aria-pressed={isPinned}
							onClick={(event) => { event.stopPropagation(); onTogglePin(); }}
						>
							{isPinned ? <PinOff size={13} /> : <Pin size={13} />}
						</IconButton>
					) : null}
					{menuItems.length > 0 ? (
						<IconButton
							size="compact"
							className="inno-sidebar-workspace-action"
							aria-label={t("sidebar.workspaceActions")}
							title={t("sidebar.workspaceActions")}
							onClick={(event) => { event.stopPropagation(); setMenu(menuPosition(event.currentTarget)); }}
						>
							<MoreHorizontal size={14} />
						</IconButton>
					) : null}
					{reorderMode ? (
						<div className="relative z-[1] flex items-center gap-0.5">
							<IconButton
								size="compact"
								className="inno-sidebar-workspace-move"
								aria-label={t("sidebar.moveWorkspaceUp")}
								disabled={!canMoveUp}
								title={t("sidebar.moveWorkspaceUp")}
								onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
							>
								<ChevronUp size={12} />
							</IconButton>
							<IconButton
								size="compact"
								className="inno-sidebar-workspace-move"
								aria-label={t("sidebar.moveWorkspaceDown")}
								disabled={!canMoveDown}
								title={t("sidebar.moveWorkspaceDown")}
								onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
							>
								<ChevronDown size={12} />
							</IconButton>
						</div>
					) : null}
				</div>
			</div>
			{menu ? createPortal(
				<ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
				document.body,
			) : null}
		</div>
	);
}

/* ── Session card ── */

function SessionCard({
	session,
	active,
	opening,
	pinned,
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
	onTogglePin,
	onDelete,
	onExport,
	onExportShowcase,
}: {
	session: SessionMeta;
	active: boolean;
	opening: boolean;
	pinned: boolean;
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
	onTogglePin: () => void;
	onDelete: () => void;
	onExport: () => void;
	onExportShowcase: () => void;
}) {
	const { t } = useTranslation();
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [hovered, setHovered] = useState(false);
	const titleChannel = session.origin ?? session.channels[0] ?? "unknown";
	const titleState = useTitleMarquee<HTMLDivElement>(session.name, hovered);
	const menuItems: ContextMenuItem[] = [
		{
			label: menuLabel(
				generatingId === session.id ? <Spinner size={14} /> : <Sparkles size={14} aria-hidden="true" />,
				t("sidebar.generateTopic"),
			),
			onSelect: onGenerate,
		},
		{
			label: menuLabel(<Pencil size={14} aria-hidden="true" />, t("sidebar.rename")),
			onSelect: onStartEdit,
		},
		{
			label: menuLabel(<Download size={14} aria-hidden="true" />, t("sessions.export", "导出为 Markdown")),
			onSelect: onExport,
		},
		{
			label: menuLabel(<Clapperboard size={14} aria-hidden="true" />, t("sessions.exportShowcase", "导出为回放案例")),
			onSelect: onExportShowcase,
		},
		{
			label: menuLabel(
				session.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />,
				session.archived ? t("sidebar.unarchive") : t("sidebar.archive"),
			),
			onSelect: onArchive,
		},
		{
			label: menuLabel(
				pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />,
				pinned ? t("sidebar.unpin") : t("sidebar.pin"),
			),
			onSelect: onTogglePin,
		},
		{
			label: menuLabel(<Trash2 size={14} aria-hidden="true" />, t("common.delete")),
			danger: true,
			onSelect: onDelete,
		},
	];
	return (
		<div
			className={`inno-sidebar-session-card group/card relative mb-0.5 w-full cursor-pointer select-none rounded-lg border px-2.5 py-1.5 text-left transition-all duration-150 ${active ? "border-transparent bg-[var(--inno-sidebar-active)] shadow-none" : "border-transparent hover:bg-[var(--inno-surface-muted)]"}`}
			role="button"
			tabIndex={0}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY });
			}}
			{...getLongPressHandlers((x, y) => setMenu({ x, y }))}
		>
			<SessionTitleRow
				session={session}
				titleState={titleState}
				editing={editing}
				editingName={editingName}
				onEditChange={onEditChange}
				onEditSave={onEditSave}
				onEditCancel={onEditCancel}
			/>

			{/* Subtitle row: preview + channel/actions */}
			<div className="mt-1 flex min-w-0 items-center justify-between gap-1">
				<div className={`inno-sidebar-meta min-w-0 flex-1 truncate text-[var(--inno-text-subtle)]${hovered ? " inno-sidebar-session-preview-fade" : ""}`}>
					{session.preview || null}
				</div>
				<div className="inno-sidebar-session-actions-container relative flex h-4 min-w-[2.25rem] shrink-0 items-center justify-end max-md:h-auto">
					<Tooltip label={t("sidebar.originChannel", { channel: channelLabel(titleChannel, t) })}>
						<span className={`rounded px-1.5 py-px text-[9px] font-medium leading-none transition-opacity duration-150 group-hover/card:opacity-0 max-md:opacity-100 ${channelClass(titleChannel)}`}>
							{channelLabel(titleChannel, t)}
						</span>
					</Tooltip>
					<div className="inno-sidebar-session-actions pointer-events-none absolute right-0 flex items-center gap-0.5 opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 max-md:static max-md:pointer-events-auto max-md:opacity-100">
						{opening ? <Spinner size={12} className="text-[var(--inno-border-strong)]" /> : null}
						<IconButton
							size="compact"
							className="max-md:hidden"
							aria-label={session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
							title={session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
							onClick={(event) => { event.stopPropagation(); onArchive(); }}
						>
							{session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
						</IconButton>
						<IconButton
							size="compact"
							className="max-md:hidden"
							aria-pressed={pinned}
							aria-label={pinned ? t("sidebar.unpin") : t("sidebar.pin")}
							title={pinned ? t("sidebar.unpin") : t("sidebar.pin")}
							onClick={(event) => { event.stopPropagation(); onTogglePin(); }}
						>
							{pinned ? <PinOff size={12} /> : <Pin size={12} />}
						</IconButton>
						<IconButton
							size="compact"
							aria-label={t("sidebar.sessionActions")}
							title={t("sidebar.sessionActions")}
							onClick={(event) => { event.stopPropagation(); setMenu(menuPosition(event.currentTarget)); }}
						>
							<MoreHorizontal size={14} />
						</IconButton>
					</div>
				</div>
			</div>
			{menu ? createPortal(
				<ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
				document.body,
			) : null}
		</div>
	);
}


/* ── Workbench nav item ── */

function NavItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			className="inno-sidebar-nav-button"
			aria-current={active ? "page" : undefined}
			onClick={onClick}
		>
			<span className="shrink-0 text-[var(--inno-text-muted)]">{icon}</span>
			<span className="min-w-0 truncate text-sm">{label}</span>
		</Button>
	);
}

/* ── Bottom user menu (theme / language / settings) ── */

function SidebarUserMenu({ compact = false }: { compact?: boolean }) {
	const { t, i18n } = useTranslation();
	const [open, setOpen] = useState(false);
	const theme = useStoreSnapshot(themeStore, () => themeStore.current);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={`inno-sidebar-user-trigger${compact ? " inno-sidebar-user-trigger--compact" : ""}${open ? " is-open" : ""}`}
					aria-label={compact ? t("nav.settings") : undefined}
				>
					<span className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-text)]">IA</span>
					{!compact ? <>
						<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--inno-text)]">Inno Agent</span>
						<SettingsIcon size={14} className="shrink-0 text-[var(--inno-text-subtle)]" />
					</> : null}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side={compact ? "right" : "top"} align={compact ? "end" : "start"} sideOffset={6} aria-label={t("nav.settings")} className="inno-sidebar-user-menu">
				<DropdownMenuLabel>{t("nav.theme")}</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={theme} onValueChange={(value) => void themeStore.save(value as "light" | "dark")}>
					{(["light", "dark"] as const).map((id) => (
						<DropdownMenuOptionItem
							key={id}
							value={id}
							icon={id === "light" ? <Sun size={14} /> : <Moon size={14} />}
							label={t(`settings.themeOptions.${id}`)}
							className="inno-sidebar-user-menu-option"
							onSelect={(event) => event.preventDefault()}
						/>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuLabel>{t("nav.language")}</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={i18n.language} onValueChange={(value) => setLocale(value as "zh-CN" | "en")}>
					{(["zh-CN", "en"] as const).map((lng) => (
						<DropdownMenuOptionItem
							key={lng}
							value={lng}
							icon={<Languages size={14} />}
							label={t(`settings.languageOptions.${lng}`)}
							className="inno-sidebar-user-menu-option"
							onSelect={(event) => event.preventDefault()}
						/>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuActionItem
					icon={<SettingsIcon size={14} />}
					label={t("nav.settings")}
					className="inno-sidebar-user-menu-option"
					onSelect={() => appStore.openSettings("general")}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/* ── Main sidebar ── */

export function SessionSidebar({ collapsed, isDesktopWindow, onOpenSearch, onPreviewFile, chatContent, workspaceContent }: SessionSidebarProps) {
	const uiTransition = useUITransition();
	const panelTransition = useUITransition("modal");
	const dndManager = useDragDropManager();
	const { t } = useTranslation();
	const [sidebarView, setSidebarView] = useState<SidebarView>("messages");
	const [previewView, setPreviewView] = useState<SidebarView>("messages");
	const [hasOpenedFiles, setHasOpenedFiles] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [generatingId, setGeneratingId] = useState<string | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(["archived"]));
	const groupExpansionInitialized = useRef(false);
	const collapsedGroupsBeforeCustomSort = useRef<Set<string> | null>(null);
	const [editingWsId, setEditingWsId] = useState<string | null>(null);
	const [editingWsName, setEditingWsName] = useState("");
	const [workspaceSort, setWorkspaceSort] = useState<WorkspaceSort>(readWorkspaceSort);
	const [customOrder, setCustomOrder] = useState<string[]>(readWorkspaceCustomOrder);
	const [sortMenuOpen, setSortMenuOpen] = useState(false);
	const [projectSectionCollapsed, setProjectSectionCollapsed] = useState(false);
	const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
	const [projectCreateOpen, setProjectCreateOpen] = useState(false);
	const [projectName, setProjectName] = useState("");
	const [projectCreating, setProjectCreating] = useState(false);
	const [projectCreateError, setProjectCreateError] = useState("");
	const [isCustomSorting, setIsCustomSorting] = useState(false);
	const [customOrderDraft, setCustomOrderDraft] = useState<string[]>([]);
	const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
	const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(readPinnedSessionIds);
	const [pinnedWorkspaceIds, setPinnedWorkspaceIds] = useState<string[]>(readPinnedWorkspaceIds);
	const [recentSectionCollapsed, setRecentSectionCollapsed] = useState(false);
	const [recentExpanded, setRecentExpanded] = useState(false);
	const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({});
	const [sessionListScrolled, setSessionListScrolled] = useState(false);

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
	const layout = useStoreSnapshot(appStore, () => ({ page: appStore.page, sidebarWidth: appStore.sidebarWidth, workspaceMode: appStore.workspaceMode, workspaceWidth: appStore.workspaceWidth }));
	const { page } = layout;
	const desktopRailRef = useRef<HTMLElement>(null);
	const desktopPanelRef = useRef<HTMLElement>(null);
	const sidebarResizingRef = useRef(false);
	const previousCollapsed = useRef(collapsed);
	const previousPage = useRef(page);
	const immediateDismissFrameRef = useRef<number | null>(null);
	const collapseTransitionEndsRef = useRef({ panel: false, chatTrack: false });
	const [isCollapsing, setIsCollapsing] = useState(false);
	const [suppressSidebarFade, setSuppressSidebarFade] = useState(false);
	const [isImmediateSidebarDismiss, setIsImmediateSidebarDismiss] = useState(false);
	useLayoutEffect(() => {
		if (collapsed && !isDesktopWindow) setSessionListScrolled(false);
	}, [collapsed, isDesktopWindow]);
	const keepPreviewForFocus = useCallback(() => {
		const activeElement = document.activeElement;
		if (desktopRailRef.current?.contains(activeElement) || desktopPanelRef.current?.contains(activeElement)) return true;
		const activeMenu = activeElement instanceof HTMLElement ? activeElement.closest<HTMLElement>("[role='menu']") : null;
		return Boolean(activeMenu);
	}, []);
	const sidebarPreviewEnabled = isDesktopWindow && (collapsed || page !== "chat");
	const preview = useSidebarPreview(sidebarPreviewEnabled, keepPreviewForFocus);
	const railExpanded = page === "chat" || preview.previewOpen;
	// Page-only checks left collapsed chat previews locked to the committed panel.
	// Both preview entry points use a temporary view without changing that selection.
	const visibleSidebarView = sidebarPreviewEnabled && preview.previewOpen ? previewView : sidebarView;
	const desktopPanelVisible = ((!collapsed || isCollapsing) && page === "chat") || preview.previewOpen;
	const desktopPanelPreview = page !== "chat"
		|| (collapsed && !isCollapsing && (!suppressSidebarFade || preview.previewOpen));
	const occupiedWorkspaceWidth = page === "chat" && (layout.workspaceMode === "half" || layout.workspaceMode === "quarter")
		? getEffectiveWorkspaceWidth(layout.workspaceWidth, layout.workspaceMode) : 0;
	const maximumSidebarWidth = getMaximumSidebarWidth(typeof window === "undefined" ? 1440 : window.innerWidth, occupiedWorkspaceWidth, desktopPanelPreview);
	const schedulePreviewPointerClose = useCallback(() => {
		if (!sidebarResizingRef.current) preview.schedulePointerClose();
	}, [preview.schedulePointerClose]);
	const startSidebarResize = useCallback(() => {
		sidebarResizingRef.current = true;
		preview.cancelClose();
	}, [preview.cancelClose]);
	const finishSidebarResize = useCallback((point: ResizePoint | null) => {
		sidebarResizingRef.current = false;
		if (!point) return;
		const containsPointer = [desktopPanelRef.current, desktopRailRef.current].some((element) => {
			const rect = element?.getBoundingClientRect();
			return rect && point.clientX >= rect.left && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom;
		});
		if (!containsPointer) preview.schedulePointerClose();
	}, [preview.schedulePointerClose]);
	const resizeSidebar = useCallback((width: number) => appStore.setSidebarWidth(width), []);
	const handleCollapseTransitionEnd = useCallback((part: "panel" | "chatTrack") => {
		if (!collapsed || !isCollapsing || page !== "chat") return;
		const ended = { ...collapseTransitionEndsRef.current, [part]: true };
		collapseTransitionEndsRef.current = ended;
		if (ended.panel && ended.chatTrack) setIsCollapsing(false);
	}, [collapsed, isCollapsing, page]);

	useLayoutEffect(() => {
		const wasCollapsed = previousCollapsed.current;
		const wasChatPage = previousPage.current === "chat";
		const returningToChat = !wasChatPage && page === "chat";
		previousCollapsed.current = collapsed;
		previousPage.current = page;
		if (returningToChat) {
			setSuppressSidebarFade(collapsed && !preview.previewOpen);
		}
		if (immediateDismissFrameRef.current !== null) {
			window.cancelAnimationFrame(immediateDismissFrameRef.current);
			immediateDismissFrameRef.current = null;
		}

		if (wasChatPage && page !== "chat" && !collapsed) {
			setIsImmediateSidebarDismiss(true);
			immediateDismissFrameRef.current = window.requestAnimationFrame(() => {
				immediateDismissFrameRef.current = window.requestAnimationFrame(() => {
					immediateDismissFrameRef.current = null;
					setIsImmediateSidebarDismiss(false);
				});
			});
		} else {
			setIsImmediateSidebarDismiss(false);
		}

		if (collapsed && !wasCollapsed && page === "chat") {
			collapseTransitionEndsRef.current = { panel: false, chatTrack: false };
			setIsCollapsing(true);
			setSuppressSidebarFade(true);
		} else {
			collapseTransitionEndsRef.current = { panel: false, chatTrack: false };
			setIsCollapsing(false);
			if (!collapsed || page !== "chat") setSuppressSidebarFade(false);
		}
	}, [collapsed, page, preview.previewOpen]);

	useEffect(() => {
		if (preview.previewOpen) setSuppressSidebarFade(false);
	}, [preview.previewOpen]);

	useEffect(() => () => {
		if (immediateDismissFrameRef.current !== null) window.cancelAnimationFrame(immediateDismissFrameRef.current);
	}, []);

	const orderedChannels = CHANNEL_FILTER_ORDER.filter((ch) => state.availableChannels.includes(ch as SessionChannel));
	const workspaceFiltering = Boolean(state.searchQuery || state.channelFilter);

	useEffect(() => {
		if (!sortMenuOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSortMenuOpen(false);
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [sortMenuOpen]);

	// Keep temporary/unassigned conversations in a short Recent list. Named
	// workspaces remain project groups, with channel and archived groups below.
	const { recentSessions, pinnedGroups, groups } = useMemo(() => {
		const sortSessions = (sessions: SessionMeta[]) => sessions.slice().sort((a, b) => (
			Number(pinnedSessionIds.has(b.id)) - Number(pinnedSessionIds.has(a.id))
		));
		const sortRecentSessions = (sessions: SessionMeta[]) => sessions.slice().sort((a, b) => {
			const pinnedOrder = Number(pinnedSessionIds.has(b.id)) - Number(pinnedSessionIds.has(a.id));
			if (pinnedOrder !== 0) return pinnedOrder;
			return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
		});
		const sessionToWs = new Map<string, WorkspaceMeta>();
		for (const w of wsState.list) {
			for (const sid of w.sessionIds ?? []) sessionToWs.set(sid, w);
		}
		const archived: SessionMeta[] = [];
		const recent: SessionMeta[] = [];
		const byWs = new Map<string, SessionMeta[]>();
		for (const s of state.filteredSessions) {
			// Empty sessions fall back to their timestamp-based file id as a name.
			// Keep them out of the sidebar until a real title is available.
			const fallbackName = s.id.replace(/\.jsonl$/, "");
			if (!s.hasTopic && (s.name.trim() === s.id || s.name.trim() === fallbackName)) continue;
			if (s.archived) { archived.push(s); continue; }
			const w = sessionToWs.get(s.id);
			if (!w || w.isTemp) { recent.push(s); continue; }
			if (!byWs.has(w.id)) byWs.set(w.id, []);
			byWs.get(w.id)!.push(s);
		}
		const visibleRecentSessions = sortRecentSessions(recent);
		const result: WsGroup[] = [];
		// User projects come first, followed by channel and archived groups.
		const CHANNEL_WS_ORDER = ["channel-feishu", "channel-wechat", "channel-cli"];
		const channelGroups = new Map<string, WsGroup>();
		const sortableGroups: WsGroup[] = [];
		// When a search/filter is active, only show groups that have matching
		// sessions so the list narrows as expected.
		const filtering = !!state.searchQuery || !!state.channelFilter;
		for (const w of wsState.list) {
			if (w.isTemp) continue;
			const sessions = byWs.get(w.id) ?? [];
			const isChannel = CHANNEL_WS_ORDER.includes(w.id);
			// Channel workspaces are synthetic/auto-managed — hide them when they
			// have no sessions. Project workspaces always show,
			// even with zero sessions, so they stay visible and deletable after
			// their last session is removed (unless a filter is narrowing the list).
			if (sessions.length === 0 && (isChannel || filtering)) continue;
			const latestSessionAt = sessions.reduce((latest, session) => {
				const timestamp = Date.parse(session.updatedAt);
				return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
			}, 0);
			const g: WsGroup = {
				id: w.id,
				name: w.name,
				section: isChannel ? "channels" : "projects",
				activityAt: latestSessionAt,
				manageable: !isChannel,
				sortable: !isChannel,
				canCreate: true,
				sessions: sortSessions(sessions),
			};
			if (isChannel) {
				channelGroups.set(w.id, g);
			} else {
				sortableGroups.push(g);
			}
		}
		const activeCustomOrder = isCustomSorting ? customOrderDraft : customOrder;
		if ((workspaceSort === "recent" || workspaceSort === "oldest") && !isCustomSorting) {
			const direction = workspaceSort === "recent" ? -1 : 1;
			sortableGroups.sort((a, b) => {
				if (a.activityAt === 0 && b.activityAt !== 0) return 1;
				if (b.activityAt === 0 && a.activityAt !== 0) return -1;
				return direction * (a.activityAt - b.activityAt);
			});
		} else if ((workspaceSort === "nameAsc" || workspaceSort === "nameDesc") && !isCustomSorting) {
			const direction = workspaceSort === "nameAsc" ? 1 : -1;
			sortableGroups.sort((a, b) => direction * a.name.localeCompare(b.name));
		} else if (workspaceSort === "custom" || isCustomSorting) {
			const positions = new Map(activeCustomOrder.map((id, index) => [id, index]));
			sortableGroups.sort((a, b) => {
				const aPos = positions.get(a.id);
				const bPos = positions.get(b.id);
				if (aPos === undefined && bPos === undefined) return 0;
				if (aPos === undefined) return -1;
				if (bPos === undefined) return 1;
				return aPos - bPos;
			});
		}
		const groupsById = new Map(sortableGroups.map((group) => [group.id, group]));
		const pinnedIdSet = new Set(pinnedWorkspaceIds);
		const orderedPinnedGroups = pinnedWorkspaceIds.flatMap((id) => {
			const group = groupsById.get(id);
			return group ? [group] : [];
		});
		result.push(...sortableGroups.filter((group) => !pinnedIdSet.has(group.id)));
		// Channel workspaces in fixed order.
		for (const id of CHANNEL_WS_ORDER) {
			const g = channelGroups.get(id);
			if (g) result.push(g);
		}
		if (archived.length > 0) {
			result.push({ id: "archived", name: t("sidebar.archived"), section: "archived", activityAt: 0, manageable: false, sortable: false, canCreate: false, sessions: sortSessions(archived) });
		}
		return { recentSessions: visibleRecentSessions, pinnedGroups: orderedPinnedGroups, groups: result };
	}, [wsState.list, state.filteredSessions, state.searchQuery, state.channelFilter, t, workspaceSort, customOrder, isCustomSorting, customOrderDraft, pinnedSessionIds, pinnedWorkspaceIds]);

	const allWorkspaceGroups = [...pinnedGroups, ...groups];

	useLayoutEffect(() => {
		if (groupExpansionInitialized.current || state.isLoading || workspaceFiltering || allWorkspaceGroups.length === 0) return;
		groupExpansionInitialized.current = true;
		setCollapsedGroups(new Set(allWorkspaceGroups.filter((group) => group.id !== wsActive.activeWorkspaceId).map((group) => group.id)));
	}, [allWorkspaceGroups.length, state.isLoading, workspaceFiltering, wsActive.activeWorkspaceId]);

	useLayoutEffect(() => {
		const activeWorkspaceId = wsActive.activeWorkspaceId;
		if (!groupExpansionInitialized.current || !activeWorkspaceId) return;
		setCollapsedGroups((current) => {
			if (!current.has(activeWorkspaceId)) return current;
			const next = new Set(current);
			next.delete(activeWorkspaceId);
			return next;
		});
	}, [wsActive.activeWorkspaceId]);

	const sortableGroupIds = useMemo(() => groups.filter((group) => group.sortable).map((group) => group.id), [groups]);

	const chooseWorkspaceSort = useCallback((sort: Exclude<WorkspaceSort, "custom">) => {
		setWorkspaceSort(sort);
		setIsCustomSorting(false);
		setSortMenuOpen(false);
		window.localStorage.setItem(WORKSPACE_SORT_STORAGE_KEY, sort);
	}, []);

	const beginCustomSort = useCallback(() => {
		setCustomOrderDraft(sortableGroupIds);
		collapsedGroupsBeforeCustomSort.current = new Set(collapsedGroups);
		setCollapsedGroups(new Set(groups.map((group) => group.id)));
		setDraggingWorkspaceId(null);
		setIsCustomSorting(true);
		setSortMenuOpen(false);
	}, [collapsedGroups, groups, sortableGroupIds]);

	const finishCustomSort = useCallback(() => {
		const nextCustomOrder = customOrder.slice();
		const pinned = new Set(pinnedWorkspaceIds);
		let cursor = 0;
		for (let index = 0; index < nextCustomOrder.length && cursor < customOrderDraft.length; index++) {
			if (!pinned.has(nextCustomOrder[index])) nextCustomOrder[index] = customOrderDraft[cursor++];
		}
		nextCustomOrder.push(...customOrderDraft.slice(cursor));
		setCustomOrder(nextCustomOrder);
		setWorkspaceSort("custom");
		setIsCustomSorting(false);
		setCollapsedGroups(new Set(collapsedGroupsBeforeCustomSort.current ?? []));
		collapsedGroupsBeforeCustomSort.current = null;
		setDraggingWorkspaceId(null);
		window.localStorage.setItem(WORKSPACE_SORT_STORAGE_KEY, "custom");
		window.localStorage.setItem(WORKSPACE_CUSTOM_ORDER_STORAGE_KEY, JSON.stringify(nextCustomOrder));
	}, [customOrder, customOrderDraft, pinnedWorkspaceIds]);

	const cancelCustomSort = useCallback(() => {
		setIsCustomSorting(false);
		setCollapsedGroups(new Set(collapsedGroupsBeforeCustomSort.current ?? []));
		collapsedGroupsBeforeCustomSort.current = null;
		setDraggingWorkspaceId(null);
		setCustomOrderDraft([]);
	}, []);

	const moveCustomWorkspace = useCallback((workspaceId: string, targetIndex: number) => {
		setCustomOrderDraft((current) => {
			const fromIndex = current.indexOf(workspaceId);
			if (fromIndex < 0 || targetIndex < 0 || targetIndex >= current.length || fromIndex === targetIndex) return current;
			const next = [...current];
			next.splice(fromIndex, 1);
			next.splice(targetIndex, 0, workspaceId);
			return next;
		});
	}, []);

	const moveDraggedWorkspaceBefore = useCallback((targetId: string) => {
		if (!draggingWorkspaceId || draggingWorkspaceId === targetId) return;
		setCustomOrderDraft((current) => {
			const fromIndex = current.indexOf(draggingWorkspaceId);
			const targetIndex = current.indexOf(targetId);
			if (fromIndex < 0 || targetIndex < 0) return current;
			const next = [...current];
			next.splice(fromIndex, 1);
			next.splice(targetIndex, 0, draggingWorkspaceId);
			return next;
		});
	}, [draggingWorkspaceId]);

	const togglePinnedWorkspace = useCallback((id: string) => {
		setPinnedWorkspaceIds((current) => {
			const next = current.includes(id) ? current.filter((workspaceId) => workspaceId !== id) : [...current, id];
			try {
				window.localStorage.setItem(PINNED_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Pinning is a local UI preference; keep the in-memory state if storage is unavailable.
			}
			return next;
		});
	}, []);

	const movePinnedWorkspace = useCallback((id: string, offset: number) => {
		setPinnedWorkspaceIds((current) => {
			const from = current.indexOf(id);
			const to = from + offset;
			if (from < 0 || to < 0 || to >= current.length) return current;
			const next = [...current];
			[next[from], next[to]] = [next[to], next[from]];
			try {
				window.localStorage.setItem(PINNED_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Keep the in-memory order if storage is unavailable.
			}
			return next;
		});
	}, []);

	const moveDraggedPinnedWorkspaceBefore = useCallback((targetId: string) => {
		if (!draggingWorkspaceId || draggingWorkspaceId === targetId || workspaceFiltering) return;
		setPinnedWorkspaceIds((current) => {
			const from = current.indexOf(draggingWorkspaceId);
			if (from < 0 || !current.includes(targetId)) return current;
			const next = [...current];
			next.splice(from, 1);
			next.splice(next.indexOf(targetId), 0, draggingWorkspaceId);
			if (next.every((id, index) => id === current[index])) return current;
			try {
				window.localStorage.setItem(PINNED_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Keep the in-memory order if storage is unavailable.
			}
			return next;
		});
	}, [draggingWorkspaceId, workspaceFiltering]);

	// Page navigation at narrow widths: the sidebar is an overlay drawer there,
	// so dismiss it once the destination page is shown.
	const navigateTo = useCallback((page: AppPage) => {
		if (page !== "chat") preview.closePreview();
		appStore.setPage(page);
		if (!isDesktopWindow && typeof window !== "undefined" && window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`).matches) {
			appStore.setSidebarCollapsed(true);
		}
	}, [isDesktopWindow, preview.closePreview]);
	const selectSidebarView = useCallback((view: SidebarView) => {
		setSidebarView(view);
		setPreviewView(view);
		if (view === "files") setHasOpenedFiles(true);
		navigateTo("chat");
	}, [navigateTo]);
	const previewSidebarView = useCallback((view: SidebarView) => {
		setPreviewView(view);
		if (view === "files") setHasOpenedFiles(true);
	}, []);
	const openSidebarFile = useCallback((minimumWidth: number) => {
		setSidebarView("files");
		navigateTo("chat");
		return onPreviewFile(minimumWidth);
	}, [navigateTo, onPreviewFile]);

	const togglePinned = useCallback((id: string) => {
		setPinnedSessionIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			try {
				window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...next]));
			} catch {
				// Pinning is a local UI preference; keep the in-memory state if storage is unavailable.
			}
			return next;
		});
	}, []);

	// An empty workspace has no sessions to reveal, so select it without opening the file preview.
	const enterWorkspace = useCallback((group: WsGroup) => {
		if (!group.canCreate) return;
		appStore.setPage("chat");
		void workspaceStore.setActiveWorkspace(group.id);
	}, []);

	// Start a new chat pre-bound to this workspace → preview its files (quarter, tree only).
	const newChatIn = useCallback((group: WsGroup) => {
		appStore.setPage("chat");
		sessionsStore.beginNewSessionIn(group.id);
		void workspaceStore.setActiveWorkspace(group.id);
		// At narrow widths the composer for the fresh chat matters more than a
		// file preview; leave the workspace panel closed (chat-first).
		if (typeof window !== "undefined" && window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`).matches) {
			appStore.setSidebarCollapsed(true);
			return;
		}
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(300);
		appStore.setWorkspaceMode("quarter");
	}, []);

	// Open a session → preview its workspace files (quarter, tree only).
	const openSession = useCallback((session: SessionMeta) => {
		appStore.setPage("chat");
		// Drawer navigation at narrow widths: close the drawer and show the
		// conversation. The workspace preview stays closed — at this width it
		// only exists as an explicit full-screen overlay.
		if (typeof window !== "undefined" && window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`).matches) {
			appStore.setSidebarCollapsed(true);
			void sessionsStore.openSession(session.id);
			return;
		}
		const workspaceWasCollapsed = appStore.workspaceMode === "collapsed";
		// At the narrowest split layout, opening the preview would make the
		// layout hide the session sidebar to reclaim its width. Keep both the
		// current conversation and the session list accessible in that case.
		const canOpenWorkspace = appStore.workspaceMode !== "collapsed"
			|| typeof window === "undefined"
			|| appStore.sidebarCollapsed
			|| canOpenWorkspaceBesideSidebar(window.innerWidth, 300, isDesktopWindow, appStore.sidebarWidth);
		if (canOpenWorkspace) {
			appStore.setRightPanelTab("preview");
			// 300px is the default only when opening the workspace from its
			// collapsed state. Switching conversations must preserve a width the
			// user already chose instead of nudging the panel narrower each time.
			if (workspaceWasCollapsed) appStore.setWorkspaceWidth(300);
			appStore.setWorkspaceMode("quarter");
		}
		void sessionsStore.openSession(session.id);
	}, [isDesktopWindow]);

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

	const handleExportShowcase = useCallback((session: SessionMeta) => {
		void (async () => {
			try {
				const result = await exportSessionShowcase(session.id);
				window.alert(t("sessions.exportShowcaseDone", { title: result.title, dir: result.casesDir }));
			} catch (err) {
				window.alert(t("sessions.exportShowcaseFailed", { message: err instanceof Error ? err.message : String(err) }));
			}
		})();
	}, [t]);

	const handleDelete = useCallback((session: SessionMeta) => {
		const confirmed = typeof window === "undefined" ? true : window.confirm(t("sidebar.confirmDeleteSession", { name: session.name }));
		if (!confirmed) return;
		setPinnedSessionIds((current) => {
			if (!current.has(session.id)) return current;
			const next = new Set(current);
			next.delete(session.id);
			try {
				window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...next]));
			} catch {
				// The session is still removed from the in-memory pin list.
			}
			return next;
		});
		void sessionsStore.deleteSession(session.id);
	}, [t]);

	const toggleGroup = useCallback((key: string) => {
		const collapsing = !collapsedGroups.has(key);
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
		if (collapsing) {
			setVisibleSessionCounts((current) => {
				if (!(key in current)) return current;
				const next = { ...current };
				delete next[key];
				return next;
			});
		}
	}, [collapsedGroups]);

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
		if (pinnedWorkspaceIds.includes(group.id)) togglePinnedWorkspace(group.id);
		void (async () => {
			await workspacesStore.remove(group.id);
			await Promise.all([workspacesStore.load(), sessionsStore.refresh()]);
		})();
	}, [pinnedWorkspaceIds, t, togglePinnedWorkspace]);

	const recentVisibleSessions = useMemo(() => {
		if (recentExpanded || recentSessions.length <= 2) return recentSessions;
		const preview = recentSessions.slice(0, 2);
		const active = recentSessions.find((session) => session.id === state.currentSessionId);
		if (active && !preview.some((session) => session.id === active.id)) preview[1] = active;
		return preview;
	}, [recentExpanded, recentSessions, state.currentSessionId]);

	const renderSession = (session: SessionMeta) => (
		<SessionCard
			key={session.id}
			session={session}
			active={state.currentSessionId === session.id}
			opening={state.openingSessionId === session.id}
			pinned={pinnedSessionIds.has(session.id)}
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
			onTogglePin={() => togglePinned(session.id)}
			onDelete={() => handleDelete(session)}
			onExport={() => handleExport(session)}
			onExportShowcase={() => handleExportShowcase(session)}
		/>
	);

	const renderWorkspaceGroup = (group: WsGroup, isPinned = false, topSpacing = "mt-0.5") => {
		const isGroupCollapsed = collapsedGroups.has(group.id);
		const customIndex = customOrderDraft.indexOf(group.id);
		const pinnedIndex = pinnedWorkspaceIds.indexOf(group.id);
		const canMoveUp = isPinned ? pinnedIndex > 0 : customIndex > 0;
		const canMoveDown = isPinned
			? pinnedIndex >= 0 && pinnedIndex < pinnedWorkspaceIds.length - 1
			: customIndex >= 0 && customIndex < customOrderDraft.length - 1;
		const visibleCount = visibleSessionCounts[group.id] ?? 5;
		return (
			<div key={group.id} className={topSpacing}>
				<GroupHeader
					group={group}
					collapsed={isGroupCollapsed}
					isPinned={isPinned}
					onToggle={() => toggleGroup(group.id)}
					onEnterWorkspace={() => enterWorkspace(group)}
					onNewChat={() => newChatIn(group)}
					onTogglePin={() => togglePinnedWorkspace(group.id)}
					editing={editingWsId === group.id}
					editingName={editingWsName}
					onStartEdit={() => { setEditingWsId(group.id); setEditingWsName(group.name); }}
					onEditChange={setEditingWsName}
					onEditSave={() => saveWsName(group.id)}
					onEditCancel={() => setEditingWsId(null)}
					onDelete={() => handleDeleteWorkspace(group)}
					reorderMode={isCustomSorting && group.sortable}
					dragging={draggingWorkspaceId === group.id}
					canMoveUp={canMoveUp}
					canMoveDown={canMoveDown}
					onDragStart={() => setDraggingWorkspaceId(group.id)}
					onDragOver={() => isPinned
						? moveDraggedPinnedWorkspaceBefore(group.id)
						: moveDraggedWorkspaceBefore(group.id)}
					onDragEnd={() => setDraggingWorkspaceId(null)}
					onMoveUp={() => isPinned
						? movePinnedWorkspace(group.id, -1)
						: moveCustomWorkspace(group.id, customIndex - 1)}
					onMoveDown={() => isPinned
						? movePinnedWorkspace(group.id, 1)
						: moveCustomWorkspace(group.id, customIndex + 1)}
				/>
				<AnimatePresence initial={false}>
					{!isGroupCollapsed && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: "auto", opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={uiTransition}
							className="overflow-hidden"
						>
							{group.sessions.slice(0, visibleCount).map(renderSession)}
							{group.section === "projects" && group.sessions.length > visibleCount ? (
								<button
									type="button"
									className="pl-1.5 pr-3.5 py-1 text-left text-[12px] text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text)]"
									onClick={() => setVisibleSessionCounts((current) => ({
										...current,
										[group.id]: Math.min(group.sessions.length, visibleCount + 5),
									}))}
								>
									{t("sidebar.showMore")}
								</button>
							) : null}
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		);
	};

	const channelFilterControl = state.availableChannels.length > 1 ? (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<IconButton
					size="xs"
					className={state.channelFilter ? "text-[var(--inno-accent)]" : undefined}
					aria-label={t("sidebar.filterChannels")}
					title={t("sidebar.filterChannels")}
				>
					<Filter size={13} />
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="bottom" sideOffset={4} aria-label={t("sidebar.filterChannels")}>
				<DropdownMenuRadioGroup
					value={state.channelFilter ?? "all"}
					onValueChange={(value) => sessionsStore.setChannelFilter(value === "all" ? null : value as SessionChannel)}
				>
					<DropdownMenuOptionItem value="all" label={t("sidebar.all")} />
					{orderedChannels.map((channel) => (
						<DropdownMenuOptionItem key={channel} value={channel} label={channelLabel(channel, t)} />
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	) : null;

	const workspaceSortControl = isCustomSorting ? (
		<div className="flex shrink-0 items-center gap-0.5">
			<Button variant="ghost" size="xs" className="inno-sidebar-meta" onClick={cancelCustomSort}>
				{t("common.cancel")}
			</Button>
			<Button variant="primary" size="xs" className="inno-sidebar-meta" onClick={finishCustomSort}>
				{t("common.done")}
			</Button>
		</div>
	) : (
		<DropdownMenu open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
			<DropdownMenuTrigger asChild>
				<IconButton size="xs" aria-label={t("sidebar.sortWorkspaces")} title={t("sidebar.sortWorkspaces")}>
					<ArrowUpDown size={13} />
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="bottom" sideOffset={4} aria-label={t("sidebar.sortWorkspaces")} className="inno-workspace-sort-menu">
				<DropdownMenuRadioGroup
					value={workspaceSort}
					onValueChange={(value) => {
						if (value === "custom") beginCustomSort();
						else chooseWorkspaceSort(value as Exclude<WorkspaceSort, "custom">);
					}}
				>
					{([
						["recent", t("sidebar.sortRecent")],
						["oldest", t("sidebar.sortOldest")],
						["nameAsc", t("sidebar.sortNameAsc")],
						["nameDesc", t("sidebar.sortNameDesc")],
					] as const).map(([sort, label]) => (
						<DropdownMenuOptionItem key={sort} value={sort} label={label} className="inno-workspace-sort-option" />
					))}
					<DropdownMenuSeparator />
					<DropdownMenuOptionItem
						value="custom"
						label={t("sidebar.sortCustom")}
						className="inno-workspace-sort-option"
						disabled={workspaceFiltering}
						title={workspaceFiltering ? t("sidebar.sortCustomClearFilter") : undefined}
					/>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);

	const projectCreateControl = (
		<Popover
			open={projectCreateOpen}
			onOpenChange={(open) => {
				setProjectCreateOpen(open);
				if (open) setProjectCreateError("");
			}}
		>
			<PopoverTrigger asChild title={t("sidebar.newProject")}>
				<IconButton size="xs" aria-label={t("sidebar.newProject")} disabled={isCustomSorting}>
					<Plus size={13} />
				</IconButton>
			</PopoverTrigger>
			<PopoverContent align="end" side="bottom" sideOffset={4} className="inno-sidebar-project-create-popover">
				<form
					className="inno-workspace-create-form"
					onSubmit={(event) => {
						event.preventDefault();
						const name = projectName.trim();
						if (!name || projectCreating) return;
						setProjectCreating(true);
						setProjectCreateError("");
						void workspacesStore.create({ name, isTemp: false }).then(() => {
							setProjectName("");
							setProjectCreateOpen(false);
						}).catch((error: unknown) => {
							setProjectCreateError(error instanceof Error ? error.message : t("sidebar.createProjectFailed"));
						}).finally(() => setProjectCreating(false));
					}}
				>
					<div className="inno-workspace-menu-heading">{t("sidebar.newProject")}</div>
					<div className="inno-workspace-create-row">
						<Input
							size="sm"
							autoFocus
							value={projectName}
							placeholder={t("sidebar.newProjectPlaceholder")}
							aria-label={t("sidebar.newProjectPlaceholder")}
							className="inno-workspace-search-input"
							onChange={(event) => setProjectName(event.target.value)}
						/>
						<button
							type="submit"
							className="inno-workspace-create-submit"
							disabled={!projectName.trim() || projectCreating}
							aria-label={t("sidebar.newProject")}
						>
							{projectCreating ? <Spinner size={14} /> : <Check size={14} />}
						</button>
					</div>
					{projectCreateError ? <div className="inno-sidebar-project-create-error" role="alert">{projectCreateError}</div> : null}
					<button
						type="button"
						className="inno-workspace-menu-back"
						onClick={() => {
							setProjectCreateOpen(false);
							setProjectName("");
							setProjectCreateError("");
						}}
					>
						<span>{t("common.cancel")}</span>
					</button>
				</form>
			</PopoverContent>
		</Popover>
	);

	const projectGroups = groups.filter((group) => group.section === "projects");
	const compactNewChatSectionSpacing = isDesktopWindow;
	const projectSection = (
			<section aria-label={t("sidebar.projects")}>
			<div className="flex h-8 min-h-8 items-center justify-between pl-1.5 pr-3.5 text-sm font-medium text-[var(--inno-text-muted)]">
				<button
					type="button"
					className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-[var(--inno-text-muted)] transition-colors hover:text-[var(--inno-text)]"
					aria-expanded={!projectSectionCollapsed}
					onClick={() => setProjectSectionCollapsed((value) => !value)}
				>
					<span className="text-sm">{t("sidebar.projects")}</span>
					<motion.span
						className="inline-flex shrink-0"
						animate={{ rotate: projectSectionCollapsed ? -90 : 0 }}
						transition={uiTransition}
					>
						<ChevronDown size={14} aria-hidden="true" />
					</motion.span>
				</button>
				<div className="flex shrink-0 items-center gap-0.5">
					{projectCreateControl}
					{workspaceSortControl}
				</div>
			</div>
			<AnimatePresence initial={false}>
				{!projectSectionCollapsed ? (
					<motion.div
						key="project-groups"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={panelTransition}
						className="overflow-hidden"
					>
						<div className="mt-0.5 flex flex-col">
							{projectGroups.map((group) => renderWorkspaceGroup(group, false, "mt-0"))}
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</section>
	);

	/* The desktop window chrome owns both Electron toggle states; the browser
	   keeps its existing header control while the rail is expanded. */

	if (collapsed && !isDesktopWindow) {
		return (
			<aside id="session-sidebar" className="relative h-full w-0 overflow-visible" />
		);
	}

	/* ── Simple Mode sidebar (P7): minimal recent list + explicit mode switch ── */


	/* ── Expanded sidebar ── */

	const sidebarContent = (
		<>
			{/* Header */}
			<div className={`inno-sidebar-header px-3 pt-2.5 ${compactNewChatSectionSpacing ? "pb-1" : "pb-2.5"}`}>
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						{!isDesktopWindow ? (
							<div className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-text)] shadow-sm">
								IA
							</div>
						) : null}
						<div className="min-w-0">
							<h1 className="truncate text-base font-semibold tracking-tight text-[var(--inno-text)]">
								Inno Agent
							</h1>
						</div>
					</div>
					<div className="flex items-center gap-1">
						<IconButton
							size="xs"
							title={t("globalSearch.open")}
							aria-label={t("globalSearch.open")}
							onClick={onOpenSearch}
						>
							<Search size={14} />
						</IconButton>
						{channelFilterControl}
						<IconButton
							size="xs"
							title={t("common.refresh")}
							aria-label={t("common.refresh")}
							onClick={() => void sessionsStore.load()}
						>
							<RefreshCw size={14} />
						</IconButton>
						{!isDesktopWindow ? (
							<IconButton
								size="xs"
								title={t("sidebar.collapse")}
								aria-label={t("sidebar.collapse")}
								onClick={() => appStore.setSidebarCollapsed(true)}
							>
								<PanelLeftClose size={14} />
							</IconButton>
						) : null}
					</div>
				</div>
			</div>

			{/* New chat stays in the Chat panel; desktop destinations live in the icon rail. */}
			<nav className={`space-y-0.5 px-2 ${compactNewChatSectionSpacing ? "pt-1 pb-1" : "py-1.5"}`}>
				<NavItem
					icon={<SquarePen size={16} />}
					label={t("nav.newChat")}
					// New chat is an action, not a persistent destination. The chat
					// page remains the active destination for real sessions below.
					active={false}
					onClick={startNewChat}
				/>
				{!isDesktopWindow ? <>
					<div className="px-3.5 pb-1 pt-3 text-[11px] text-[var(--inno-text-subtle)]">{t("nav.workbench")}</div>
					<NavItem icon={<BookOpen size={16} />} label={t("nav.notebook")} active={page === "notebook"} onClick={() => navigateTo("notebook")} />
					<NavItem icon={<Puzzle size={16} />} label={t("nav.skills")} active={page === "skills"} onClick={() => navigateTo("skills")} />
					<NavItem icon={<UserRound size={16} />} label={t("nav.learner")} active={page === "learner"} onClick={() => navigateTo("learner")} />
					<NavItem icon={<CalendarClock size={16} />} label={t("nav.jobs")} active={page === "jobs"} onClick={() => navigateTo("jobs")} />
				</> : null}
			</nav>

			{/* Session list */}
			<div className="relative flex-1 min-h-0">
				{sessionListScrolled ? (
					<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-[var(--inno-border)]" />
				) : null}
				<div
					className="h-full overflow-y-auto pl-[5px] pr-1 pb-2 sidebar-scroll"
					onScroll={(event) => setSessionListScrolled(event.currentTarget.scrollTop > 0)}
				>
				{state.isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner size={16} className="text-[var(--inno-border-strong)]" />
					</div>
				) : allWorkspaceGroups.length === 0 && recentSessions.length === 0 ? (
					<>
						{projectSection}
						<div className="inno-sidebar-text px-2 py-8 text-center text-[var(--inno-text-subtle)]">
							{state.searchQuery || state.channelFilter ? t("sidebar.noMatch") : t("sidebar.noSessions")}
						</div>
					</>
				) : (
					<>
						{pinnedGroups.length > 0 ? (
							<section aria-label={t("sidebar.pinnedProjects")}>
								<div className="flex h-8 min-h-8 items-center justify-between pl-1.5 pr-3.5 text-sm font-medium text-[var(--inno-text-muted)]">
									<button
										type="button"
										className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-[var(--inno-text-muted)] transition-colors hover:text-[var(--inno-text)]"
										aria-expanded={!pinnedSectionCollapsed}
										onClick={() => setPinnedSectionCollapsed((value) => !value)}
									>
										<span className="text-sm">{t("sidebar.pinnedProjects")}</span>
										<motion.span
											className="inline-flex shrink-0"
											animate={{ rotate: pinnedSectionCollapsed ? -90 : 0 }}
											transition={uiTransition}
										>
											<ChevronDown size={14} aria-hidden="true" />
										</motion.span>
									</button>
								</div>
								<AnimatePresence initial={false}>
									{!pinnedSectionCollapsed ? (
										<motion.div
											key="pinned-groups"
											initial={{ height: 0, opacity: 0 }}
											animate={{ height: "auto", opacity: 1 }}
											exit={{ height: 0, opacity: 0 }}
											transition={panelTransition}
											className="overflow-hidden"
										>
											<div className="mt-0.5 flex flex-col">
												{pinnedGroups.map((group) => renderWorkspaceGroup(group, true, "mt-0"))}
											</div>
										</motion.div>
									) : null}
								</AnimatePresence>
							</section>
						) : null}
						{projectSection}
						{recentSessions.length > 0 ? (
							<section aria-label={t("sidebar.recent")}>
								<div className="flex h-8 min-h-8 items-center justify-between pl-1.5 pr-3.5 text-sm font-medium text-[var(--inno-text-muted)]">
									<button
										type="button"
										className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-[var(--inno-text-muted)] transition-colors hover:text-[var(--inno-text)]"
										aria-expanded={!recentSectionCollapsed}
										onClick={() => {
											setRecentSectionCollapsed((collapsed) => !collapsed);
											setRecentExpanded(false);
										}}
									>
										<span className="text-sm">{t("sidebar.recent")}</span>
										<motion.span
											className="inline-flex shrink-0"
											animate={{ rotate: recentSectionCollapsed ? -90 : 0 }}
											transition={uiTransition}
										>
											<ChevronDown size={14} aria-hidden="true" />
										</motion.span>
									</button>
								</div>
								<AnimatePresence initial={false}>
									{!recentSectionCollapsed ? (
										<motion.div
											key="recent-sessions"
											initial={{ height: 0, opacity: 0 }}
											animate={{ height: "auto", opacity: 1 }}
											exit={{ height: 0, opacity: 0 }}
											transition={panelTransition}
											className="overflow-hidden"
										>
											<div className="mt-0.5">{recentVisibleSessions.map(renderSession)}</div>
											{recentSessions.length > 2 ? (
												<button
													type="button"
													className="mb-1 pl-1.5 pr-3.5 py-1 text-left text-[12px] text-[var(--inno-text-subtle)] transition-colors hover:text-[var(--inno-text)]"
													onClick={() => setRecentExpanded((expanded) => !expanded)}
												>
													{t(recentExpanded ? "sidebar.showLess" : "sidebar.showMore")}
												</button>
											) : null}
										</motion.div>
									) : null}
								</AnimatePresence>
							</section>
						) : null}
						{groups.some((group) => group.section === "channels") ? (
							<section aria-label={t("sidebar.channels")}>
								<div className="flex h-8 min-h-8 items-center justify-between pl-1.5 pr-3.5 text-sm font-medium text-[var(--inno-text-muted)]">
									<span className="text-sm">{t("sidebar.channels")}</span>
								</div>
								<div className="mt-0.5">
									{groups.filter((group) => group.section === "channels").map((group) => renderWorkspaceGroup(group, false, "mt-0"))}
								</div>
							</section>
						) : null}
						{groups.filter((group) => group.section === "archived").map((group) => renderWorkspaceGroup(group, false, "mt-0"))}
					</>
				)}
				</div>
			</div>

			{/* Footer: user menu (theme / language / settings) */}
			{!isDesktopWindow ? (
				<div className="border-t border-[var(--inno-border)] p-2">
					<SidebarUserMenu />
				</div>
			) : null}
		</>
	);

	if (isDesktopWindow) {
		const desktopRail = (
			<div className="inno-desktop-sidebar-rail">
				<nav ref={desktopRailRef} className="inno-desktop-sidebar-rail-nav" aria-label={t("nav.primary")}>
					<div
						className="inno-desktop-sidebar-segment"
						onPointerEnter={preview.openPreview}
						onPointerLeave={schedulePreviewPointerClose}
						onFocusCapture={preview.openPreview}
						onBlurCapture={preview.scheduleClose}
					>
						<SegmentedControl<SidebarView>
							variant="rail"
							orientation="vertical"
							collapsed={!railExpanded}
							value={visibleSidebarView}
							ariaLabel={t("nav.sidebarViews")}
							onValueChange={selectSidebarView}
							onValuePreview={sidebarPreviewEnabled ? previewSidebarView : undefined}
							items={[
								{ value: "messages", label: <MessageSquare size={18} />, ariaLabel: t("nav.chat") },
								{ value: "files", label: <FolderClosed size={18} />, ariaLabel: t("nav.files") },
							]}
						/>
					</div>
					{([
						["notebook", t("nav.notebook"), <BookOpen size={17} />],
						["skills", t("nav.skills"), <Puzzle size={17} />],
						["learner", t("nav.learner"), <UserRound size={17} />],
						["jobs", t("nav.jobs"), <CalendarClock size={17} />],
					] as const).map(([destination, label, icon]) => (
						<Tooltip key={destination} label={label} side="right" sideOffset={8}>
							<button
								type="button"
								className="inno-desktop-sidebar-rail-button"
								aria-label={label}
								aria-current={page === destination ? "page" : undefined}
								onPointerEnter={schedulePreviewPointerClose}
								onFocus={preview.scheduleClose}
								onClick={() => navigateTo(destination)}
							>
								{icon}
							</button>
						</Tooltip>
					))}
				</nav>
				<div className="inno-desktop-sidebar-rail-account">
					<SidebarUserMenu compact />
				</div>
			</div>
		);
		const sidebarPreview = (
			<DesktopSidebarPreview
				panelRef={desktopPanelRef}
				label={t(visibleSidebarView === "files" ? "nav.files" : "nav.chat")}
				isPreview={desktopPanelPreview}
				isImmediateDismiss={isImmediateSidebarDismiss}
				isCollapsing={isCollapsing}
				isCollapseSettled={suppressSidebarFade && collapsed && page === "chat" && !isCollapsing && !preview.previewOpen}
				visible={desktopPanelVisible}
				onCollapseTransitionEnd={handleCollapseTransitionEnd}
				onPointerEnter={preview.cancelClose}
				onPointerLeave={schedulePreviewPointerClose}
				onFocusLeave={preview.scheduleClose}
				resizeHandle={desktopPanelVisible && !isCollapsing ? (
					<ResizeHandle
						value={layout.sidebarWidth}
						min={DESKTOP_SIDEBAR_MIN_WIDTH}
						max={maximumSidebarWidth}
						onValueChange={resizeSidebar}
						onResizeStart={startSidebarResize}
						onResizeEnd={finishSidebarResize}
						aria-label={t("sidebar.resize")}
						aria-controls="session-sidebar-panel"
					/>
				) : null}
			>
				<div className="inno-sidebar-view" hidden={visibleSidebarView !== "messages"}>
					{sidebarContent}
				</div>
				{hasOpenedFiles ? (
					<div className="inno-sidebar-view" hidden={visibleSidebarView !== "files"}>
						<Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner size={18} /></div>}>
							<SidebarWorkspaceBrowser variant="sidebar" dndManager={dndManager} onPreviewFile={openSidebarFile} />
						</Suspense>
					</div>
				) : null}
			</DesktopSidebarPreview>
		);

		return (
			<>
				<aside
					id="session-sidebar"
					className={`inno-desktop-sidebar${collapsed ? " is-collapsed" : " is-expanded"}`}
						onPointerLeave={schedulePreviewPointerClose}
					onKeyDown={(event) => preview.handleKeyDown(event.nativeEvent)}
				>
					{desktopRail}
					{sidebarPreview}
				</aside>
				{chatContent ? (
					<div
						className={`inno-desktop-chat-shell inno-desktop-panel-surface ${collapsed ? "is-collapsed" : "is-expanded"}`}
						onTransitionEnd={(event) => {
							if (event.target === event.currentTarget && event.propertyName === "grid-template-columns") {
								handleCollapseTransitionEnd("chatTrack");
							}
						}}
					>
						<section
							id="session-sidebar-history"
							className="inno-desktop-chat-history"
							aria-label={t("nav.chat")}
							aria-hidden="true"
							inert
						/>
						<div className="inno-desktop-workbench">
							<main className="inno-desktop-chat-content">{chatContent}</main>
							{workspaceContent}
						</div>
					</div>
				) : null}
			</>
		);
	}

	return (
		<aside id="session-sidebar" className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
			{sidebarContent}
		</aside>
	);
}
