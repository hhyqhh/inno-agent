import type { JobStore } from "../scheduler/job-store.js";

/**
 * Default learning reminders created on first boot.
 *
 * Cron minutes are off the :00 / :30 marks to avoid fleet-wide thundering-herd
 * request peaks (every user who sets "9:00" fires at the same instant).
 *
 * These are plain push_reminder jobs — no LLM invocation, just a formatted
 * message injected into the Web UI chat window. When a channel (Feishu/WeChat)
 * is configured, the message is also pushed to the user's phone.
 */
const DEFAULT_LEARNING_REMINDERS = [
	{
		name: "每日学习提醒",
		cron: "3 9 * * *",
		prompt: "早上好！今天打算学什么？花 5 分钟列一下今天的学习目标吧 📝",
	},
	{
		name: "晚间复习提醒",
		cron: "7 19 * * *",
		prompt: "一天结束了，回顾一下今天学了什么？有什么需要明天巩固的？🧠",
	},
	{
		name: "周度学习回顾",
		cron: "7 21 * * 0",
		prompt: "周末了！这周学了哪些内容？下周的计划是什么？做个简短回顾吧 📊",
	},
];

/**
 * Ensure the three default learning reminders exist in the job store.
 * Idempotent — checks by name before creating so existing jobs are never
 * overwritten or duplicated. Returns the number of jobs created.
 */
export function ensureDefaultReminders(jobStore: JobStore): number {
	const jobs = jobStore.list();
	let created = 0;

	for (const tmpl of DEFAULT_LEARNING_REMINDERS) {
		if (!jobs.some((j) => j.name === tmpl.name)) {
			jobStore.create({
				name: tmpl.name,
				cron: tmpl.cron,
				timezone: "Asia/Shanghai",
				taskType: "push_reminder",
				prompt: tmpl.prompt,
				enabled: true,
			});
			created++;
		}
	}

	return created;
}
