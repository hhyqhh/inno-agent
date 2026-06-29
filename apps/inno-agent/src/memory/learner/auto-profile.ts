import type {
	KnowledgeState,
	LearnerPreferences,
	LearnerProfile,
	LearningEvent,
	LearningGoal,
} from "./types.js";

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function normalizeIdPart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._\-\u4e00-\u9fa5]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

function payloadString(event: LearningEvent, key: string): string | undefined {
	const value = event.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventText(event: LearningEvent): string {
	const parts: string[] = [];
	for (const value of Object.values(event.payload)) {
		if (typeof value === "string") parts.push(value);
		if (Array.isArray(value)) {
			parts.push(...value.filter((item): item is string => typeof item === "string"));
		}
	}
	if (event.context.goal_id) parts.push(event.context.goal_id);
	if (event.context.concept_ids) parts.push(...event.context.concept_ids);
	return parts.join(" ");
}

function hasArchiveIntent(text: string): boolean {
	return /不学|不学习|不再学习|放弃|停止学习|取消.*目标|归档|archive|archived|stop learning|quit/i.test(text);
}

function targetMatchesGoal(goal: LearningGoal, targetText: string, targetGoalId?: string): boolean {
	const haystack = `${goal.goal_id} ${goal.title}`.toLowerCase();
	const target = targetText.toLowerCase();
	if (targetGoalId && goal.goal_id === targetGoalId) return true;
	if (target.includes(goal.goal_id.toLowerCase())) return true;
	if (target.includes(goal.title.toLowerCase())) return true;

	if (/rust/i.test(target)) return /rust/i.test(haystack);
	if (/c\+\+|cpp/i.test(target)) return /c\+\+|cpp/i.test(haystack);
	if (/python/i.test(target)) return /python/i.test(haystack);
	if (/typescript|\bts\b/i.test(target)) return /typescript|\bts\b/i.test(haystack);
	return false;
}

function archiveMatchingGoals(profile: LearnerProfile, targetText: string, timestamp: string, targetGoalId?: string): boolean {
	let changed = false;
	for (const goal of profile.goals) {
		if (!targetMatchesGoal(goal, targetText, targetGoalId)) continue;
		if (goal.status !== "archived" || goal.priority !== 0 || goal.updated_at !== timestamp) {
			goal.status = "archived";
			goal.priority = 0;
			goal.updated_at = timestamp;
			changed = true;
		}
	}
	return changed;
}

function targetMatchesKnowledge(state: KnowledgeState, targetText: string): boolean {
	const haystack = `${state.concept_id} ${state.concept_name} ${state.domain}`.toLowerCase();
	const target = targetText.toLowerCase();
	if (target.includes(state.concept_id.toLowerCase())) return true;
	if (/rust/i.test(target)) return /rust/i.test(haystack);
	if (/c\+\+|cpp/i.test(target)) return /c\+\+|cpp/i.test(haystack);
	if (/python/i.test(target)) return /python/i.test(haystack);
	if (/typescript|\bts\b/i.test(target)) return /typescript|\bts\b/i.test(haystack);
	return false;
}

function archiveMatchingKnowledge(profile: LearnerProfile, targetText: string): boolean {
	let changed = false;
	for (const state of profile.knowledge_states) {
		if (!targetMatchesKnowledge(state, targetText)) continue;
		const diagnosis = "相关学习目标已归档；除非用户重新提出该方向，否则不再主动安排该概念学习。";
		if (
			state.diagnosis !== diagnosis ||
			state.next_actions.length > 0 ||
			state.review_due_at !== undefined
		) {
			state.diagnosis = diagnosis;
			state.next_actions = [];
			delete state.review_due_at;
			changed = true;
		}
	}
	return changed;
}

function titleFromConceptId(conceptId: string): string {
	const last = conceptId.split(/[._/]/).filter(Boolean).at(-1) ?? conceptId;
	return last.replace(/[_-]+/g, " ");
}

function inferDomain(conceptId: string): string {
	const parts = conceptId.split(".");
	return parts.length > 1 ? parts.slice(0, -1).join(".") : "general";
}

function mapPreference(raw: string): Partial<LearnerPreferences> {
	const text = raw.trim();
	const lowered = text.toLowerCase();
	if (!text) return {};

	if (text.includes("避免") || lowered.startsWith("avoid")) {
		return { avoid: [text.replace(/^避免[:：]?\s*/, "")] };
	}
	if (lowered.includes("code") || text.includes("代码")) {
		return { explanation_style: ["code_first"] };
	}
	if (lowered.includes("example") || text.includes("例子") || text.includes("示例")) {
		return { explanation_style: ["example_first"] };
	}
	if (text.includes("理论") || lowered.includes("theory")) {
		return { explanation_style: ["theory_first"] };
	}
	if (text.includes("小步") || lowered.includes("small")) {
		return { practice_style: ["small_steps"] };
	}
	if (text.includes("即时") || text.includes("反馈") || lowered.includes("feedback")) {
		return { practice_style: ["immediate_feedback"], feedback_tone: ["encouraging"] };
	}
	if (text.includes("鼓励") || lowered.includes("encourag")) {
		return { feedback_tone: ["encouraging"] };
	}
	if (text.includes("苏格拉底") || lowered.includes("socratic")) {
		return { feedback_tone: ["socratic"] };
	}
	return {};
}

function mergePreferences(profile: LearnerProfile, incoming: Partial<LearnerPreferences>): void {
	profile.preferences = {
		explanation_style: uniqueStrings([
			...profile.preferences.explanation_style,
			...(incoming.explanation_style ?? []),
		]),
		practice_style: uniqueStrings([
			...profile.preferences.practice_style,
			...(incoming.practice_style ?? []),
		]),
		feedback_tone: uniqueStrings([
			...profile.preferences.feedback_tone,
			...(incoming.feedback_tone ?? []),
		]),
		avoid: uniqueStrings([...profile.preferences.avoid, ...(incoming.avoid ?? [])]),
	};
}

function ensureKnowledgeState(profile: LearnerProfile, conceptId: string): KnowledgeState {
	let state = profile.knowledge_states.find((ks) => ks.concept_id === conceptId);
	if (state) return state;

	state = {
		concept_id: conceptId,
		concept_name: titleFromConceptId(conceptId),
		domain: inferDomain(conceptId),
		mastery: 0.05,
		confidence: 0.35,
		stability: 0.1,
		evidence_ids: [],
		diagnosis: "有学习接触记录，尚未形成稳定掌握度判断。",
		next_actions: ["继续通过讲解、练习或复盘补充证据。"],
	};
	profile.knowledge_states.push(state);
	return state;
}

/**
 * SM-2 spaced-repetition scheduling (Wozniak & Gorzelanczyk, 1994).
 *
 * quality 0-5: inferred from mastery_delta when not explicitly provided.
 *   5 = perfect recall, 4 = correct with hesitation, 3 = correct with difficulty,
 *   2 = incorrect but easy to recall, 1 = incorrect, 0 = complete blackout.
 *
 * Returns the ISO date string for the next review.
 */
function computeSM2Review(state: import("./types.js").KnowledgeState, event: LearningEvent): string {
	const SM2_EF_DEFAULT = 2.5;
	const SM2_EF_MIN = 1.3;

	// Derive quality from explicit payload or mastery_delta
	let quality: number;
	const rawQuality = event.payload.quality;
	if (typeof rawQuality === "number" && rawQuality >= 0 && rawQuality <= 5) {
		quality = Math.round(rawQuality);
	} else {
		const delta = typeof event.derived_signals?.mastery_delta === "number"
			? event.derived_signals.mastery_delta
			: event.event_type === "exercise_attempt" ? 0.03 : 0.02;
		// Map mastery + delta to a quality score
		const effective = clamp01((state.mastery + delta));
		quality = effective >= 0.85 ? 5 : effective >= 0.7 ? 4 : effective >= 0.5 ? 3 : effective >= 0.3 ? 2 : 1;
	}

	let ef = state.sm2_ef ?? SM2_EF_DEFAULT;
	let reps = state.sm2_repetitions ?? 0;
	let interval = state.sm2_interval ?? 1;

	if (quality >= 3) {
		// Successful recall — advance the streak
		if (reps === 0) {
			interval = 1;
		} else if (reps === 1) {
			interval = 6;
		} else {
			interval = Math.round(interval * ef);
		}
		reps += 1;
	} else {
		// Failed recall — reset streak, review tomorrow
		reps = 0;
		interval = 1;
	}

	// Update EF: EF' = EF + 0.1 − (5 − q)(0.08 + (5 − q) × 0.02)
	ef = Math.max(SM2_EF_MIN, ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

	// Persist SM-2 state back onto the KnowledgeState
	state.sm2_ef = ef;
	state.sm2_interval = interval;
	state.sm2_repetitions = reps;

	const due = new Date(event.timestamp);
	due.setDate(due.getDate() + interval);
	return due.toISOString();
}

function updateKnowledgeFromEvent(profile: LearnerProfile, event: LearningEvent): boolean {
	const conceptIds = event.context.concept_ids ?? [];
	if (conceptIds.length === 0) return false;

	const delta =
		typeof event.derived_signals?.mastery_delta === "number"
			? event.derived_signals.mastery_delta
			: event.event_type === "exercise_attempt"
				? 0.03
				: event.event_type === "concept_explained"
					? 0.02
					: event.event_type === "milestone_reached"
						? 0.02
						: event.event_type === "self_assessed"
							? 0.01
							: 0;

	let changed = false;
	for (const conceptId of conceptIds) {
		const state = ensureKnowledgeState(profile, conceptId);
		const hasSeenEvidence = state.evidence_ids.includes(event.event_id);
		const eventIsNewer =
			!state.last_practiced_at || Date.parse(event.timestamp) >= Date.parse(state.last_practiced_at);
		if (!state.evidence_ids.includes(event.event_id)) {
			state.evidence_ids.push(event.event_id);
			changed = true;
		}

		if (delta !== 0 && !hasSeenEvidence) {
			state.mastery = clamp01(state.mastery + delta);
			state.confidence = clamp01(Math.max(state.confidence, 0.45) + Math.abs(delta) * 0.2);
			state.stability = clamp01(state.stability + Math.max(0, delta) * 0.15);
			changed = true;
		}

		if (eventIsNewer && state.last_practiced_at !== event.timestamp) {
			state.last_practiced_at = event.timestamp;
			changed = true;
		}
		if (eventIsNewer && (event.event_type === "exercise_attempt" || event.event_type === "concept_explained")) {
			const nextReview = computeSM2Review(state, event);
			if (state.review_due_at !== nextReview) {
				state.review_due_at = nextReview;
				changed = true;
			}
		}

		const topic =
			typeof event.payload.topic === "string"
				? event.payload.topic
				: typeof event.payload.concept === "string"
					? event.payload.concept
					: typeof event.payload.summary === "string"
						? event.payload.summary
				: undefined;
		if (topic && eventIsNewer) {
			const before = JSON.stringify({
				diagnosis: state.diagnosis,
				next_actions: state.next_actions,
			});
			state.diagnosis = `最近学习/讨论了「${topic}」，需要后续练习验证掌握度。`;
			state.next_actions = uniqueStrings([
				`用自己的话复述 ${state.concept_name} 的核心机制。`,
				`完成一个小练习来验证 ${state.concept_name} 的掌握情况。`,
				...state.next_actions,
			]).slice(0, 5);
			const after = JSON.stringify({
				diagnosis: state.diagnosis,
				next_actions: state.next_actions,
			});
			if (before !== after) changed = true;
		}
	}
	return changed;
}

function updateGoalFromEvent(profile: LearnerProfile, event: LearningEvent): boolean {
	if (event.event_type !== "goal_declared") return false;
	const text = eventText(event);
	const rawGoal = payloadString(event, "goal");
	const previousGoal = payloadString(event, "previous_goal");
	const goalDescription = payloadString(event, "goal_description");
	let changed = false;

	if (previousGoal && hasArchiveIntent(text)) {
		changed = archiveMatchingGoals(profile, previousGoal, event.timestamp) || changed;
		changed = archiveMatchingKnowledge(profile, previousGoal) || changed;
	}

	if (hasArchiveIntent(text)) {
		const archiveTarget = goalDescription ?? previousGoal ?? rawGoal ?? text;
		changed = archiveMatchingGoals(profile, archiveTarget, event.timestamp, event.context.goal_id) || changed;
		changed = archiveMatchingKnowledge(profile, archiveTarget) || changed;
	}

	if (!rawGoal || hasArchiveIntent(rawGoal)) return changed;

	const goalId = event.context.goal_id ?? `goal_${normalizeIdPart(rawGoal)}`;
	const existing = profile.goals.find((g) => g.goal_id === goalId);
	const before = existing ? JSON.stringify(existing) : undefined;
	const goal: LearningGoal = existing ?? {
		goal_id: goalId,
		title: rawGoal,
		type: "skill",
		priority: 0.8,
		status: "active",
		success_criteria: [],
		source: "user_declared",
		updated_at: event.timestamp,
	};

	goal.title = rawGoal;
	goal.status = "active";
	if (goal.priority <= 0) goal.priority = 0.8;
	goal.updated_at = event.timestamp;
	if (!existing) profile.goals.push(goal);
	return changed || !existing || before !== JSON.stringify(goal);
}

function updatePreferencesFromEvent(profile: LearnerProfile, event: LearningEvent): boolean {
	const candidates = [
		...(event.derived_signals?.preference_candidates ?? []),
		...(event.event_type === "preference_stated" && typeof event.payload.preference === "string"
			? [event.payload.preference]
			: []),
	];
	if (candidates.length === 0) return false;

	const before = JSON.stringify(profile.preferences);
	for (const candidate of candidates) {
		mergePreferences(profile, mapPreference(candidate));
	}
	return JSON.stringify(profile.preferences) !== before;
}

function appendSummary(profile: LearnerProfile, event: LearningEvent): boolean {
	const conceptIds = event.context.concept_ids ?? [];
	const label =
		typeof event.payload.topic === "string"
			? event.payload.topic
			: typeof event.payload.concept === "string"
				? event.payload.concept
				: typeof event.payload.goal === "string"
					? event.payload.goal
					: typeof event.payload.goal_description === "string"
						? event.payload.goal_description
						: conceptIds[0];

	if (!label) return false;

	const sentence = `最近记录：${label}（${event.event_type}，${event.timestamp.slice(0, 10)}）。`;
	if (profile.profile_summary.includes(sentence)) return false;

	const base = profile.profile_summary.trim();
	profile.profile_summary = base ? `${base}\n${sentence}` : sentence;
	const lines = profile.profile_summary.split("\n").filter(Boolean);
	profile.profile_summary = lines.slice(Math.max(0, lines.length - 8)).join("\n");
	return true;
}

export interface ApplyLearningEventOptions {
	updateSummary?: boolean;
}

export function learningEventSummarySentence(event: LearningEvent): string | undefined {
	const conceptIds = event.context.concept_ids ?? [];
	const label =
		typeof event.payload.topic === "string"
			? event.payload.topic
			: typeof event.payload.concept === "string"
				? event.payload.concept
				: typeof event.payload.goal === "string"
					? event.payload.goal
					: typeof event.payload.goal_description === "string"
						? event.payload.goal_description
						: conceptIds[0];

	if (!label) return undefined;
	return `最近记录：${label}（${event.event_type}，${event.timestamp.slice(0, 10)}）。`;
}

export function applyLearningEventToProfile(
	profile: LearnerProfile,
	event: LearningEvent,
	options: ApplyLearningEventOptions = {},
): boolean {
	let changed = false;
	changed = updateGoalFromEvent(profile, event) || changed;
	changed = updateKnowledgeFromEvent(profile, event) || changed;
	changed = updatePreferencesFromEvent(profile, event) || changed;
	if (options.updateSummary ?? true) {
		changed = appendSummary(profile, event) || changed;
	}
	return changed;
}
