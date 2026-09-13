import type {
	LearnerProfile,
	LearnerContextPack,
	LearningEvent,
} from "./types.js";
import { projectLearnerKnowledge } from "./state-engine.js";

/**
 * Build a short context pack from the current learner profile.
 * This is injected into the system prompt before each agent turn.
 */
function summarizeEvent(event: LearningEvent): string {
	const payload = event.payload;
	const label =
		typeof payload.topic === "string"
			? payload.topic
			: typeof payload.concept === "string"
				? payload.concept
				: typeof payload.goal === "string"
					? payload.goal
					: typeof payload.summary === "string"
						? payload.summary
						: (event.context.concept_ids ?? []).join(", ");
	return label || event.event_type;
}

export interface BuildContextPackOptions {
	asOf?: Date;
}

export function buildContextPack(
	profile: LearnerProfile,
	events: LearningEvent[] = [],
	options: BuildContextPackOptions = {},
): LearnerContextPack {
	const asOf = options.asOf ?? new Date();
	// Find highest-priority active goal
	const activeGoals = profile.goals
		.filter((g) => g.status === "active")
		.sort((a, b) => b.priority - a.priority);
	const activeGoal = activeGoals[0]?.title;

	const statePriority = {
		misconception: 0,
		review_due: 1,
		unknown: 2,
		learning: 3,
		fragile: 4,
		stable: 5,
	} as const;
	const projectedStates = projectLearnerKnowledge(profile, events, asOf);

	// Collect actionable concepts using the evidence-derived state before the
	// legacy numeric mastery as a tie breaker.
	const relevantConcepts = projectedStates
		.filter((ks) => ks.mastery < 1.0)
		.sort((a, b) => statePriority[a.state_label] - statePriority[b.state_label] || a.mastery - b.mastery)
		.slice(0, 5)
		.map((ks) => ({
			concept_id: ks.concept_id,
			mastery: ks.mastery,
			diagnosis: ks.diagnosis,
			estimate_confidence: ks.estimate_confidence,
			retrievability: ks.retrievability,
			state_label: ks.state_label,
			recommended_action: ks.next_actions[0],
		}));

	// Collect active misconceptions
	const activeMisconceptions = profile.misconceptions
		.filter((m) => m.status === "active")
		.map((m) => m.description);

	// Derive teaching hints from preferences
	const teachingHints: string[] = [];

	const styleMap: Record<string, string> = {
		example_first: "例子优先",
		code_first: "代码优先",
		theory_first: "理论优先",
		visual: "图示优先",
	};

	const practiceMap: Record<string, string> = {
		small_steps: "小步练习",
		immediate_feedback: "即时反馈",
		spaced_repetition: "间隔复习",
	};

	const toneMap: Record<string, string> = {
		direct: "直接",
		encouraging: "鼓励性",
		socratic: "苏格拉底式提问",
	};

	for (const style of profile.preferences.explanation_style) {
		if (styleMap[style]) teachingHints.push(styleMap[style]);
	}
	for (const style of profile.preferences.practice_style) {
		if (practiceMap[style]) teachingHints.push(practiceMap[style]);
	}
	for (const tone of profile.preferences.feedback_tone) {
		if (toneMap[tone]) teachingHints.push(toneMap[tone]);
	}
	for (const avoid of profile.preferences.avoid) {
		teachingHints.push(`避免：${avoid}`);
	}
	for (const pattern of profile.cognitive_patterns) {
		teachingHints.push(pattern.teaching_implication);
	}

	const now = asOf.getTime();
	const dynamicReviewDueConcepts = projectedStates
		.filter((ks) => ks.next_review_at && Date.parse(ks.next_review_at) <= now)
		.sort((a, b) => Date.parse(a.next_review_at!) - Date.parse(b.next_review_at!))
		.slice(0, 5)
		.map((ks) => ({
			concept_id: ks.concept_id,
			review_due_at: ks.next_review_at!,
			mastery: ks.mastery,
		}));
	const reviewDueByConcept = new Map(dynamicReviewDueConcepts.map((item) => [item.concept_id, item]));
	for (const state of profile.knowledge_states) {
		if (!state.review_due_at || Date.parse(state.review_due_at) > now || reviewDueByConcept.has(state.concept_id)) continue;
		reviewDueByConcept.set(state.concept_id, {
			concept_id: state.concept_id,
			review_due_at: state.review_due_at,
			mastery: state.mastery,
		});
	}
	const reviewDueConcepts = [...reviewDueByConcept.values()]
		.sort((a, b) => Date.parse(a.review_due_at) - Date.parse(b.review_due_at))
		.slice(0, 5);

	const recentEventSummaries = events
		.slice(-5)
		.reverse()
		.map((event) => ({
			event_id: event.event_id,
			event_type: event.event_type,
			timestamp: event.timestamp,
			summary: summarizeEvent(event),
		}));

	return {
		active_goal: activeGoal,
		relevant_concepts: relevantConcepts,
		active_misconceptions: activeMisconceptions,
		teaching_hints: teachingHints,
		cognitive_patterns: profile.cognitive_patterns.map((pattern) => ({
			label: pattern.label,
			teaching_implication: pattern.teaching_implication,
		})),
		recent_events: recentEventSummaries,
		review_due_concepts: reviewDueConcepts,
	};
}

/**
 * Format the context pack as a markdown section for system prompt injection.
 */
export function formatContextPackForPrompt(pack: LearnerContextPack): string {
	const lines: string[] = ["## 学习者上下文"];

	if (pack.active_goal) {
		lines.push(`\n当前目标：${pack.active_goal}`);
	} else {
		lines.push("\n当前目标：暂未设定");
	}

	if (pack.relevant_concepts.length > 0) {
		lines.push("\n相关概念：");
		for (const c of pack.relevant_concepts) {
			const state = c.state_label ? `，状态 ${c.state_label}` : "";
			const confidence = c.estimate_confidence === undefined
				? ""
				: `，估计置信度 ${c.estimate_confidence.toFixed(2)}`;
			const retrievability = c.retrievability === undefined
				? ""
				: `，当前可提取概率 ${c.retrievability.toFixed(2)}`;
			lines.push(`- ${c.concept_id}: 长期掌握度 ${c.mastery.toFixed(2)}${state}${confidence}${retrievability}，诊断：${c.diagnosis}`);
			if (c.recommended_action) lines.push(`  建议：${c.recommended_action}`);
		}
	}

	if (pack.active_misconceptions.length > 0) {
		lines.push("\n活跃误区：");
		for (const m of pack.active_misconceptions) {
			lines.push(`- ${m}`);
		}
	}

	if (pack.teaching_hints.length > 0) {
		lines.push("\n教学提示：");
		for (const h of pack.teaching_hints) {
			lines.push(`- ${h}`);
		}
	}

	if (pack.review_due_concepts && pack.review_due_concepts.length > 0) {
		lines.push("\n到期复习：");
		for (const c of pack.review_due_concepts) {
			lines.push(`- ${c.concept_id}: 掌握度 ${c.mastery.toFixed(2)}，到期 ${c.review_due_at}`);
		}
	}

	if (pack.recent_events && pack.recent_events.length > 0) {
		lines.push("\n最近学习事件：");
		for (const event of pack.recent_events) {
			lines.push(`- ${event.timestamp.slice(0, 10)} ${event.event_type}: ${event.summary} (${event.event_id})`);
		}
	}

	return lines.join("\n");
}
