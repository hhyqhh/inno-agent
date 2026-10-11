import { describe, expect, it } from "vitest";
import { buildContextPack, formatContextPackForPrompt } from "./context-pack.js";
import { createLearningEvidenceEvent } from "./evidence.js";
import { createDefaultProfile } from "./types.js";

describe("learner context pack v2", () => {
	it("injects evidence-derived state and current retrievability", () => {
		const event = createLearningEvidenceEvent("student", {
			concept_id: "physics.force_decomposition",
			kind: "application",
			result: "correct",
			hint_level: 0,
			evaluator: "teacher",
			evaluator_confidence: 1,
		}, new Date("2026-08-01T00:00:00.000Z"));
		const pack = buildContextPack(
			createDefaultProfile("student"),
			[event],
			{ asOf: new Date("2026-08-02T00:00:00.000Z") },
		);

		expect(pack.relevant_concepts[0]).toMatchObject({
			concept_id: "physics.force_decomposition",
			state_label: "fragile",
		});
		expect(pack.relevant_concepts[0].retrievability).toBeTypeOf("number");
		const prompt = formatContextPackForPrompt(pack);
		expect(prompt).toContain("当前可提取概率");
		expect(prompt).toContain("建议：");
	});

	it("keeps legacy fixed review dates during migration", () => {
		const profile = createDefaultProfile("student");
		profile.knowledge_states.push({
			concept_id: "math.fractions",
			concept_name: "分数",
			domain: "math",
			mastery: 0.5,
			confidence: 0.5,
			stability: 0.3,
			review_due_at: "2026-08-01T00:00:00.000Z",
			evidence_ids: [],
			diagnosis: "旧画像",
			next_actions: [],
		});
		const pack = buildContextPack(profile, [], { asOf: new Date("2026-08-02T00:00:00.000Z") });
		expect(pack.review_due_concepts?.[0].concept_id).toBe("math.fractions");
	});

	it("uses abstract cognitive patterns as teaching hints without recording raw connections", () => {
		const profile = createDefaultProfile("student");
		profile.cognitive_patterns.push({
			pattern_id: "whole_to_bridge_reasoning",
			label: "先建立整体关联，再补因果桥梁",
			description: "先看到总体联系。",
			teaching_implication: "先认可整体方向，再追问中间发生了什么。",
			confidence: 0.75,
			evidence_count: 2,
			updated_at: "2026-08-01T00:00:00.000Z",
		});
		const prompt = formatContextPackForPrompt(buildContextPack(profile));
		expect(prompt).toContain("先认可整体方向，再追问中间发生了什么。");
		expect(prompt).not.toContain("节点 A");
	});

	it("injects only high-confidence patterns and caps their count", () => {
		const profile = createDefaultProfile("student");
		for (let index = 0; index < 5; index += 1) {
			profile.cognitive_patterns.push({
				pattern_id: `pattern_${index}`,
				label: `模式 ${index}`,
				description: "抽象学习模式。",
				teaching_implication: `提示 ${index}`,
				confidence: index === 4 ? 0.49 : 0.9 - index * 0.1,
				evidence_count: 2,
				updated_at: "2026-08-01T00:00:00.000Z",
			});
		}

		const pack = buildContextPack(profile);
		expect(pack.cognitive_patterns).toHaveLength(3);
		expect(pack.teaching_hints).toEqual(expect.arrayContaining(["提示 0", "提示 1", "提示 2"]));
		expect(pack.teaching_hints).not.toContain("提示 4");
	});
});
