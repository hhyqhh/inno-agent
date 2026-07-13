import { join } from "node:path";
import { readJson, writeJson, appendJsonl, readJsonl } from "../../storage/file-store.js";
import { type LearnerProfile, type LearningEvent, createDefaultProfile } from "./types.js";
import { applyLearningEventToProfile } from "./auto-profile.js";

const PROFILE_FILE = "profile.json";
const EVENTS_FILE = "events.jsonl";

/**
 * Load the learner profile. Returns a default empty profile if not found.
 * Backfills any top-level fields missing from an older on-disk profile so that
 * newly added structures (e.g. boundary) always have valid defaults.
 */
export function loadProfile(dataDir: string): LearnerProfile {
	const defaults = createDefaultProfile();
	const loaded = readJson<Partial<LearnerProfile>>(join(dataDir, PROFILE_FILE), defaults);
	return {
		...defaults,
		...loaded,
		preferences: { ...defaults.preferences, ...(loaded.preferences ?? {}) },
		boundary: { ...defaults.boundary, ...(loaded.boundary ?? {}) },
	};
}

/**
 * Save the learner profile (increments version, updates timestamp).
 */
export function saveProfile(dataDir: string, profile: LearnerProfile): void {
	profile.version += 1;
	profile.updated_at = new Date().toISOString();
	writeJson(join(dataDir, PROFILE_FILE), profile);
}

/**
 * Record a learning event by appending to events.jsonl.
 */
export function recordEvent(dataDir: string, event: LearningEvent): void {
	appendJsonl(join(dataDir, EVENTS_FILE), event);
}

/**
 * Record a learning event and immediately fold deterministic signals into the
 * learner profile. This makes L1 useful even when the model only remembers to
 * record an event and skips a separate profile update call.
 */
export function recordEventAndUpdateProfile(dataDir: string, event: LearningEvent): LearnerProfile {
	recordEvent(dataDir, event);
	const profile = loadProfile(dataDir);
	if (applyLearningEventToProfile(profile, event)) {
		saveProfile(dataDir, profile);
	}
	return profile;
}

/**
 * Check whether the learner profile is effectively empty (new user).
 * Returns true when no goals, knowledge states, summary, or preferences
 * have been recorded — indicating a first-time user who needs onboarding.
 */
export function isProfileEmpty(profile: LearnerProfile): boolean {
	return profile.goals.length === 0
		&& profile.knowledge_states.length === 0
		&& profile.profile_summary === ""
		&& profile.preferences.explanation_style.length === 0
		&& profile.preferences.practice_style.length === 0;
}

/**
 * Load all recorded learning events.
 */
export function loadEvents(dataDir: string): LearningEvent[] {
	return readJsonl<LearningEvent>(join(dataDir, EVENTS_FILE));
}
