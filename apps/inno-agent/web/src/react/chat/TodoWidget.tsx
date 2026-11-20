import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ChevronUp, Circle, Link2, Loader2 } from "lucide-react";
import type { ChatMessage, ChatToolRecord } from "../../types/chat.js";

/* ---------- todo state extraction (from rpiv-todo tool result details) ---------- */

export interface TodoTaskItem {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	activeForm?: string;
	blockedBy?: number[];
}

function parseTasks(value: unknown): TodoTaskItem[] | null {
	if (!Array.isArray(value)) return null;
	const tasks: TodoTaskItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") return null;
		const t = raw as Record<string, unknown>;
		if (typeof t.id !== "number" || typeof t.subject !== "string" || typeof t.status !== "string") return null;
		if (!["pending", "in_progress", "completed", "deleted"].includes(t.status)) return null;
		tasks.push({
			id: t.id,
			subject: t.subject,
			status: t.status as TodoTaskItem["status"],
			activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
			blockedBy: Array.isArray(t.blockedBy)
				? t.blockedBy.filter((id): id is number => typeof id === "number")
				: undefined,
		});
	}
	return tasks;
}

/** Every todo tool call's result.details carries a full task-list snapshot;
 *  the latest one wins. Scans history messages, then the in-flight turn's
 *  tool records (completed before active). Returns null when no todo call
 *  has ever produced a snapshot. */
function tasksFromToolRecord(tool: ChatToolRecord): TodoTaskItem[] | null {
	if (tool.toolName !== "todo" || tool.isError) return null;
	// Live SSE tool_end wraps the envelope ({ content, details }); session
	// history stores the details object directly (see parseSessionFile).
	const result = tool.result as { details?: { tasks?: unknown }; tasks?: unknown } | undefined;
	return parseTasks(result?.details?.tasks) ?? parseTasks(result?.tasks);
}

export function extractTodoTasks(chat: {
	messages: ChatMessage[];
	activeTools: ChatToolRecord[];
	completedTools: ChatToolRecord[];
}): TodoTaskItem[] | null {
	let latest: TodoTaskItem[] | null = null;
	// A new user message starts a new turn. Do not carry the previous turn's
	// snapshot into the composer while the next request is being prepared.
	const lastUserMessageIndex = chat.messages.reduce(
		(lastIndex, message, index) => message.role === "user" ? index : lastIndex,
		-1,
	);
	const currentTurnMessages = lastUserMessageIndex >= 0
		? chat.messages.slice(lastUserMessageIndex)
		: chat.messages;
	for (const message of currentTurnMessages) {
		for (const tool of message.tools ?? []) {
			const tasks = tasksFromToolRecord(tool);
			if (tasks) latest = tasks;
		}
	}
	for (const tool of [...chat.completedTools, ...chat.activeTools]) {
		const tasks = tasksFromToolRecord(tool);
		if (tasks) latest = tasks;
	}
	return latest;
}

/* ---------- progress ring ---------- */

function ProgressRing({ ratio, active }: { ratio: number; active: boolean }) {
	const size = 14;
	const stroke = 2;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--inno-border)" strokeWidth={stroke} />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke={active ? "var(--inno-accent)" : "var(--inno-text-subtle)"}
				strokeWidth={stroke}
				strokeLinecap="round"
				strokeDasharray={circumference}
				strokeDashoffset={circumference * (1 - ratio)}
				transform={`rotate(-90 ${size / 2} ${size / 2})`}
				className="transition-all duration-300"
			/>
		</svg>
	);
}

/* ---------- widget ---------- */

function TaskStatusIcon({ task }: { task: TodoTaskItem }) {
	if (task.status === "completed") return <CheckCircle2 size={15} className="shrink-0 text-[var(--inno-success)]" />;
	if (task.status === "in_progress") return <Loader2 size={15} className="shrink-0 animate-spin text-[var(--inno-accent)]" />;
	return <Circle size={15} className="shrink-0 text-[var(--inno-text-subtle)]" />;
}

export function TodoWidget({ tasks }: { tasks: TodoTaskItem[] }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);

	const visible = useMemo(() => tasks.filter((task) => task.status !== "deleted"), [tasks]);
	if (visible.length === 0) return null;

	const completed = visible.filter((task) => task.status === "completed").length;
	const total = visible.length;
	const inProgressIndex = visible.findIndex((task) => task.status === "in_progress");
	const allDone = completed === total;
	// "第 N / M 步": the in-progress step, else the next pending step, else M/M.
	const currentStep = inProgressIndex >= 0 ? inProgressIndex + 1 : Math.min(completed + 1, total);

	return (
		<div className="mb-2 flex flex-col items-center">
			<AnimatePresence initial={false}>
				{expanded ? (
					<motion.div
						key="todo-detail"
						initial={{ opacity: 0, y: 6, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 6, scale: 0.98 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="mb-1.5 w-full max-w-md overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-lg"
					>
						<div className="max-h-56 overflow-y-auto px-3 py-2">
							{visible.map((task) => (
								<div key={task.id} className="flex items-center gap-2 py-1.5">
									<span className="shrink-0"><TaskStatusIcon task={task} /></span>
									<div className="min-w-0 flex-1">
										<span
											className={`break-words text-[13px] leading-snug ${
												task.status === "completed"
													? "text-[var(--inno-text-subtle)] line-through"
													: "text-[var(--inno-text)]"
											}`}
										>
											{task.subject}
										</span>
										{task.status === "in_progress" && task.activeForm ? (
											<span className="ml-1.5 break-words text-xs text-[var(--inno-text-muted)]">
												{task.activeForm}…
											</span>
										) : null}
										{task.status === "pending" && task.blockedBy && task.blockedBy.length > 0 ? (
											<span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-[var(--inno-text-subtle)]">
												<Link2 size={11} />
												{task.blockedBy.map((id) => `#${id}`).join(",")}
											</span>
										) : null}
									</div>
								</div>
							))}
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>

			<button
				onClick={() => setExpanded((v) => !v)}
				className="flex items-center gap-1.5 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1 text-xs text-[var(--inno-text-muted)] shadow-sm transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
			>
				<ProgressRing ratio={total > 0 ? completed / total : 0} active={!allDone} />
				<span>
					{allDone
						? t("chat.todo.allDone", "已完成 {{completed}} / {{total}} 步", { completed, total })
						: t("chat.todo.progress", "第 {{current}} / {{total}} 步", { current: currentStep, total })}
				</span>
				<ChevronUp size={12} className={`text-[var(--inno-text-subtle)] transition-transform ${expanded ? "" : "rotate-180"}`} />
			</button>
		</div>
	);
}
