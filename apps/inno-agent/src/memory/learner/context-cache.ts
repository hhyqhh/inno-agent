import { join } from "node:path";
import { writeJson } from "../../storage/file-store.js";
import { buildContextPack } from "./context-pack.js";
import type { LearnerProfile, LearningEvent } from "./types.js";

export function refreshContextCache(
	dataDir: string,
	profile: LearnerProfile,
	recentEvents: LearningEvent[] = [],
): void {
	const pack = buildContextPack(profile, recentEvents);
	writeJson(join(dataDir, "context-cache.json"), pack);
}
