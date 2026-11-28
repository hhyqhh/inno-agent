import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bell, Check, Ellipsis, Folder, FolderPlus, Link2, MessageSquare, Plus, Puzzle, Search, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { SessionMeta } from "../../api/sessions.js";
import type { WorkspaceMeta } from "../../api/workspaces.js";
import { homeShortcutsStore, type ShortcutCard, type ShortcutKey } from "../../stores/home-shortcuts-store.js";
import { jobsStore } from "../../stores/jobs-store.js";
import { appStore } from "../../stores/app-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import type { ScheduledJob } from "../../types/jobs.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Dialog, IconButton, Input, MenuOption, Popover, PopoverContent, PopoverTrigger, SegmentedControl, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Tooltip } from "../ui/index.js";
import { arrangeShortcuts, moveShortcut } from "./shortcut-layout.js";
import "./home.css";

const reminderPrefix = "reminder:";
const workspacePrefix = "workspace:";

interface Hold {
	key: ShortcutKey;
	pointer: number;
	node: HTMLElement;
	x: number;
	y: number;
	timer: number;
	active: boolean;
}

export function HomeShortcuts({ workspaces, selectedId, onSelect, onOpenSession, onCreate, onEdit, disabled }: {
	workspaces: WorkspaceMeta[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onOpenSession?: (sessionId: string) => void;
	onCreate: () => void;
	onEdit: (workspace: WorkspaceMeta) => void;
	disabled?: boolean;
}) {
	const { t, i18n } = useTranslation();
	const reduceMotion = useReducedMotion();
	const cards = useStoreSnapshot(homeShortcutsStore, () => homeShortcutsStore.cards);
	const jobs = useStoreSnapshot(jobsStore, () => jobsStore.jobs);
	const sessions = useStoreSnapshot(sessionsStore, () => sessionsStore.sessions);
	const [picker, setPicker] = useState(false);
	const [openMenu, setOpenMenu] = useState<ShortcutKey>();
	const [query, setQuery] = useState("");
	const [range, setRange] = useState("week");
	const [columns, setColumns] = useState(3);
	const [drag, setDrag] = useState<ShortcutKey>();
	const [destination, setDestination] = useState<ShortcutKey>();
	const board = useRef<HTMLDivElement>(null);
	const hold = useRef<Hold | undefined>(undefined);
	const suppressClick = useRef(false);
	const pendingFocus = useRef<ShortcutKey | undefined>(undefined);
	const addButton = useRef<HTMLButtonElement>(null);

	const visibleWorkspaces = workspaces.filter((item) => !item.isTemp && !item.id.startsWith("channel-"));
	const reminders = jobs.filter((job) => job.taskType === "push_reminder" || job.taskType === "check_in_reminder");
	const workspaceByKey = new Map<string, WorkspaceMeta>(visibleWorkspaces.map((item) => [workspacePrefix + item.id, item]));
	const reminderByKey = new Map<string, ScheduledJob>(reminders.map((item) => [reminderPrefix + item.id, item]));
	const sessionById = new Map<string, SessionMeta>(sessions.map((item) => [item.id, item]));
	const latestSessionByWorkspace = new Map<string, SessionMeta>();
	for (const ws of visibleWorkspaces) {
		let latest: SessionMeta | undefined;
		for (const sid of ws.sessionIds ?? []) {
			const session = sessionById.get(sid);
			if (!session || session.archived) continue;
			if (!latest || +new Date(session.updatedAt) > +new Date(latest.updatedAt)) latest = session;
		}
		if (latest) latestSessionByWorkspace.set(ws.id, latest);
	}
	const arranged = arrangeShortcuts(cards.filter((card) =>
		card.key === "reminders" || workspaceByKey.has(card.key) || reminderByKey.has(card.key)), columns);

	useEffect(() => {
		void jobsStore.load();
		const refresh = () => { if (!document.hidden) void jobsStore.load(); };
		const timer = window.setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
	}, []);

	useLayoutEffect(() => {
		const element = board.current;
		if (!element) return;
		function measure() {
			const width = element!.clientWidth;
			if (width) setColumns(width < 360 ? 1 : width < 550 ? 2 : 3);
		}
		measure();
		if (typeof ResizeObserver !== "function") {
			window.addEventListener("resize", measure);
			return () => window.removeEventListener("resize", measure);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => () => window.clearTimeout(hold.current?.timer), []);
	useLayoutEffect(() => {
		if (!pendingFocus.current) return;
		const key = pendingFocus.current;
		pendingFocus.current = undefined;
		Array.from(board.current?.querySelectorAll<HTMLElement>("[data-card-menu]") ?? [])
			.find((element) => element.dataset.cardMenu === key)?.focus();
	}, [cards]);

	function reorder(next: ShortcutCard[], focus?: ShortcutKey) {
		const shown = new Set(next.map((card) => card.key));
		let index = 0;
		pendingFocus.current = focus;
		homeShortcutsStore.update(cards.map((card) => shown.has(card.key) ? next[index++] : card));
	}

	function startHold(event: PointerEvent<HTMLElement>, key: ShortcutKey) {
		if (event.button !== 0 || !event.isPrimary || hold.current || (event.target as HTMLElement).closest("[data-card-control]")) return;
		const node = event.currentTarget;
		const snapshot: Hold = { key, node, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, timer: 0 };
		suppressClick.current = false;
		snapshot.timer = window.setTimeout(() => {
			snapshot.active = true;
			suppressClick.current = true;
			node.setPointerCapture(snapshot.pointer);
			setDrag(key);
		}, 500);
		hold.current = snapshot;
	}

	function clearHold() {
		const current = hold.current;
		if (!current) return;
		window.clearTimeout(current.timer);
		hold.current = undefined;
		if (current.node.hasPointerCapture(current.pointer)) current.node.releasePointerCapture(current.pointer);
		setDrag(undefined);
		setDestination(undefined);
	}

	function targetKey(event: PointerEvent<HTMLElement>) {
		return document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-shortcut]")?.dataset.shortcut as ShortcutKey | undefined;
	}

	function moveHold(event: PointerEvent<HTMLElement>) {
		const current = hold.current;
		if (!current || current.pointer !== event.pointerId) return;
		if (current.active) {
			const target = targetKey(event);
			setDestination(moveShortcut(arranged, arranged.findIndex((card) => card.key === current.key),
				arranged.findIndex((card) => card.key === target), columns) ? target : undefined);
		} else if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) clearHold();
	}

	function endHold(event: PointerEvent<HTMLElement>) {
		const current = hold.current;
		if (!current || current.pointer !== event.pointerId) return;
		const target = current.active ? targetKey(event) : undefined;
		clearHold();
		if (!target) return;
		const next = moveShortcut(arranged, arranged.findIndex((card) => card.key === current.key),
			arranged.findIndex((card) => card.key === target), columns);
		if (next) reorder(next);
	}

	function openJobs(id?: string | null) {
		jobsStore.requestReminderEditor(id);
		appStore.setPage("jobs");
	}

	const dateFormat = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" });
	const timeFormat = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	const today = new Date();
	const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (range === "today" ? 1 : 7));
	const upcoming = reminders.filter((job) => job.enabled && job.nextRunAt && +new Date(job.nextRunAt) < +end)
		.sort((a, b) => +new Date(a.nextRunAt!) - +new Date(b.nextRunAt!)).slice(0, 3);

	const clock = (value?: string) => {
		const date = value ? new Date(value) : undefined;
		return date && Number.isFinite(+date) ? <time dateTime={value} className="inno-home-time"><span>{dateFormat.format(date)}</span><span>{timeFormat.format(date)}</span></time> : null;
	};

	const shortTime = (value?: string) => {
		const date = value ? new Date(value) : undefined;
		if (!date || !Number.isFinite(+date)) return null;
		const sameDay = date.getFullYear() === today.getFullYear()
			&& date.getMonth() === today.getMonth()
			&& date.getDate() === today.getDate();
		return <time dateTime={value} className="inno-home-session-time">{sameDay ? timeFormat.format(date) : dateFormat.format(date)}</time>;
	};

	const normalizedQuery = query.trim().toLowerCase();
	const matchesQuery = (label: string) => !normalizedQuery || label.toLowerCase().includes(normalizedQuery);
	const pickerGroups = [
		{
			id: "overview",
			heading: t("home.groupOverview"),
			items: [{ key: "reminders" as const, label: t("home.upcoming"), kind: "reminder" as const }].filter((item) => matchesQuery(item.label)),
		},
		{
			id: "workspaces",
			heading: t("home.groupWorkspaces"),
			items: visibleWorkspaces
				.map((workspace) => ({ key: `workspace:${workspace.id}` as const, label: workspace.name, kind: "workspace" as const }))
				.filter((item) => matchesQuery(item.label)),
		},
		{
			id: "reminders",
			heading: t("home.groupReminders"),
			items: reminders
				.map((job) => ({ key: `reminder:${job.id}` as const, label: job.name, kind: "reminder" as const }))
				.filter((item) => matchesQuery(item.label)),
		},
	].filter((group) => group.items.length > 0);

	return <section className="inno-home-shortcuts" aria-label={t("home.shortcuts")}>
		<header className="inno-home-shortcuts-header">
			<div className="inno-home-shortcuts-title">
				<h2 className="text-xs font-medium tracking-wide text-[var(--inno-text-subtle)]">{t("home.shortcuts")}</h2>
				{arranged.length > 0 ? <span className="inno-home-shortcuts-count">{arranged.length}</span> : null}
			</div>
			<Button ref={addButton} variant="ghost" size="xs" onClick={() => { setQuery(""); setPicker(true); }} disabled={disabled}><Plus size={14} />{t("home.addCard")}</Button>
		</header>
		<div className="inno-home-board" data-columns={columns} ref={board}
			onKeyDown={(event) => { if (event.key === "Escape") clearHold(); }}
			onClickCapture={(event) => {
				if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
			}}>
			{arranged.map((card, index) => {
				const workspace = workspaceByKey.get(card.key);
				const reminder = reminderByKey.get(card.key);
				const title = workspace?.name ?? reminder?.name ?? t("home.upcoming");
				const linked = workspace?.linkedWorkspaceIds?.flatMap((id) => workspaceByKey.get(workspacePrefix + id) ?? []) ?? [];
				const workspaceSkills = workspace
					? [...new Set([...(workspace.skillNames ?? []), ...(workspace.privateSkillNames ?? [])])]
					: [];
				const latestSession = workspace ? latestSessionByWorkspace.get(workspace.id) : undefined;
				const metaParts = workspace ? [
					workspaceSkills.length ? t("home.skillCount", { count: workspaceSkills.length }) : "",
					linked.length ? t("home.linkCount", { count: linked.length }) : "",
				].filter(Boolean).join(" · ") : "";
				const back = moveShortcut(arranged, index, index - 1, columns);
				const forward = moveShortcut(arranged, index, index + 1, columns);
				const selected = Boolean(workspace?.id && workspace.id === selectedId);
				const workspacePurpose = workspace?.purpose?.trim() || "";
				const hasSessionAction = Boolean(workspace && latestSession);
				const cardHit = <Button variant="ghost" className={`inno-home-card-hit${hasSessionAction ? " has-session-action" : ""}`} onClick={() => workspace ? onSelect(workspace.id) : openJobs(reminder!.id)} disabled={disabled && Boolean(workspace)}>
					<span className="inno-home-card-title">
						<span className="inno-home-card-icon" data-kind={workspace ? "workspace" : "reminder"} aria-hidden="true">
							{workspace ? <Folder size={14} /> : <Bell size={14} />}
						</span>
						<strong className="inno-home-card-name">{title}</strong>
					</span>
					{workspace ? <>
						{workspacePurpose ? <span className="inno-home-card-note">{workspacePurpose}</span> : null}
						{metaParts ? <span className="inno-home-card-meta">{metaParts}</span>
							: !latestSession && !workspacePurpose ? <span className="inno-home-card-placeholder">{t("home.noSessions")}</span> : null}
					</> : <span className="inno-home-card-meta">{reminder?.enabled ? clock(reminder.nextRunAt) ?? t("home.noReminders") : t("common.disabled")}</span>}
				</Button>;
				return <motion.article key={card.key} layout={reduceMotion ? false : "position"} transition={{ duration: 0.16 }}
					className="inno-home-card" data-shortcut={card.key} data-size={card.size} data-kind={workspace ? "workspace" : "reminder"}
					data-dragging={drag === card.key || undefined}
					data-target={destination === card.key || undefined}
					aria-current={selected ? true : undefined}
					onPointerDown={(event) => startHold(event, card.key)} onPointerMove={moveHold}
					onPointerUp={endHold} onPointerCancel={clearHold} onLostPointerCapture={clearHold} onPointerLeave={() => { if (!hold.current?.active) clearHold(); }}>
					<div className="inno-home-card-menu" data-card-control>
						<Popover open={openMenu === card.key} onOpenChange={(open) => setOpenMenu(open ? card.key : undefined)}>
							<PopoverTrigger asChild><IconButton size="xs" aria-label={t("home.cardOptions", { name: title })} data-card-menu={card.key}><Ellipsis size={15} /></IconButton></PopoverTrigger>
							<PopoverContent align="end" side="bottom" sideOffset={4} className="inno-home-card-popover">
								{workspace || reminder ? <Button variant="ghost" size="xs" onClick={() => { setOpenMenu(undefined); workspace ? onEdit(workspace) : openJobs(reminder!.id); }}>{t(workspace ? "home.editWorkspace" : "home.editReminder")}</Button> : null}
								<div className="inno-home-options-row"><span>{t("home.width")}</span>
									<SegmentedControl<ShortcutCard["size"]> value={card.size} ariaLabel={t("home.width")} items={[{ value: "standard", label: t("home.standard") }, { value: "wide", label: t("home.wide") }]}
										onValueChange={(size) => { setOpenMenu(undefined); homeShortcutsStore.update(cards.map((item) => item.key === card.key ? { ...item, size } : item)); }} />
								</div>
								<div className="inno-home-options-row"><span>{t("home.order")}</span><div className="flex">
									<IconButton size="xs" aria-label={t("home.moveBack")} disabled={!back} onClick={() => { setOpenMenu(undefined); if (back) reorder(back, card.key); }}><ArrowLeft size={14} /></IconButton>
									<IconButton size="xs" aria-label={t("home.moveForward")} disabled={!forward} onClick={() => { setOpenMenu(undefined); if (forward) reorder(forward, card.key); }}><ArrowRight size={14} /></IconButton>
								</div></div>
								<Button variant="ghost" size="xs" className="text-[var(--inno-danger)]" onClick={() => { setOpenMenu(undefined); homeShortcutsStore.update(cards.filter((item) => item.key !== card.key)); addButton.current?.focus(); }}><X size={14} />{t("home.remove")}</Button>
							</PopoverContent>
						</Popover>
					</div>
					{workspace || reminder ? <div className={workspace && card.size === "wide" && (linked.length || workspaceSkills.length) ? "inno-home-wide" : "inno-home-card-main"}>
						<div className="inno-home-card-body">
							{workspace && workspacePurpose ? (
								<Tooltip
									label={workspace.name}
									description={workspacePurpose}
									side="top"
									sideOffset={8}
									open={drag === card.key || openMenu === card.key ? false : undefined}
								>
									{cardHit}
								</Tooltip>
							) : cardHit}
							{workspace && latestSession ? (
								<button
									type="button"
									data-card-control
									className="inno-home-card-session-btn"
									disabled={disabled}
									onClick={() => onOpenSession?.(latestSession.id)}
								>
									<MessageSquare size={12} aria-hidden="true" />
									<span className="inno-home-card-session-title">{latestSession.name || latestSession.preview}</span>
									{shortTime(latestSession.updatedAt)}
									<ArrowUpRight size={12} className="inno-home-session-arrow" aria-hidden="true" />
								</button>
							) : null}
						</div>
						{workspace && card.size === "wide" && (linked.length || workspaceSkills.length) ? <div data-card-control className="inno-home-card-details">
							{workspaceSkills.slice(0, 2).map((name) => (
								<Button key={name} variant="ghost" size="xs" className="inno-home-detail-chip" onClick={() => onEdit(workspace)}>
									<Puzzle size={12} className="inno-home-detail-icon" aria-hidden="true" />
									<span>{name}</span>
								</Button>
							))}
							{linked.slice(0, 2).map((item) => (
								<Button key={item.id} variant="ghost" size="xs" className="inno-home-detail-chip" disabled={disabled} onClick={() => onSelect(item.id)}>
									<Link2 size={12} className="inno-home-detail-icon" aria-hidden="true" />
									<span>{item.name}</span>
								</Button>
							))}
						</div> : null}
					</div> : <>
						<div className="inno-home-overview-header" data-card-control>
							<span className="inno-home-card-title">
								<span className="inno-home-card-icon" data-kind="reminder" aria-hidden="true"><Bell size={14} /></span>
								<strong className="inno-home-card-name">{title}</strong>
							</span>
							<Select value={range} onValueChange={setRange}>
								<SelectTrigger aria-label={t("home.reminderRange")} className="inno-home-range"><SelectValue /></SelectTrigger>
								<SelectContent><SelectOption value="today" label={t("home.today")} /><SelectOption value="week" label={t("home.nextWeek")} /></SelectContent>
							</Select>
						</div>
						<div className="inno-home-reminder-list">
							{upcoming.length ? upcoming.map((job) => <Button variant="ghost" size="xs" key={job.id} className="inno-home-reminder-row" onClick={() => openJobs(job.id)}><span>{job.name}</span>{clock(job.nextRunAt)}</Button>) : <p className="text-xs text-[var(--inno-text-muted)] px-2 py-1">{t("home.noReminders")}</p>}
						</div>
						<footer className="inno-home-reminder-footer" data-card-control>
							<Button variant="ghost" size="xs" onClick={() => openJobs()}>{t("home.allReminders")}</Button>
							<Button variant="ghost" size="xs" onClick={() => openJobs(null)}><Plus size={14} />{t("home.newReminder")}</Button>
						</footer>
					</>}
				</motion.article>;
			})}
			{!arranged.length ? <button type="button" className="inno-home-empty" disabled={disabled} onClick={() => { setQuery(""); setPicker(true); }}>
				<span className="inno-home-empty-icon" aria-hidden="true"><Plus size={15} /></span>
				<span className="inno-home-empty-text">{t("home.empty")}</span>
				<span className="inno-home-empty-action">{t("home.emptyAction")}</span>
			</button> : null}
		</div>
		{picker ? <Dialog label={t("home.addCard")} className="inno-confirm-dialog inno-home-dialog inno-home-picker-dialog" onClose={() => setPicker(false)}>
			<header className="inno-home-dialog-header">
				<h2 className="text-base font-semibold">{t("home.addCard")}</h2>
				<IconButton size="xs" aria-label={t("common.cancel")} onClick={() => setPicker(false)}><X size={16} /></IconButton>
			</header>
			<div className="inno-home-picker-search">
				<div className="relative">
					<Search size={15} className="inno-ui-input-leading-adornment" aria-hidden="true" />
					<Input hasLeadingAdornment autoFocus value={query} aria-label={t("home.searchCards")} placeholder={t("home.searchCards")} onChange={(event) => setQuery(event.target.value)} />
				</div>
			</div>
			<div className="inno-home-picker-list">
				{pickerGroups.length ? pickerGroups.map((group) => (
					<div key={group.id} className="inno-home-picker-group">
						<div className="inno-home-picker-group-label">{group.heading}</div>
						<div className="inno-home-picker-items">
							{group.items.map((item) => {
								const added = cards.some((card) => card.key === item.key);
								return <MenuOption key={item.key} className="inno-home-picker-item" disabled={added}
									onClick={() => homeShortcutsStore.add(item.key)}>
									<span className="inno-home-picker-icon" data-kind={item.kind} aria-hidden="true">
										{item.kind === "workspace" ? <Folder size={14} /> : <Bell size={14} />}
									</span>
									<span className="inno-home-picker-label">{item.label}</span>
									{added ? <span className="inno-home-picker-badge"><Check size={12} aria-hidden="true" />{t("home.added")}</span>
										: <span className="inno-home-picker-add" aria-hidden="true"><Plus size={14} />{t("common.add")}</span>}
								</MenuOption>;
							})}
						</div>
					</div>
				)) : <p className="inno-home-picker-empty text-sm text-[var(--inno-text-muted)]">{t("home.noMatches")}</p>}
			</div>
			<footer className="inno-home-dialog-footer inno-home-picker-footer">
				<Button variant="secondary" size="sm" onClick={() => { setPicker(false); onCreate(); }}><FolderPlus size={15} />{t("workspace.newWorkspace")}</Button>
				<Button variant="ghost" size="sm" onClick={() => setPicker(false)}>{t("common.done")}</Button>
			</footer>
		</Dialog> : null}
	</section>;
}
