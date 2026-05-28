import { useCallback, useEffect, useState } from "react";
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
} from "lucide-react";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore, type DateGroup, type SessionGroup } from "../stores/sessions-store.js";
import type { SessionChannel, SessionMeta } from "../api/sessions.js";
import { useStoreSnapshot } from "./hooks.js";

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
		cli: "bg-blue-50 text-blue-600 ring-1 ring-blue-200/60",
		web: "bg-slate-100 text-slate-700 ring-1 ring-slate-200/80",
		feishu: "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/60",
		scheduler: "bg-amber-50 text-amber-600 ring-1 ring-amber-200/60",
		qq: "bg-cyan-50 text-cyan-600 ring-1 ring-cyan-200/60",
		wechat: "bg-lime-50 text-lime-600 ring-1 ring-lime-200/60",
		unknown: "bg-slate-50 text-slate-400 ring-1 ring-slate-200/60",
	};
	return classes[channel] ?? classes.unknown;
}

function channelFilterClass(channel: SessionChannel | null, active: boolean): string {
	if (!active) return "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-700 hover:ring-slate-300";
	if (!channel) return "bg-slate-800 text-white ring-1 ring-slate-800";
	const map: Record<string, string> = {
		cli: "bg-blue-600 text-white ring-1 ring-blue-600",
		web: "bg-slate-900 text-white ring-1 ring-slate-900",
		feishu: "bg-emerald-600 text-white ring-1 ring-emerald-600",
		scheduler: "bg-amber-600 text-white ring-1 ring-amber-600",
		qq: "bg-cyan-600 text-white ring-1 ring-cyan-600",
		wechat: "bg-lime-600 text-white ring-1 ring-lime-600",
	};
	return map[channel] ?? "bg-slate-700 text-white ring-1 ring-slate-700";
}

/* ── Group header component ── */

function GroupHeader({ group, collapsed, onToggle }: { group: SessionGroup; collapsed: boolean; onToggle: () => void }) {
	return (
		<button
			className="inno-sidebar-meta sticky top-0 z-10 flex w-full items-center gap-1.5 bg-[var(--inno-sidebar-bg)] px-2 py-1.5 font-semibold uppercase text-slate-400 transition-colors hover:text-slate-600"
			onClick={onToggle}
		>
			<ChevronRight
				size={12}
				className={`shrink-0 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
			/>
			<span>{group.label}</span>
			<span className="inno-sidebar-meta ml-auto rounded-full bg-slate-200 px-1.5 py-0 font-medium text-slate-500 tabular-nums">
				{group.sessions.length}
			</span>
		</button>
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
	return (
		<div
			className={`group/card relative mb-1 w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-all duration-150 ${
				active
					? "border-slate-200 bg-slate-100 shadow-sm"
					: "border-transparent hover:border-slate-200 hover:bg-white"
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
						className="inno-sidebar-title min-w-0 flex-1 rounded border border-blue-300 bg-white px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-200"
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
					<div className="inno-sidebar-title min-w-0 truncate font-medium text-slate-800 transition-colors group-hover/card:text-slate-950">
						{session.name}
					</div>
				)}
				<span className="inno-sidebar-meta shrink-0 pt-0.5 tabular-nums text-slate-400">{formatTime(session.updatedAt)}</span>
			</div>

			{/* Preview */}
			{session.preview && session.preview !== session.name ? (
				<div className="inno-sidebar-meta mt-0.5 truncate text-slate-400">{session.preview}</div>
			) : null}

			{/* Bottom row: channels + actions */}
			<div className="mt-1.5 flex items-center justify-between gap-1">
				<div className="flex flex-wrap items-center gap-1">
					{session.channels.map((ch) => (
						<span key={ch} className={`rounded px-1.5 py-px text-[9px] font-medium leading-none ${channelClass(ch)}`}>
							{channelLabel(ch)}
						</span>
					))}
				</div>
				<div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
					{opening ? (
						<span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
					) : null}
					<button
						className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
						title="AI generate topic"
						disabled={generatingId === session.id}
						onClick={(e) => { e.stopPropagation(); onGenerate(); }}
					>
						{generatingId === session.id ? (
							<span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
						) : (
							<Sparkles size={12} />
						)}
					</button>
					<button
						className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
						title="Rename"
						onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
					>
						<Pencil size={12} />
					</button>
					<button
						className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
						title={session.archived ? "Unarchive" : "Archive"}
						onClick={(e) => { e.stopPropagation(); onArchive(); }}
					>
						{session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
					</button>
					<button
						className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
						title="Delete"
						onClick={(e) => { e.stopPropagation(); onDelete(); }}
					>
						<Trash2 size={12} />
					</button>
					<span className="inno-sidebar-meta ml-0.5 tabular-nums text-slate-400">{session.messageCount}</span>
				</div>
			</div>
		</div>
	);
}

/* ── Main sidebar ── */

export function SessionSidebar({ collapsed }: SessionSidebarProps) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [generatingId, setGeneratingId] = useState<string | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<DateGroup>>(() => new Set(["archived"]));
	const [showSearch, setShowSearch] = useState(false);

	const state = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		groups: sessionsStore.groupedSessions,
		currentSessionId: sessionsStore.currentSessionId,
		isLoading: sessionsStore.isLoading,
		openingSessionId: sessionsStore.openingSessionId,
		channelFilter: sessionsStore.channelFilter,
		searchQuery: sessionsStore.searchQuery,
		availableChannels: sessionsStore.availableChannels,
		filteredSessions: sessionsStore.filteredSessions,
	}));
	const orderedChannels = CHANNEL_FILTER_ORDER.filter((ch) => state.availableChannels.includes(ch as SessionChannel));

	useEffect(() => {
		void sessionsStore.load();
	}, []);

	const newChat = useCallback(() => {
		void (async () => {
			await sessionsStore.clearSelection();
			chatStore.clear();
			appStore.setRightPanelTab("preview");
		})();
	}, []);

	const openSession = useCallback((session: SessionMeta) => {
		appStore.setRightPanelTab("preview");
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
		const confirmed = typeof window === "undefined" ? true : window.confirm(`删除会话「${session.name}」？此操作不可撤回。`);
		if (!confirmed) return;
		void sessionsStore.deleteSession(session.id);
	}, []);

	const toggleGroup = useCallback((key: DateGroup) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	/* ── Collapsed sidebar ── */

	if (collapsed) {
		return (
			<aside className="relative h-full w-0 overflow-visible">
				<button
					className="absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/90 hover:text-slate-700 hover:shadow-sm"
					title="Expand"
					onClick={() => appStore.setSidebarCollapsed(false)}
				>
					<PanelLeftOpen size={16} />
				</button>
			</aside>
		);
	}

	/* ── Expanded sidebar ── */

	return (
		<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-200/80 bg-[var(--inno-sidebar-bg)]">
			{/* Header */}
			<div className="border-b border-slate-200/70 px-3 py-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-[10px] font-semibold text-slate-800 shadow-sm">IA</div>
						<div className="min-w-0">
							<h1 className="inno-sidebar-title font-semibold tracking-tight text-slate-800">Inno Agent</h1>
						</div>
					</div>
					<div className="flex items-center gap-1">
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
							title="Refresh"
							onClick={() => void sessionsStore.load()}
						>
							<RefreshCw size={13} />
						</button>
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
							title="Collapse"
							onClick={() => appStore.setSidebarCollapsed(true)}
						>
							<PanelLeftClose size={14} />
						</button>
					</div>
				</div>
			</div>

			{/* Search + Filter bar */}
			<div className="space-y-1.5 border-b border-slate-200/60 px-2 py-1.5">
				{/* Search */}
				<div className="relative">
					{showSearch ? (
						<div className="flex items-center gap-1">
							<div className="relative flex-1">
								<Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									className="inno-sidebar-text w-full rounded-md border border-slate-200 bg-white py-1 pl-7 pr-7 outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-1 focus:ring-blue-200"
									placeholder="搜索对话..."
									value={state.searchQuery}
									autoFocus
									onChange={(e) => sessionsStore.setSearchQuery(e.target.value)}
								/>
								{state.searchQuery && (
									<button
										className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
										onClick={() => sessionsStore.setSearchQuery("")}
									>
										<X size={12} />
									</button>
								)}
							</div>
							<button
								className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600"
								onClick={() => { setShowSearch(false); sessionsStore.setSearchQuery(""); }}
							>
								<X size={13} />
							</button>
						</div>
					) : (
						<div className="relative">
							<Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
							<button
								className="inno-sidebar-text w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-3 text-left text-slate-400 transition-colors hover:border-slate-300 hover:bg-slate-50"
								onClick={() => setShowSearch(true)}
							>
								搜索对话...
							</button>
						</div>
					)}
				</div>

				{/* Channel filter chips */}
				{state.availableChannels.length > 1 && (
					<div className="flex flex-wrap items-center gap-1">
						{orderedChannels.map((ch) => (
							<button
								key={ch}
								className={`inno-sidebar-meta rounded-full px-1.5 py-px font-medium transition-colors ${channelFilterClass(ch, state.channelFilter === ch)}`}
								onClick={() => sessionsStore.setChannelFilter(state.channelFilter === ch ? null : ch)}
							>
								{channelLabel(ch)}
							</button>
						))}
						<button
							className={`inno-sidebar-meta rounded-full px-1.5 py-px font-medium transition-colors ${channelFilterClass(null, state.channelFilter === null)}`}
							onClick={() => sessionsStore.setChannelFilter(null)}
						>
							全部
						</button>
					</div>
				)}
			</div>

			{/* Session list */}
			<div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 sidebar-scroll">
				{state.isLoading ? (
					<div className="flex items-center justify-center py-8">
						<span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
					</div>
				) : state.groups.length === 0 ? (
					<div className="inno-sidebar-text px-2 py-8 text-center text-slate-400">
						{state.searchQuery || state.channelFilter ? "无匹配结果" : "暂无对话记录"}
					</div>
				) : (
					state.groups.map((group) => {
						const isGroupCollapsed = collapsedGroups.has(group.key);
						return (
							<div key={group.key} className="mt-0.5">
								<GroupHeader group={group} collapsed={isGroupCollapsed} onToggle={() => toggleGroup(group.key)} />
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

			{/* Footer */}
			<div className="border-t border-slate-200/70 p-2">
				<button
					className="inno-sidebar-text flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-3 py-1.5 font-medium text-white shadow-sm transition-colors hover:bg-slate-700"
					onClick={newChat}
				>
					<Plus size={14} /> 新建对话
				</button>
			</div>
		</aside>
	);
}
