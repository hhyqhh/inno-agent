import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateCognitivePatternsFromLinks } from "./cognitive-patterns.js";
import { loadProfile } from "./profile-store.js";
import type { PersonalLink } from "./personal-links.js";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "inno-cognitive-patterns-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

function reviewedLink(verdict: "supported" | "needs_bridge" | "explore"): PersonalLink {
	return {
		id: `plink_${verdict}`,
		source: "wiki/concepts/a.md",
		target: "wiki/concepts/b.md",
		reason: "一个学习者自己的理由。",
		status: "proposed",
		feedback: {
			verdict,
			concept_clarification: "概念澄清。",
			misconception_check: "无。",
			summary: "反馈。",
			evidence: "依据。",
			bridge_node_ids: [],
			recommended_action: "keep",
			recommended_node_ids: [],
			recommendation: "保留。",
			generated_by: "rules",
			reviewed_at: new Date().toISOString(),
		},
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

describe("cognitive patterns from personal links", () => {
	it("stores an abstract teaching implication rather than raw node pairs", () => {
		updateCognitivePatternsFromLinks(dataDir, [reviewedLink("needs_bridge"), reviewedLink("explore")]);
		const profile = loadProfile(dataDir);
		expect(profile.cognitive_patterns.map((pattern) => pattern.pattern_id)).toEqual([
			"whole_to_bridge_reasoning",
			"cross_concept_exploration",
		]);
		expect(JSON.stringify(profile.cognitive_patterns)).not.toContain("wiki/concepts/a.md");
	});
});
