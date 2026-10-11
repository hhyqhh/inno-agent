import { join } from "node:path";
import { readJson, writeJson, appendJsonl, readJsonl, readJsonlTail } from "../../storage/file-store.js";
import { type LearnerProfile, type LearningEvent, createDefaultProfile } from "./types.js";
import { applyLearningEventToProfile } from "./auto-profile.js";

const PROFILE_FILE = "profile.json";
const EVENTS_FILE = "events.jsonl";

/** events.jsonl is rolled to a timestamped archive once it exceeds this size. */
const EVENTS_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Tail window for `loadRecentEvents`. Events are small JSON records, so this
 * holds far more than the handful a context pack needs — while never
 * re-reading the whole (up to EVENTS_MAX_BYTES) log.
 */
const EVENTS_TAIL_BYTES = 256 * 1024;

/**
 * Load the learner profile. Returns a default empty profile if not found.
 */
export function loadProfile(dataDir: string): LearnerProfile {
	const defaults = createDefaultProfile();
	const loaded = readJson<LearnerProfile>(join(dataDir, PROFILE_FILE), defaults);
	// Profiles created before cognitive_patterns existed remain valid L1 data.
	return {
		...defaults,
		...loaded,
		preferences: { ...defaults.preferences, ...loaded.preferences },
		cognitive_patterns: Array.isArray(loaded.cognitive_patterns) ? loaded.cognitive_patterns : [],
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
 * Record a learning event by appending to events.jsonl. The log is rotated at
 * EVENTS_MAX_BYTES; `loadEvents` (and therefore `rebuildProfileFromEvents`)
 * only replays the current segment — older segments stay on disk as archives.
 */
export function recordEvent(dataDir: string, event: LearningEvent): boolean {
	if (event.dedupe_key) {
		const existing = readJsonl<LearningEvent>(join(dataDir, EVENTS_FILE));
		if (existing.some((item) => item.dedupe_key === event.dedupe_key)) return false;
	}
	appendJsonl(join(dataDir, EVENTS_FILE), event, { maxBytes: EVENTS_MAX_BYTES });
	return true;
}

/**
 * Record a learning event and immediately fold deterministic signals into the
 * learner profile. This makes L1 useful even when the model only remembers to
 * record an event and skips a separate profile update call.
 */
export function recordEventAndUpdateProfile(dataDir: string, event: LearningEvent): LearnerProfile {
	const recorded = recordEvent(dataDir, event);
	const profile = loadProfile(dataDir);
	if (!recorded) return profile;
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
		&& profile.cognitive_patterns.length === 0
		&& profile.preferences.explanation_style.length === 0
		&& profile.preferences.practice_style.length === 0;
}

/**
 * Load all recorded learning events. Full replay — used by
 * `rebuildProfileFromEvents`. Per-turn callers should use `loadRecentEvents`.
 */
export function loadEvents(dataDir: string): LearningEvent[] {
	return readJsonl<LearningEvent>(join(dataDir, EVENTS_FILE));
}

/**
 * Load only the most recent learning events, read from the tail of
 * events.jsonl. The per-turn context pack needs just the last few events, so
 * it must not re-read and re-parse the whole (rotated, up to EVENTS_MAX_BYTES)
 * log on every turn.
 */
export function loadRecentEvents(dataDir: string, count: number, tailBytes: number = EVENTS_TAIL_BYTES): LearningEvent[] {
	return readJsonlTail<LearningEvent>(join(dataDir, EVENTS_FILE), tailBytes).slice(-count);
}
