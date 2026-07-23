import type {
	LearnerProfile,
	LearnerContextPack,
	LearningEvent,
} from "./types.js";

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

/**
 * Derive a teaching-hint string from recent affect signals.
 *
 * Based on D'Mello & Graesser (2012) and Pekrun's Control-Value Theory (2006):
 * - frustrated / confused  → lower perceived difficulty, add scaffolding
 * - bored / disengaged     → raise challenge, introduce novelty
 * - engaged / excited      → maintain pace, optionally stretch further
 * - neutral / absent       → no hint injected (avoid noise)
 */
function deriveAffectHint(recentEvents: LearningEvent[]): string | undefined {
	const NEGATIVE = /frustrat|沮丧|confused|困惑|stuck|卡住|angry|焦虑|anxious|overwhelm|overwhelmed/i;
	const BORED    = /bored|无聊|disengaged|distracted|boring/i;
	const POSITIVE = /engaged|excited|兴奋|投入|motivated|happy|happy|好|很好|棒|great|excellent/i;

	let negScore = 0;
	let boredScore = 0;
	let posScore = 0;

	for (const event of recentEvents.slice(-5)) {
		const affect = event.derived_signals?.affect;
		if (typeof affect !== "string" || !affect.trim()) continue;
		if (NEGATIVE.test(affect)) negScore += 1;
		else if (BORED.test(affect)) boredScore += 1;
		else if (POSITIVE.test(affect)) posScore += 1;
	}

	if (negScore >= 2) {
		return "情绪提示：学习者近期表现出困惑或沮丧——请降低当前讲解难度，多用例子和脚手架支撑，并给予鼓励性反馈";
	}
	if (negScore === 1 && posScore === 0) {
		return "情绪提示：学习者可能有轻度困惑——优先确认理解，再推进新内容";
	}
	if (boredScore >= 2) {
		return "情绪提示：学习者可能感到无聊——适当提升挑战难度或引入新颖角度以重新激活投入感";
	}
	if (posScore >= 2) {
		return "情绪提示：学习者当前投入度高——可适度提升挑战，保持学习动力";
	}
	return undefined;
}

export function buildContextPack(profile: LearnerProfile, recentEvents: LearningEvent[] = []): LearnerContextPack {
	// Find highest-priority active goal
	const activeGoals = profile.goals
		.filter((g) => g.status === "active")
		.sort((a, b) => b.priority - a.priority);
	const activeGoal = activeGoals[0]?.title;

	// Collect concepts with mastery < 1.0, sorted by mastery ascending (weakest first)
	const relevantConcepts = profile.knowledge_states
		.filter((ks) => ks.mastery < 1.0)
		.sort((a, b) => a.mastery - b.mastery)
		.slice(0, 5)
		.map((ks) => ({
			concept_id: ks.concept_id,
			mastery: ks.mastery,
			diagnosis: ks.diagnosis || "暂无诊断",
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

	const now = Date.now();
	const reviewDueConcepts = profile.knowledge_states
		.filter((ks) => ks.review_due_at && Date.parse(ks.review_due_at) <= now)
		.sort((a, b) => Date.parse(a.review_due_at!) - Date.parse(b.review_due_at!))
		.slice(0, 5)
		.map((ks) => ({
			concept_id: ks.concept_id,
			review_due_at: ks.review_due_at!,
			mastery: ks.mastery,
		}));

	// Affect-aware teaching hints (D'Mello & Graesser, 2012; Pekrun, 2006)
	const affectHint = deriveAffectHint(recentEvents);
	if (affectHint) teachingHints.push(affectHint);

	const recentEventSummaries = recentEvents
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
			lines.push(`- ${c.concept_id}: 掌握度 ${c.mastery.toFixed(2)}，诊断：${c.diagnosis}`);
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
