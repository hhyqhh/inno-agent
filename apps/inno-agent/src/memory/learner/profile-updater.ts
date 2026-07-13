import type {
	LearnerProfile,
	LearningGoal,
	KnowledgeState,
	Misconception,
	LearnerPreferences,
	LearningBoundary,
} from "./types.js";
import { loadEvents, loadProfile, saveProfile } from "./profile-store.js";
import { refreshContextCache } from "./context-cache.js";

/**
 * Describes a partial update to the learner profile.
 * Array fields are merged by ID; simple fields are overwritten.
 */
export interface ProfileUpdate {
	goals?: LearningGoal[];
	knowledge_states?: KnowledgeState[];
	misconceptions?: Misconception[];
	preferences?: Partial<LearnerPreferences>;
	boundary?: Partial<LearningBoundary>;
	profile_summary?: string;
}

export interface ProfilePatch {
	concept_id?: string;
	concept_name?: string;
	domain?: string;
	mastery_delta?: number;
	mastery?: number;
	confidence?: number;
	stability_delta?: number;
	diagnosis?: string;
	next_actions_append?: string[];
	evidence_ids_append?: string[];
	last_practiced_at?: string;
	review_due_at?: string;
	preferences_append?: Partial<LearnerPreferences>;
	profile_summary_append?: string;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

/**
 * Merge an array of items by ID field.
 * Items with matching IDs are replaced; new items are appended.
 */
function mergeById<T>(
	existing: T[],
	incoming: T[],
	idField: keyof T,
): T[] {
	const result = [...existing];
	for (const item of incoming) {
		const idx = result.findIndex((e) => e[idField] === item[idField]);
		if (idx >= 0) {
			result[idx] = item;
		} else {
			result.push(item);
		}
	}
	return result;
}

/**
 * Apply a partial update to the learner profile.
 * - goals: merged by goal_id
 * - knowledge_states: merged by concept_id
 * - misconceptions: merged by misconception_id
 * - preferences: shallow merged
 * - profile_summary: overwritten
 *
 * After updating, saves the profile and refreshes the context cache.
 */
export function updateProfile(dataDir: string, update: ProfileUpdate): LearnerProfile {
	const profile = loadProfile(dataDir);

	if (update.goals) {
		profile.goals = mergeById<LearningGoal>(profile.goals, update.goals, "goal_id");
	}

	if (update.knowledge_states) {
		profile.knowledge_states = mergeById<KnowledgeState>(
			profile.knowledge_states,
			update.knowledge_states,
			"concept_id",
		);
	}

	if (update.misconceptions) {
		profile.misconceptions = mergeById<Misconception>(
			profile.misconceptions,
			update.misconceptions,
			"misconception_id",
		);
	}

	if (update.preferences) {
		profile.preferences = {
			...profile.preferences,
			...update.preferences,
		};
	}

	if (update.boundary) {
		profile.boundary = {
			...profile.boundary,
			...update.boundary,
		};
	}

	if (update.profile_summary !== undefined) {
		profile.profile_summary = update.profile_summary;
	}

	saveProfile(dataDir, profile);

	refreshContextCache(dataDir, profile, loadEvents(dataDir).slice(-8));

	return profile;
}

export function patchProfile(dataDir: string, patch: ProfilePatch): LearnerProfile {
	const profile = loadProfile(dataDir);

	if (patch.concept_id) {
		let state = profile.knowledge_states.find((ks) => ks.concept_id === patch.concept_id);
		if (!state) {
			state = {
				concept_id: patch.concept_id,
				concept_name: patch.concept_name ?? patch.concept_id,
				domain: patch.domain ?? "general",
				mastery: 0.05,
				confidence: 0.35,
				stability: 0.1,
				evidence_ids: [],
				diagnosis: "有学习接触记录，尚未形成稳定掌握度判断。",
				next_actions: [],
			};
			profile.knowledge_states.push(state);
		}

		if (patch.concept_name) state.concept_name = patch.concept_name;
		if (patch.domain) state.domain = patch.domain;
		if (typeof patch.mastery === "number") state.mastery = clamp01(patch.mastery);
		if (typeof patch.mastery_delta === "number") state.mastery = clamp01(state.mastery + patch.mastery_delta);
		if (typeof patch.confidence === "number") state.confidence = clamp01(patch.confidence);
		if (typeof patch.stability_delta === "number") state.stability = clamp01(state.stability + patch.stability_delta);
		if (patch.diagnosis) state.diagnosis = patch.diagnosis;
		if (patch.next_actions_append) {
			state.next_actions = uniqueStrings([...state.next_actions, ...patch.next_actions_append]).slice(0, 8);
		}
		if (patch.evidence_ids_append) {
			state.evidence_ids = uniqueStrings([...state.evidence_ids, ...patch.evidence_ids_append]);
		}
		if (patch.last_practiced_at) state.last_practiced_at = patch.last_practiced_at;
		if (patch.review_due_at) state.review_due_at = patch.review_due_at;
	}

	if (patch.preferences_append) {
		profile.preferences = {
			explanation_style: uniqueStrings([
				...profile.preferences.explanation_style,
				...(patch.preferences_append.explanation_style ?? []),
			]),
			practice_style: uniqueStrings([
				...profile.preferences.practice_style,
				...(patch.preferences_append.practice_style ?? []),
			]),
			feedback_tone: uniqueStrings([
				...profile.preferences.feedback_tone,
				...(patch.preferences_append.feedback_tone ?? []),
			]),
			avoid: uniqueStrings([...profile.preferences.avoid, ...(patch.preferences_append.avoid ?? [])]),
		};
	}

	if (patch.profile_summary_append?.trim()) {
		const lines = [
			...profile.profile_summary.split("\n").filter(Boolean),
			patch.profile_summary_append.trim(),
		];
		profile.profile_summary = lines.slice(Math.max(0, lines.length - 10)).join("\n");
	}

	saveProfile(dataDir, profile);
	refreshContextCache(dataDir, profile, loadEvents(dataDir).slice(-8));
	return profile;
}
