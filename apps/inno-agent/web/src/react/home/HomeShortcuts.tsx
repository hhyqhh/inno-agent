import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Bell, Ellipsis, Folder, Plus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { WorkspaceMeta } from "../../api/workspaces.js";
import { homeShortcutsStore, type ShortcutCard, type ShortcutKey } from "../../stores/home-shortcuts-store.js";
import { jobsStore } from "../../stores/jobs-store.js";
import { appStore } from "../../stores/app-store.js";
import type { ScheduledJob } from "../../types/jobs.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Dialog, IconButton, Input, Popover, PopoverContent, PopoverTrigger, SegmentedControl, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
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

export function HomeShortcuts({ workspaces, selectedId, onSelect, onCreate, onEdit, disabled }: {
	workspaces: WorkspaceMeta[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onEdit: (workspace: WorkspaceMeta) => void;
	disabled?: boolean;
}) {
	const { t, i18n } = useTranslation();
	const reduceMotion = useReducedMotion();
	const cards = useStoreSnapshot(homeShortcutsStore, () => homeShortcutsStore.cards);
	const jobs = useStoreSnapshot(jobsStore, () => jobsStore.jobs);
	const [picker, setPicker] = useState(false);
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

	const findable = [
		{ key: "reminders" as const, label: t("home.upcoming") },
		...visibleWorkspaces.map((workspace) => ({ key: `workspace:${workspace.id}` as const, label: workspace.name })),
		...reminders.map((job) => ({ key: `reminder:${job.id}` as const, label: job.name })),
	].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

	return <section className="inno-home-shortcuts" aria-label={t("home.shortcuts")}>
		<header className="inno-home-shortcuts-header">
			<h2 className="text-sm font-medium text-[var(--inno-text-muted)]">{t("home.shortcuts")}</h2>
			<Button ref={addButton} variant="ghost" onClick={() => { setQuery(""); setPicker(true); }} disabled={disabled}><Plus size={15} />{t("home.addCard")}</Button>
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
				const back = moveShortcut(arranged, index, index - 1, columns);
				const forward = moveShortcut(arranged, index, index + 1, columns);
				return <motion.article key={card.key} layout={reduceMotion ? false : "position"} transition={{ duration: 0.16 }}
					className="inno-home-card" data-shortcut={card.key} data-size={card.size} data-dragging={drag === card.key || undefined}
					data-target={destination === card.key || undefined}
					aria-current={workspace?.id && workspace.id === selectedId ? true : undefined}
					onPointerDown={(event) => startHold(event, card.key)} onPointerMove={moveHold}
					onPointerUp={endHold} onPointerCancel={clearHold} onLostPointerCapture={clearHold} onPointerLeave={() => { if (!hold.current?.active) clearHold(); }}>
					<div className="inno-home-card-menu" data-card-control>
						<Popover>
							<PopoverTrigger asChild><IconButton aria-label={t("home.cardOptions", { name: title })} data-card-menu={card.key}><Ellipsis size={16} /></IconButton></PopoverTrigger>
							<PopoverContent align="end" side="bottom" sideOffset={4} className="inno-home-card-popover">
								{workspace || reminder ? <Button variant="ghost" onClick={() => workspace ? onEdit(workspace) : openJobs(reminder!.id)}>{t(workspace ? "home.editWorkspace" : "home.editReminder")}</Button> : null}
								<div className="inno-home-options-row"><span>{t("home.width")}</span>
									<SegmentedControl<ShortcutCard["size"]> value={card.size} ariaLabel={t("home.width")} items={[{ value: "standard", label: t("home.standard") }, { value: "wide", label: t("home.wide") }]}
										onValueChange={(size) => homeShortcutsStore.update(cards.map((item) => item.key === card.key ? { ...item, size } : item))} />
								</div>
								<div className="inno-home-options-row"><span>{t("home.order")}</span><div className="flex">
									<IconButton aria-label={t("home.moveBack")} disabled={!back} onClick={() => back && reorder(back, card.key)}><ArrowLeft size={14} /></IconButton>
									<IconButton aria-label={t("home.moveForward")} disabled={!forward} onClick={() => forward && reorder(forward, card.key)}><ArrowRight size={14} /></IconButton>
								</div></div>
								<Button variant="ghost" className="text-[var(--inno-danger)]" onClick={() => { homeShortcutsStore.update(cards.filter((item) => item.key !== card.key)); addButton.current?.focus(); }}><X size={14} />{t("home.remove")}</Button>
							</PopoverContent>
						</Popover>
					</div>
					{workspace || reminder ? <div className={workspace && card.size === "wide" && (linked.length || workspace.skillNames?.length) ? "inno-home-wide" : "inno-home-card-main"}>
						<Button variant="ghost" className="inno-home-card-hit" onClick={() => workspace ? onSelect(workspace.id) : openJobs(reminder!.id)} disabled={disabled && Boolean(workspace)}>
							<span className="inno-home-card-title">{workspace ? <Folder size={16} /> : <Bell size={16} />}<strong>{title}</strong></span>
							{workspace?.purpose ? <span className="inno-home-card-note">{workspace.purpose}</span> : null}
							<span className="inno-home-card-meta">{workspace ? [
								workspace.skillNames?.length ? t("home.skillCount", { count: workspace.skillNames.length }) : "",
								linked.length ? t("home.linkCount", { count: linked.length }) : "",
							].filter(Boolean).join(" · ") : reminder?.enabled ? clock(reminder.nextRunAt) ?? t("home.noReminders") : t("common.disabled")}</span>
						</Button>
						{workspace && card.size === "wide" && (linked.length || workspace.skillNames?.length) ? <div data-card-control className="inno-home-card-details">
							{workspace.skillNames?.slice(0, 2).map((name) => <Button key={name} variant="ghost" size="xs" onClick={() => onEdit(workspace)}>{name}</Button>)}
							{linked.slice(0, 2).map((item) => <Button key={item.id} variant="ghost" size="xs" disabled={disabled} onClick={() => onSelect(item.id)}>{item.name}</Button>)}
						</div> : null}
					</div> : <>
						<div className="inno-home-overview-header" data-card-control>
							<span className="inno-home-card-title"><Bell size={16} /><strong>{title}</strong></span>
							<Select value={range} onValueChange={setRange}>
								<SelectTrigger aria-label={t("home.reminderRange")} className="inno-home-range"><SelectValue /></SelectTrigger>
								<SelectContent><SelectOption value="today" label={t("home.today")} /><SelectOption value="week" label={t("home.nextWeek")} /></SelectContent>
							</Select>
						</div>
						<div className="inno-home-reminder-list">
							{upcoming.length ? upcoming.map((job) => <Button variant="ghost" key={job.id} className="inno-home-reminder-row" onClick={() => openJobs(job.id)}><span>{job.name}</span>{clock(job.nextRunAt)}</Button>) : <p className="text-xs text-[var(--inno-text-muted)] px-2 py-1">{t("home.noReminders")}</p>}
						</div>
						<footer className="inno-home-reminder-footer" data-card-control>
							<Button variant="ghost" size="xs" onClick={() => openJobs()}>{t("home.allReminders")}</Button>
							<Button variant="ghost" size="xs" onClick={() => openJobs(null)}><Plus size={14} />{t("home.newReminder")}</Button>
						</footer>
					</>}
				</motion.article>;
			})}
			{!arranged.length ? <p className="inno-home-empty text-xs text-[var(--inno-text-muted)]">{t("home.empty")}</p> : null}
		</div>
		{picker ? <Dialog label={t("home.addCard")} className="inno-confirm-dialog inno-home-dialog" onClose={() => setPicker(false)}>
			<header className="inno-home-dialog-header"><h2 className="text-lg font-semibold">{t("home.addCard")}</h2><IconButton aria-label={t("common.cancel")} onClick={() => setPicker(false)}><X size={16} /></IconButton></header>
			<div className="inno-home-dialog-body">
				<Button variant="ghost" onClick={() => { setPicker(false); onCreate(); }}><Folder size={15} />{t("workspace.newWorkspace")}</Button>
				<Input autoFocus value={query} aria-label={t("home.searchCards")} placeholder={t("home.searchCards")} onChange={(event) => setQuery(event.target.value)} />
				<div className="grid gap-1">{findable.map((item) => <Button key={item.key} variant="ghost" className="justify-start" disabled={cards.some((card) => card.key === item.key)}
					onClick={() => homeShortcutsStore.add(item.key)}>{item.key.startsWith(workspacePrefix) ? <Folder size={15} /> : <Bell size={15} />}{item.label}
					{cards.some((card) => card.key === item.key) ? <span className="ml-auto text-xs">{t("home.added")}</span> : null}</Button>)}</div>
			</div>
		</Dialog> : null}
	</section>;
}
