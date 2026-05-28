import { applyLearningEventToProfile, learningEventSummarySentence } from "./auto-profile.js";
import { loadEvents, loadProfile, saveProfile } from "./profile-store.js";
import { refreshContextCache } from "./context-cache.js";

/**
 * Replays recorded events into the current profile. This is useful after
 * upgrading L1 rules so existing events start contributing to context.
 */
export function rebuildProfileFromEvents(dataDir: string): number {
	const profile = loadProfile(dataDir);
	const before = JSON.stringify(profile);
	const events = loadEvents(dataDir);
	let applied = 0;

	for (const event of events) {
		if (applyLearningEventToProfile(profile, event, { updateSummary: false })) {
			applied += 1;
		}
	}

	const summary = events
		.map(learningEventSummarySentence)
		.filter((line): line is string => !!line)
		.slice(-8)
		.join("\n");
	if (profile.profile_summary !== summary) {
		profile.profile_summary = summary;
		applied += 1;
	}

	const after = JSON.stringify(profile);
	if (before !== after) {
		saveProfile(dataDir, profile);
		refreshContextCache(dataDir, profile, events.slice(-8));
	} else {
		refreshContextCache(dataDir, profile, events.slice(-8));
	}

	return before !== after ? applied : 0;
}
