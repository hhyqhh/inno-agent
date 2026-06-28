/**
 * Auto Spaced-Review Syncer.
 *
 * Reads the L1 learner profile, finds concepts whose review_due_at lies in the
 * future, and creates / updates / deletes one-shot scheduler jobs so the agent
 * is prompted to deliver a review session at the right time.
 *
 * This is a self-contained pluggable module — the extension wires it in via the
 * turn_end hook, and the user toggles it via Settings → 记忆分层 → 自动间隔复习.
 */

import { JobStore } from "../scheduler/job-store.js";
import { loadProfile } from "../memory/learner/profile-store.js";
import { logger } from "../logger.js";

/** Prefix used to identify auto-review scheduler jobs. */
const REVIEW_JOB_PREFIX = "[自动复习]";

/**
 * Build a 5-field one-shot cron from an ISO-8601 timestamp.
 */
function cronFromISO(iso: string): string {
	const d = new Date(iso);
	const m = d.getMinutes();
	const h = d.getHours();
	const dom = d.getDate();
	const mon = d.getMonth() + 1;
	return `${m} ${h} ${dom} ${mon} *`;
}

interface ReviewConcept {
	conceptId: string;
	conceptName: string;
	reviewDueAt: string;
	mastery: number;
	diagnosis: string;
	lastPracticedAt?: string;
}

function extractReviewConcepts(learnerDataDir: string): ReviewConcept[] {
	const profile = loadProfile(learnerDataDir);
	const now = Date.now();
	return profile.knowledge_states
		.filter((ks) => {
			if (!ks.review_due_at) return false;
			const dueMs = Date.parse(ks.review_due_at);
			return Number.isFinite(dueMs) && dueMs > now;
		})
		.map((ks) => ({
			conceptId: ks.concept_id,
			conceptName: ks.concept_name,
			reviewDueAt: ks.review_due_at!,
			mastery: ks.mastery,
			diagnosis: ks.diagnosis,
			lastPracticedAt: ks.last_practiced_at,
		}));
}

function reviewJobName(concept: ReviewConcept): string {
	return `${REVIEW_JOB_PREFIX} ${concept.conceptName}`;
}

function buildReviewPrompt(concept: ReviewConcept): string {
	const masteryPct = Math.round(concept.mastery * 100);
	const lastPractice = concept.lastPracticedAt
		? concept.lastPracticedAt.slice(0, 10)
		: "未记录";
	return [
		`系统自动生成间隔复习任务：${concept.conceptName}`,
		"",
		`- 概念 ID: ${concept.conceptId}`,
		`- 当前掌握度: ${masteryPct}%`,
		`- 上次练习: ${lastPractice}`,
		`- L1 诊断: ${concept.diagnosis}`,
		"",
		`请根据以上信息为学习者生成一份简短复习材料：`,
		`1. 先简要回顾 ${concept.conceptName} 的核心知识点`,
		`2. 出 1-2 道复习题（难度依据 mastery ${masteryPct}% 调整）`,
		`3. 根据回答情况调用 patch_learner_profile 更新掌握度`,
	].join("\n");
}

export interface AutoReviewSyncer {
	sync(): void;
}

export function createAutoReviewSyncer(opts: {
	jobsDir: string;
	learnerDataDir: string;
	isEnabled: () => boolean;
}): AutoReviewSyncer | null {
	if (!opts.jobsDir || !opts.learnerDataDir) return null;

	const jobStore = new JobStore(opts.jobsDir);

	return {
		sync() {
			if (!opts.isEnabled()) return;

			let concepts: ReviewConcept[];
			try {
				concepts = extractReviewConcepts(opts.learnerDataDir);
			} catch (err) {
				logger.warn({ err }, "[auto-review] Failed to read L1 profile");
				return;
			}

			const allJobs = jobStore.list();
			const managedJobIds = new Set<string>();

			for (const concept of concepts) {
				const name = reviewJobName(concept);
				const cron = cronFromISO(concept.reviewDueAt);
				const existing = allJobs.find(
					(j) => j.name === name && j.taskType === "spaced_review",
				);

				if (existing) {
					managedJobIds.add(existing.id);
					if (existing.cron !== cron) {
						jobStore.update(existing.id, {
							cron,
							prompt: buildReviewPrompt(concept),
							enabled: true,
						});
					}
					continue;
				}

				const job = jobStore.create({
					name,
					cron,
					timezone: "Asia/Shanghai",
					taskType: "spaced_review",
					prompt: buildReviewPrompt(concept),
					enabled: true,
				});
				managedJobIds.add(job.id);
				logger.info(
					{ name, conceptId: concept.conceptId, cron },
					"[auto-review] Created review job",
				);
			}

			for (const job of allJobs) {
				if (
					job.name.startsWith(REVIEW_JOB_PREFIX) &&
					job.taskType === "spaced_review" &&
					!managedJobIds.has(job.id)
				) {
					jobStore.delete(job.id);
					logger.info(
						{ name: job.name },
						"[auto-review] Removed stale review job",
					);
				}
			}
		},
	};
}
