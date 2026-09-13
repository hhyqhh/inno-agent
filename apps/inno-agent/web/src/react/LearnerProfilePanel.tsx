import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { Spinner } from "./ui/Spinner.js";
import { learnerStore } from "../stores/learner-store.js";
import type {
	GoalStatus,
	GoalType,
	KnowledgeState,
	LearningGoal,
	Misconception,
	MisconceptionStatus,
} from "../types/learner.js";
import { useStoreSnapshot } from "./hooks.js";

const GOAL_TYPES: GoalType[] = ["skill", "concept", "project", "exam", "habit"];
const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "completed", "archived"];
const MISC_STATUSES: MisconceptionStatus[] = ["active", "repairing", "resolved", "stale"];

function formatDate(iso?: string): string {
	if (!iso) return "-";
	try {
		return new Date(iso).toLocaleString("zh-CN", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

function Section({
	title,
	children,
	action,
	count,
	defaultCollapsed = false,
}: {
	title: string;
	children: React.ReactNode;
	action?: React.ReactNode;
	count?: number;
	defaultCollapsed?: boolean;
}) {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	return (
		<section className="overflow-hidden rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)]">
			<div className="flex items-center gap-2 px-[18px] py-[15px]">
				<button
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={() => setCollapsed(!collapsed)}
					aria-expanded={!collapsed}
				>
					<ChevronDown
						size={16}
						className={`shrink-0 text-[var(--inno-text-muted)] transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
					/>
					<h4 className="truncate text-[14.5px] font-semibold text-[var(--inno-text)]">{title}</h4>
					{typeof count === "number" ? (
						<span className="rounded-[10px] bg-[var(--inno-accent-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--inno-accent)]">
							{count}
						</span>
					) : null}
				</button>
				{!collapsed && action ? <div className="shrink-0">{action}</div> : null}
			</div>
			<AnimatePresence initial={false}>
				{!collapsed ? (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
						style={{ overflow: "hidden" }}
					>
						<div className="px-[18px] pb-[18px] pt-1">{children}</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</section>
	);
}

function SummarySection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isSaving: learnerStore.isSaving,
	}));
	const [buffer, setBuffer] = useState("");
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setBuffer(state.profile?.profile_summary ?? "");
	}, [state.profile?.profile_summary, dirty]);

	const profile = state.profile;
	const activeGoals = profile?.goals.filter((g) => g.status === "active").length ?? 0;
	const concepts = profile?.knowledge_states.length ?? 0;
	const due = profile?.knowledge_states.filter((k) => k.review_due_at && new Date(k.review_due_at).getTime() <= Date.now()).length ?? 0;
	const openMisc = profile?.misconceptions.filter((m) => m.status === "active" || m.status === "repairing").length ?? 0;

	return (
		<Section title={t("profile.sections.summary")}>
			<div className="mb-3.5 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label={t("profile.summary.activeGoals")} value={activeGoals} />
				<Stat label={t("profile.summary.concepts")} value={concepts} />
				<Stat label={t("profile.summary.dueReviews")} value={due} />
				<Stat label={t("profile.summary.openMisconceptions")} value={openMisc} />
			</div>
			<textarea
				className="min-h-[110px] w-full resize-y rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--inno-text-muted)] focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
				placeholder={t("profile.summary.placeholder") ?? ""}
				value={buffer}
				onChange={(e) => {
					setBuffer(e.target.value);
					setDirty(true);
				}}
			/>
			{dirty ? (
				<div className="mt-2 flex justify-end gap-2">
					<button
						className="rounded-lg bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
						onClick={() => {
							setBuffer(profile?.profile_summary ?? "");
							setDirty(false);
						}}
					>
						{t("common.cancel")}
					</button>
					<button
						className="rounded-lg inno-primary-button px-3 py-1.5 text-sm text-white disabled:opacity-50"
						disabled={state.isSaving}
						onClick={async () => {
							await learnerStore.patchSummary(buffer);
							setDirty(false);
						}}
					>
						{state.isSaving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			) : null}
		</Section>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-xl bg-[var(--inno-accent-soft)] px-4 py-3.5">
			<div className="mb-1.5 text-xs text-[var(--inno-text-muted)]">{label}</div>
			<div className="text-2xl font-semibold text-[var(--inno-text)]">{value}</div>
		</div>
	);
}

interface GoalDraft {
	title: string;
	type: GoalType;
	status: GoalStatus;
	priority: number;
	success_criteria: string[];
}

const emptyGoalDraft: GoalDraft = {
	title: "",
	type: "skill",
	status: "active",
	priority: 0.5,
	success_criteria: [],
};

function GoalsSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const goals = state.profile?.goals ?? [];
	const [showForm, setShowForm] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function openForm() {
		setError(null);
		setShowForm(true);
	}

	async function submit(draft: GoalDraft) {
		setError(null);
		try {
			await learnerStore.addGoal({
				title: draft.title.trim() || t("profile.goals.newGoalDefault"),
				type: draft.type,
				status: draft.status,
				priority: draft.priority,
				success_criteria: draft.success_criteria,
			});
			setShowForm(false);
		} catch (err) {
			setError(t("profile.goals.addFailed", { message: err instanceof Error ? err.message : String(err) }));
		}
	}

	return (
		<>
			<Section
				title={t("profile.sections.goals")}
				count={goals.length}
				action={
					<button
						className="inline-flex items-center gap-1.5 rounded-[9px] inno-primary-button px-3 py-1.5 text-xs text-white"
						onClick={openForm}
					>
						<Plus size={12} strokeWidth={2.2} />
						{t("profile.goals.addNew")}
					</button>
				}
			>
				{error ? <div className="mb-2 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
				{goals.length === 0 ? (
					<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">{t("profile.goals.empty")}</p>
				) : (
					<div className="flex flex-col gap-2.5">
						{goals.map((g) => (
							<GoalCard key={g.goal_id} goal={g} />
						))}
					</div>
				)}
			</Section>
			{showForm ? (
				<GoalFormDialog
					onClose={() => setShowForm(false)}
					onSubmit={submit}
				/>
			) : null}
		</>
	);
}

function GoalFormDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (draft: GoalDraft) => Promise<void> }) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<GoalDraft>(emptyGoalDraft);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await onSubmit(draft);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<motion.div
			className="fixed inset-0 z-50 flex items-center justify-center px-4"
			initial={{ backgroundColor: "rgba(0,0,0,0)" }}
			animate={{ backgroundColor: "rgba(0,0,0,0.45)" }}
			transition={{ duration: 0.2 }}
			onClick={onClose}
		>
			<motion.div
				className="max-h-[85vh] w-full max-w-[460px] overflow-y-auto rounded-2xl bg-[var(--inno-surface)] p-5 shadow-xl"
				initial={{ opacity: 0, scale: 0.95 }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="mb-4 text-base font-medium text-[var(--inno-text)]">{t("profile.goals.newTitle")}</h3>
				<div className="flex flex-col gap-3">
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.title")}</span>
						<input
							className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
							placeholder={t("profile.goals.namePlaceholder") ?? ""}
							value={draft.title}
							autoFocus
							onChange={(e) => setDraft({ ...draft, title: e.target.value })}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="block text-sm">
							<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.type")}</span>
							<select
								className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm"
								value={draft.type}
								onChange={(e) => setDraft({ ...draft, type: e.target.value as GoalType })}
							>
								{GOAL_TYPES.map((tp) => (
									<option key={tp} value={tp}>{t(`profile.goals.typeOptions.${tp}`)}</option>
								))}
							</select>
						</label>
						<label className="block text-sm">
							<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.status")}</span>
							<select
								className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm"
								value={draft.status}
								onChange={(e) => setDraft({ ...draft, status: e.target.value as GoalStatus })}
							>
								{GOAL_STATUSES.map((st) => (
									<option key={st} value={st}>{t(`profile.goals.statusOptions.${st}`)}</option>
								))}
							</select>
						</label>
					</div>
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">
							{t("profile.goals.priority")}: {Math.round(draft.priority * 100)}%
						</span>
						<input
							type="range"
							min={0}
							max={100}
							value={Math.round(draft.priority * 100)}
							onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) / 100 })}
							className="w-full"
						/>
					</label>
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.successCriteria")}</span>
						<textarea
							className="h-20 w-full resize-none rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
							placeholder={t("profile.goals.successCriteriaPlaceholder") ?? ""}
							value={draft.success_criteria.join("\n")}
							onChange={(e) =>
								setDraft({
									...draft,
									success_criteria: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
								})
							}
						/>
					</label>
				</div>
				<div className="mt-4 flex justify-end gap-2">
					{error ? <div className="mr-auto text-xs text-[var(--inno-danger)]">{error}</div> : null}
					<button
						className="rounded-lg bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={saving}
						onClick={onClose}
					>
						{t("common.cancel")}
					</button>
					<button
						className="rounded-lg inno-primary-button px-3 py-1.5 text-sm text-white disabled:opacity-50"
						disabled={saving}
						onClick={() => void save()}
					>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			</motion.div>
		</motion.div>
	);
}

function goalDotColor(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "var(--inno-accent)";
		case "completed":
			return "var(--inno-success)";
		case "paused":
			return "var(--inno-warning)";
		default:
			return "var(--inno-text-subtle)";
	}
}

function GoalCard({ goal }: { goal: LearningGoal }) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<LearningGoal>(goal);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!editing) setDraft(goal);
	}, [goal, editing]);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await learnerStore.patchGoal(goal.goal_id, {
				title: draft.title,
				type: draft.type,
				priority: draft.priority,
				status: draft.status,
				success_criteria: draft.success_criteria,
			});
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	async function doDelete() {
		setError(null);
		try {
			await learnerStore.deleteGoal(goal.goal_id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	if (!editing) {
		return (
			<div className="flex items-start gap-3 rounded-xl border border-[var(--inno-border)] px-[15px] py-[13px]">
				<span
					className="mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full"
					style={{ background: goalDotColor(goal.status) }}
				/>
				<div className="min-w-0 flex-1">
					<div className="mb-0.5 text-[13.5px] font-medium text-[var(--inno-text)]">{goal.title}</div>
					<div className="flex flex-wrap items-center gap-2 text-xs text-[var(--inno-text-subtle)]">
						<span className="rounded-md bg-[var(--inno-chip-bg)] px-1.5 py-0.5">{t(`profile.goals.typeOptions.${goal.type}`)}</span>
						<span>· {t("profile.goals.priority")} {(goal.priority * 100).toFixed(0)}%</span>
					</div>
					{goal.success_criteria.length > 0 ? (
						<ul className="mt-2 list-disc pl-5 text-xs text-[var(--inno-text-muted)]">
							{goal.success_criteria.map((s) => (
								<li key={s}>{s}</li>
							))}
						</ul>
					) : null}
					{error ? <div className="mt-2 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<span className={`rounded-[9px] px-2.5 py-0.5 text-[11px] ${statusToneFor(goal.status)}`}>
						{t(`profile.goals.statusOptions.${goal.status}`)}
					</span>
					<button
						className="rounded-md px-2 py-1 text-xs text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						onClick={() => setEditing(true)}
					>
						{t("common.edit")}
					</button>
					<button
						className="rounded-md px-2 py-1 text-xs text-[var(--inno-danger)] hover:bg-[var(--inno-danger-bg)]"
						onClick={() => void doDelete()}
					>
						{t("common.delete")}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="rounded-xl border border-[var(--inno-border)] px-[15px] py-[13px]">
			<div className="grid gap-2">
				<input
					className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm"
					value={draft.title}
					onChange={(e) => setDraft({ ...draft, title: e.target.value })}
				/>
				<div className="grid grid-cols-2 gap-2">
					<label className="block text-xs">
						<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.type")}</span>
						<select
							className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
							value={draft.type}
							onChange={(e) => setDraft({ ...draft, type: e.target.value as GoalType })}
						>
							{GOAL_TYPES.map((tp) => (
								<option key={tp} value={tp}>
									{t(`profile.goals.typeOptions.${tp}`)}
								</option>
							))}
						</select>
					</label>
					<label className="block text-xs">
						<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.status")}</span>
						<select
							className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
							value={draft.status}
							onChange={(e) => setDraft({ ...draft, status: e.target.value as GoalStatus })}
						>
							{GOAL_STATUSES.map((st) => (
								<option key={st} value={st}>
									{t(`profile.goals.statusOptions.${st}`)}
								</option>
							))}
						</select>
					</label>
				</div>
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.priority")}: {(draft.priority * 100).toFixed(0)}%</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(draft.priority * 100)}
						onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) / 100 })}
						className="w-full"
					/>
				</label>
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.successCriteria")}</span>
					<textarea
						className="h-20 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
						placeholder={t("profile.goals.successCriteriaPlaceholder") ?? ""}
						value={draft.success_criteria.join("\n")}
						onChange={(e) => setDraft({ ...draft, success_criteria: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
					/>
				</label>
				<div className="flex justify-end gap-2 pt-1">
					<button className="rounded-lg bg-[var(--inno-surface-muted)] px-3 py-1 text-xs text-[var(--inno-text-muted)]" onClick={() => setEditing(false)}>
						{t("common.cancel")}
					</button>
					<button className="rounded-lg inno-primary-button px-3 py-1 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
				{error ? <div className="mt-1 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			</div>
		</div>
	);
}

function statusToneFor(status: string): string {
	switch (status) {
		case "active":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		case "paused":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "completed":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "archived":
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
		case "repairing":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "resolved":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "stale":
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

type MasteryState = "mastered" | "consolidating" | "needsReview";

function masteryStateFor(mastery: number): MasteryState {
	if (mastery >= 0.8) return "mastered";
	if (mastery >= 0.4) return "consolidating";
	return "needsReview";
}

const MASTERY_STATE_TONE: Record<MasteryState, string> = {
	mastered: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
	consolidating: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
	needsReview: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
};

const MASTERY_BAR_COLOR: Record<MasteryState, string> = {
	mastered: "var(--inno-success)",
	consolidating: "var(--inno-warning)",
	needsReview: "var(--inno-danger)",
};

function KnowledgeSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const knowledge = state.profile?.knowledge_states ?? [];

	if (knowledge.length === 0) {
		return (
			<Section title={t("profile.sections.knowledge")} count={0}>
				<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">{t("profile.knowledge.empty")}</p>
			</Section>
		);
	}
	return (
		<Section
			title={t("profile.sections.knowledge")}
			count={knowledge.length}
			defaultCollapsed={knowledge.length > 5}
		>
			<div className="flex flex-col">
				{knowledge.map((k) => (
					<KnowledgeRow key={k.concept_id} state={k} />
				))}
			</div>
		</Section>
	);
}

function KnowledgeRow({ state }: { state: KnowledgeState }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [draft, setDraft] = useState<{ diagnosis: string; nextActions: string[]; mastery: number }>({
		diagnosis: state.diagnosis,
		nextActions: state.next_actions,
		mastery: state.mastery,
	});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!expanded) setDraft({ diagnosis: state.diagnosis, nextActions: state.next_actions, mastery: state.mastery });
	}, [state, expanded]);

	const pct = Math.round(state.mastery * 100);
	const masteryState = masteryStateFor(state.mastery);

	async function save() {
		setSaving(true);
		try {
			await learnerStore.patchKnowledge(state.concept_id, {
				diagnosis: draft.diagnosis,
				next_actions: draft.nextActions,
				mastery: draft.mastery,
			});
			setExpanded(false);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="border-b border-[var(--inno-border)] last:border-b-0">
			<button
				className="flex w-full items-center gap-3 px-1 py-[11px] text-left"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
			>
				<div className="w-[170px] min-w-0 shrink-0">
					<div className="truncate text-[13.5px] font-medium text-[var(--inno-text)]">{state.concept_name}</div>
					<div className="truncate text-xs text-[var(--inno-text-subtle)]">{state.domain || state.concept_id}</div>
				</div>
				<div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-[var(--inno-chip-bg)]">
					<div
						className="h-full rounded"
						style={{ width: `${pct}%`, background: MASTERY_BAR_COLOR[masteryState] }}
					/>
				</div>
				<span className="w-[42px] shrink-0 text-right text-xs text-[var(--inno-text-subtle)]">{pct}%</span>
				<span className={`w-[74px] shrink-0 rounded-[9px] px-1 py-0.5 text-center text-[11px] ${MASTERY_STATE_TONE[masteryState]}`}>
					{t(`profile.knowledge.masteryState.${masteryState}`)}
				</span>
				<span className="hidden w-[110px] shrink-0 text-right text-xs text-[var(--inno-text-subtle)] sm:block">
					{state.review_due_at ? formatDate(state.review_due_at) : "-"}
				</span>
			</button>
			{expanded ? (
				<div className="pb-3 pl-1 pr-1">
					<div className="grid gap-2 rounded-xl bg-[var(--inno-surface-muted)] p-3">
						<label className="block text-xs">
							<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.knowledge.mastery")}: {Math.round(draft.mastery * 100)}%</span>
							<input
								type="range"
								min={0}
								max={100}
								value={Math.round(draft.mastery * 100)}
								onChange={(e) => setDraft({ ...draft, mastery: Number(e.target.value) / 100 })}
								className="w-full"
							/>
						</label>
						<label className="block text-xs">
							<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.knowledge.diagnosis")}</span>
							<textarea
								className="h-20 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
								placeholder={t("profile.knowledge.diagnosisPlaceholder") ?? ""}
								value={draft.diagnosis}
								onChange={(e) => setDraft({ ...draft, diagnosis: e.target.value })}
							/>
						</label>
						<label className="block text-xs">
							<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.knowledge.nextActions")}</span>
							<textarea
								className="h-20 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
								placeholder={t("profile.knowledge.nextActionsPlaceholder") ?? ""}
								value={draft.nextActions.join("\n")}
								onChange={(e) => setDraft({ ...draft, nextActions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
							/>
						</label>
						<div className="flex justify-end gap-2 pt-1">
							<button className="rounded-lg bg-[var(--inno-surface)] px-3 py-1 text-xs text-[var(--inno-text-muted)]" onClick={() => setExpanded(false)}>
								{t("common.cancel")}
							</button>
							<button className="rounded-lg inno-primary-button px-3 py-1 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>
								{saving ? t("common.saving") : t("common.save")}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function MisconceptionsSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const items = state.profile?.misconceptions ?? [];

	if (items.length === 0) {
		return (
			<Section title={t("profile.sections.misconceptions")} count={0}>
				<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">{t("profile.misconceptions.empty")}</p>
			</Section>
		);
	}
	return (
		<Section
			title={t("profile.sections.misconceptions")}
			count={items.length}
			defaultCollapsed={items.length > 5}
		>
			<div className="flex flex-col gap-2.5">
				{items.map((m) => (
					<MisconceptionRow key={m.misconception_id} item={m} />
				))}
			</div>
		</Section>
	);
}

function MisconceptionRow({ item }: { item: Misconception }) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState({ status: item.status, severity: item.severity, repair: item.repair_strategy });
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setDraft({ status: item.status, severity: item.severity, repair: item.repair_strategy });
	}, [item, dirty]);

	async function save() {
		setSaving(true);
		try {
			await learnerStore.patchMisconception(item.misconception_id, {
				status: draft.status,
				severity: draft.severity,
				repair_strategy: draft.repair,
			});
			setDirty(false);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-xl border border-[color-mix(in_srgb,var(--inno-danger)_28%,transparent)] bg-[var(--inno-danger-bg)] px-[15px] py-[13px]">
			<div className="mb-1 flex items-center gap-2 text-[13.5px] font-medium text-[var(--inno-danger)]">
				<TriangleAlert size={14} className="shrink-0" />
				<span className="min-w-0">{item.description}</span>
				<span className={`ml-auto shrink-0 rounded-[9px] px-2.5 py-0.5 text-[11px] ${statusToneFor(item.status)}`}>
					{t(`profile.misconceptions.statusOptions.${item.status}`)}
				</span>
			</div>
			<div className="mb-2 text-xs text-[var(--inno-text-subtle)]">{item.concept_id} · {formatDate(item.last_seen_at)}</div>
			<div className="grid grid-cols-2 gap-2">
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.status")}</span>
					<select
						className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
						value={draft.status}
						onChange={(e) => {
							setDraft({ ...draft, status: e.target.value as MisconceptionStatus });
							setDirty(true);
						}}
					>
						{MISC_STATUSES.map((s) => (
							<option key={s} value={s}>
								{t(`profile.misconceptions.statusOptions.${s}`)}
							</option>
						))}
					</select>
				</label>
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.severity")}: {Math.round(draft.severity * 100)}%</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(draft.severity * 100)}
						onChange={(e) => {
							setDraft({ ...draft, severity: Number(e.target.value) / 100 });
							setDirty(true);
						}}
						className="w-full"
					/>
				</label>
			</div>
			<label className="mt-2 block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.repair")}</span>
				<textarea
					className="h-16 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5 text-sm"
					value={draft.repair}
					onChange={(e) => {
						setDraft({ ...draft, repair: e.target.value });
						setDirty(true);
					}}
				/>
			</label>
			{dirty ? (
				<div className="mt-2 flex justify-end gap-2">
					<button className="rounded-lg bg-[var(--inno-surface)] px-3 py-1 text-xs text-[var(--inno-text-muted)]" onClick={() => setDirty(false)}>
						{t("common.cancel")}
					</button>
					<button className="rounded-lg inno-primary-button px-3 py-1 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			) : null}
		</div>
	);
}

function PreferencesSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile, isSaving: learnerStore.isSaving }));
	const prefs = state.profile?.preferences ?? { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] };
	const [draft, setDraft] = useState(prefs);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setDraft(prefs);
	}, [state.profile, dirty, prefs]);

	function update(key: keyof typeof prefs, values: string[]) {
		setDraft({ ...draft, [key]: values });
		setDirty(true);
	}

	async function save() {
		await learnerStore.patchPreferences(draft);
		setDirty(false);
	}

	const fields: { key: keyof typeof prefs; label: string }[] = [
		{ key: "explanation_style", label: t("profile.preferences.explanationStyle") },
		{ key: "practice_style", label: t("profile.preferences.practiceStyle") },
		{ key: "feedback_tone", label: t("profile.preferences.feedbackTone") },
		{ key: "avoid", label: t("profile.preferences.avoid") },
	];

	return (
		<Section title={t("profile.sections.preferences")}>
			<div className="grid gap-3 sm:grid-cols-2">
				{fields.map(({ key, label }) => (
					<ChipInput key={key} label={label} values={draft[key]} onChange={(v) => update(key, v)} placeholder={t("profile.preferences.addPlaceholder") ?? ""} />
				))}
			</div>
			{dirty ? (
				<div className="mt-3 flex justify-end gap-2">
					<button className="rounded-lg bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)]" onClick={() => setDirty(false)}>
						{t("common.cancel")}
					</button>
					<button className="rounded-lg inno-primary-button px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={state.isSaving} onClick={() => void save()}>
						{state.isSaving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			) : null}
		</Section>
	);
}

function ChipInput({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange(next: string[]): void; placeholder: string }) {
	const [input, setInput] = useState("");
	function add() {
		const v = input.trim();
		if (!v || values.includes(v)) {
			setInput("");
			return;
		}
		onChange([...values, v]);
		setInput("");
	}
	return (
		<div>
			<div className="mb-1 text-xs font-medium text-[var(--inno-text)]">{label}</div>
			<div className="flex flex-wrap gap-1">
				{values.map((v) => (
					<span key={v} className="inline-flex items-center gap-1 rounded-full bg-[var(--inno-accent-soft)] px-2 py-0.5 text-xs text-[var(--inno-accent)]">
						{v}
						<button className="text-[var(--inno-accent)]" onClick={() => onChange(values.filter((x) => x !== v))}>
							×
						</button>
					</span>
				))}
				<input
					className="min-w-[120px] flex-1 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
					placeholder={placeholder}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
					onBlur={add}
				/>
			</div>
		</div>
	);
}

export function LearnerProfilePanel() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isLoading: learnerStore.isLoading,
		error: learnerStore.error,
	}));

	useEffect(() => {
		void learnerStore.load();
	}, []);

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 pb-8 pt-2.5">
				<div className="flex items-start justify-between gap-3 pb-1">
					<div className="text-[12.5px] leading-relaxed text-[var(--inno-text-subtle)]">
						<p>{t("profile.subtitle")}</p>
						{state.profile ? (
							<p>{t("profile.version", { version: state.profile.version, updated: formatDate(state.profile.updated_at) })}</p>
						) : null}
					</div>
					<button
						className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] inno-primary-button px-4 py-2 text-[13px] text-white"
						onClick={() => void learnerStore.load()}
					>
						<RefreshCw size={14} />
						{t("profile.refresh")}
					</button>
				</div>

				{state.isLoading ? (
					<div className="flex items-center justify-center py-8 text-[var(--inno-text-muted)]">
						<Spinner size={16} className="mr-2" />
						{t("common.loading")}
					</div>
				) : null}

				{state.error ? <div className="rounded-lg bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{state.error}</div> : null}

				{state.profile ? (
					<>
						<SummarySection />
						<GoalsSection />
						<KnowledgeSection />
						<MisconceptionsSection />
						<PreferencesSection />
					</>
				) : null}
			</div>
		</div>
	);
}
