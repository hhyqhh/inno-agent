import { randomUUID } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { buildWikiGraph } from "../../memory/l2/wiki-graph.js";
import { appendAssistantLearningFeedback, completePromptOnce } from "../../agent/pi-runner.js";
import { reviewPersonalLink } from "../../memory/learner/personal-link-review.js";
import { updateCognitivePatternsFromLinks } from "../../memory/learner/cognitive-patterns.js";
import {
	comparePersonalLinkToWiki,
	createPersonalLink,
	deletePersonalLink,
	loadPersonalLinks,
	setPersonalLinkFeedback,
	setPersonalLinkStatus,
	type CreatePersonalLinkInput,
	type PersonalLink,
	type PersonalLinkComparison,
	type PersonalLinkStatus,
} from "../../memory/learner/personal-links.js";
import { loadProfile, saveProfile } from "../../memory/learner/profile-store.js";
import type {
	KnowledgeState,
	LearnerPreferences,
	LearnerProfile,
	LearningGoal,
	Misconception,
} from "../../memory/learner/types.js";
import type { RuntimePaths } from "../../runtime.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

export interface LearnerRouteContext {
	paths: RuntimePaths;
	l2DataDir: string;
}

interface PersonalLinkResponse extends PersonalLink {
	comparison: PersonalLinkComparison;
}

function withWikiComparison(link: PersonalLink, l2DataDir: string): PersonalLinkResponse {
	return { ...link, comparison: comparePersonalLinkToWiki(link, buildWikiGraph(l2DataDir)) };
}

function nodeTitle(graph: ReturnType<typeof buildWikiGraph>, id: string): string {
	return graph.nodes.find((node) => node.id === id)?.title ?? id;
}

function whyNoDirectWikiLink(link: PersonalLinkResponse, graph: ReturnType<typeof buildWikiGraph>): string {
	const source = nodeTitle(graph, link.source);
	const target = nodeTitle(graph, link.target);
	if (link.comparison.alignment === "aligned") {
		return `Wiki 原本已有 ${source} 与 ${target} 的明确关联；这条虚线记录的是你的理解，不是在替换系统事实。`;
	}
	if (link.comparison.alignment === "system_indirect") {
		return "系统保留了中间的推理过程，没有把“经由其他概念才能成立的关系”直接写成无条件事实。";
	}
	return "当前 Wiki 的页面与显式链接还没有足够证据，把这层关系确认成系统事实；这不等于你的联想错误。";
}

function formatPersonalLinkReviewForChat(links: PersonalLinkResponse[], graph: ReturnType<typeof buildWikiGraph>): string {
	const actionLabel = {
		keep: "保留这条虚线",
		add_bridge: "拆成经过中间节点的连接",
		replace: "替换为更合适的连接",
		remove: "删除这条不恰当的连接",
	} as const;
	const sections = links.map((link) => {
		const source = nodeTitle(graph, link.source);
		const target = nodeTitle(graph, link.target);
		const feedback = link.feedback;
		const verdict = feedback?.verdict === "supported"
			? "联系成立"
			: feedback?.verdict === "needs_bridge"
				? "方向合理，但需要补桥"
				: "值得保留为探索";
		const recommendedTitles = feedback?.recommended_node_ids.map((id) => nodeTitle(graph, id)).join("、");
		return [
			`### ${source} -- ${target}`,
			`**你的理由**：${link.reason}`,
			`**结论**：${verdict}`,
			feedback ? `**先校正概念**：${feedback.concept_clarification}` : "**反馈**：本次未能生成完整评议。",
			feedback ? `**你的理解哪里可能偏了**：${feedback.misconception_check}` : null,
			feedback ? `**这条关系的判断**：${feedback.summary}` : null,
			`**系统为什么一开始没有直接连上**：${whyNoDirectWikiLink(link, graph)}`,
			feedback ? `**依据**：${feedback.evidence}` : null,
			feedback ? `**建议操作**：${actionLabel[feedback.recommended_action]}。${feedback.recommendation}` : null,
			recommendedTitles ? `**建议使用的图谱节点**：${recommendedTitles}` : null,
		].filter((line): line is string => Boolean(line)).join("\n\n");
	});
	return [
		"## 本轮知识连接评议",
		"系统先校正概念定义，再判断你的连线；它会给出保留、拆线、替换或删除的具体建议。",
		...sections,
	].join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split)
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

function normalizePreferences(input: Partial<LearnerPreferences>): LearnerPreferences {
	function arr(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
	}
	return {
		explanation_style: arr(input.explanation_style),
		practice_style: arr(input.practice_style),
		feedback_tone: arr(input.feedback_tone),
		avoid: arr(input.avoid),
	};
}

/**
 * /api/learner/* route domain (L1 profile inspect/edit). Returns true when
 * the request was handled. Extracted verbatim from server.ts during the P2
 * route split — behavior unchanged.
 */
export async function handleLearnerRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: LearnerRouteContext,
): Promise<boolean> {
	const { paths, l2DataDir } = ctx;

	// --- Learner-created wiki connections ---
	if (method === "GET" && url === "/api/learner/personal-links") {
		const links = loadPersonalLinks(paths.learnerDataDir)
			.map((link) => withWikiComparison(link, l2DataDir));
		json(res, 200, { links });
		return true;
	}

	if (method === "POST" && url === "/api/learner/personal-links") {
		try {
			const body = await readBody(req) as Partial<CreatePersonalLinkInput>;
			const link = createPersonalLink(paths.learnerDataDir, {
				source: typeof body.source === "string" ? body.source : "",
				target: typeof body.target === "string" ? body.target : "",
				reason: typeof body.reason === "string" ? body.reason : "",
				batch_id: typeof body.batch_id === "string" ? body.batch_id : undefined,
			});
			json(res, 201, withWikiComparison(link, l2DataDir));
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to create personal link" });
		}
		return true;
	}

	if (method === "POST" && url === "/api/learner/personal-links/review-batch") {
		const body = await readBody(req) as { ids?: unknown; session_id?: unknown };
		const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
		if (ids.length === 0) {
			json(res, 400, { error: "Select at least one new personal link to review" });
			return true;
		}
		const graph = buildWikiGraph(l2DataDir);
		const byId = new Map(loadPersonalLinks(paths.learnerDataDir).map((link) => [link.id, link]));
		const reviewed = [] as PersonalLink[];
		for (const id of ids) {
			const link = byId.get(id);
			if (!link || link.feedback) continue;
			const comparison = comparePersonalLinkToWiki(link, graph);
			const feedback = await reviewPersonalLink(link, graph, comparison, l2DataDir, completePromptOnce);
			reviewed.push(setPersonalLinkFeedback(paths.learnerDataDir, id, feedback));
		}
		const patterns = updateCognitivePatternsFromLinks(paths.learnerDataDir, reviewed);
		const reviewedResponses = reviewed.map((link) => ({ ...link, comparison: comparePersonalLinkToWiki(link, graph) }));
		const chatFeedback = formatPersonalLinkReviewForChat(reviewedResponses, graph);
		const sessionId = typeof body.session_id === "string" ? body.session_id : "";
		const chatFeedbackPersisted = sessionId
			? appendAssistantLearningFeedback(chatFeedback, sessionId)
			: false;
		json(res, 200, {
			links: reviewedResponses,
			patterns,
			chat_feedback: chatFeedback,
			chat_feedback_persisted: chatFeedbackPersisted,
		});
		return true;
	}

	const personalLinkPatchMatch = matchRoute("PATCH", method, url, "/api/learner/personal-links/:id");
	if (personalLinkPatchMatch) {
		const body = await readBody(req) as { status?: unknown };
		if (body.status !== "proposed" && body.status !== "accepted" && body.status !== "rejected") {
			json(res, 400, { error: "status must be proposed, accepted, or rejected" });
			return true;
		}
		try {
			const link = setPersonalLinkStatus(paths.learnerDataDir, personalLinkPatchMatch.id, body.status as PersonalLinkStatus);
			json(res, 200, withWikiComparison(link, l2DataDir));
		} catch (err) {
			json(res, 404, { error: err instanceof Error ? err.message : "Personal link not found" });
		}
		return true;
	}

	const personalLinkDeleteMatch = matchRoute("DELETE", method, url, "/api/learner/personal-links/:id");
	if (personalLinkDeleteMatch) {
		if (!deletePersonalLink(paths.learnerDataDir, personalLinkDeleteMatch.id)) {
			json(res, 404, { error: "Personal link not found" });
			return true;
		}
		json(res, 200, { deleted: true });
		return true;
	}

	// --- Learner profile API (L1) ---
	if (method === "GET" && url === "/api/learner/profile") {
		const profile = loadProfile(paths.learnerDataDir);
		json(res, 200, profile);
		return true;
	}

	if (method === "PATCH" && url === "/api/learner/profile") {
		const body = await readBody(req) as Partial<LearnerProfile>;
		const profile = loadProfile(paths.learnerDataDir);
		if (typeof body.profile_summary === "string") {
			profile.profile_summary = body.profile_summary;
		}
		if (body.preferences && typeof body.preferences === "object") {
			profile.preferences = normalizePreferences(body.preferences as Partial<LearnerPreferences>);
		}
		saveProfile(paths.learnerDataDir, profile);
		json(res, 200, profile);
		return true;
	}

	if (method === "POST" && url === "/api/learner/profile/goals") {
		const body = await readBody(req) as Partial<LearningGoal>;
		const profile = loadProfile(paths.learnerDataDir);
		const goal: LearningGoal = {
			goal_id: `goal_${randomUUID().slice(0, 8)}`,
			title: typeof body.title === "string" ? body.title : "新目标",
			type: (body.type as LearningGoal["type"]) || "skill",
			priority: typeof body.priority === "number" ? body.priority : 0.5,
			status: (body.status as LearningGoal["status"]) || "active",
			success_criteria: Array.isArray(body.success_criteria) ? body.success_criteria.filter((s) => typeof s === "string") : [],
			source: "user_declared",
			updated_at: new Date().toISOString(),
		};
		profile.goals = [goal, ...profile.goals];
		saveProfile(paths.learnerDataDir, profile);
		json(res, 201, goal);
		return true;
	}

	const goalPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/goals/:goalId");
	if (goalPatchMatch) {
		const body = await readBody(req) as Partial<LearningGoal>;
		const profile = loadProfile(paths.learnerDataDir);
		const index = profile.goals.findIndex((g) => g.goal_id === goalPatchMatch.goalId);
		if (index < 0) {
			json(res, 404, { error: "Goal not found" });
			return true;
		}
		const current = profile.goals[index];
		profile.goals[index] = {
			...current,
			title: typeof body.title === "string" ? body.title : current.title,
			type: (body.type as LearningGoal["type"]) ?? current.type,
			priority: typeof body.priority === "number" ? body.priority : current.priority,
			status: (body.status as LearningGoal["status"]) ?? current.status,
			success_criteria: Array.isArray(body.success_criteria)
				? body.success_criteria.filter((s) => typeof s === "string")
				: current.success_criteria,
			updated_at: new Date().toISOString(),
		};
		saveProfile(paths.learnerDataDir, profile);
		json(res, 200, profile.goals[index]);
		return true;
	}

	const goalDeleteMatch = matchRoute("DELETE", method, url, "/api/learner/profile/goals/:goalId");
	if (goalDeleteMatch) {
		const profile = loadProfile(paths.learnerDataDir);
		const before = profile.goals.length;
		profile.goals = profile.goals.filter((g) => g.goal_id !== goalDeleteMatch.goalId);
		if (profile.goals.length === before) {
			json(res, 404, { error: "Goal not found" });
			return true;
		}
		saveProfile(paths.learnerDataDir, profile);
		json(res, 200, { deleted: true });
		return true;
	}

	const knowledgePatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/knowledge/:conceptId");
	if (knowledgePatchMatch) {
		const body = await readBody(req) as Partial<KnowledgeState>;
		const profile = loadProfile(paths.learnerDataDir);
		const index = profile.knowledge_states.findIndex((k) => k.concept_id === knowledgePatchMatch.conceptId);
		if (index < 0) {
			json(res, 404, { error: "Concept not found" });
			return true;
		}
		const current = profile.knowledge_states[index];
		profile.knowledge_states[index] = {
			...current,
			mastery: typeof body.mastery === "number" ? clamp01(body.mastery) : current.mastery,
			confidence: typeof body.confidence === "number" ? clamp01(body.confidence) : current.confidence,
			stability: typeof body.stability === "number" ? clamp01(body.stability) : current.stability,
			diagnosis: typeof body.diagnosis === "string" ? body.diagnosis : current.diagnosis,
			next_actions: Array.isArray(body.next_actions)
				? body.next_actions.filter((s) => typeof s === "string")
				: current.next_actions,
		};
		saveProfile(paths.learnerDataDir, profile);
		json(res, 200, profile.knowledge_states[index]);
		return true;
	}

	const misconceptionPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/misconceptions/:miscId");
	if (misconceptionPatchMatch) {
		const body = await readBody(req) as Partial<Misconception>;
		const profile = loadProfile(paths.learnerDataDir);
		const index = profile.misconceptions.findIndex((m) => m.misconception_id === misconceptionPatchMatch.miscId);
		if (index < 0) {
			json(res, 404, { error: "Misconception not found" });
			return true;
		}
		const current = profile.misconceptions[index];
		profile.misconceptions[index] = {
			...current,
			status: (body.status as Misconception["status"]) ?? current.status,
			severity: typeof body.severity === "number" ? clamp01(body.severity) : current.severity,
			repair_strategy: typeof body.repair_strategy === "string" ? body.repair_strategy : current.repair_strategy,
			last_seen_at: new Date().toISOString(),
		};
		saveProfile(paths.learnerDataDir, profile);
		json(res, 200, profile.misconceptions[index]);
		return true;
	}

	return false;
}
