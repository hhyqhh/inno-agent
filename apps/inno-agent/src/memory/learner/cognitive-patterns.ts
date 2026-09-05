import { loadProfile, saveProfile } from "./profile-store.js";
import type { PersonalLink, PersonalLinkVerdict } from "./personal-links.js";
import type { CognitivePattern } from "./types.js";

interface PatternDefinition {
	id: string;
	label: string;
	description: string;
	teaching_implication: string;
}

const PATTERNS: Record<PersonalLinkVerdict, PatternDefinition> = {
	supported: {
		id: "explicit_relation_detection",
		label: "能识别已明确的概念关系",
		description: "常能从已学概念中发现系统已表达的关联。",
		teaching_implication: "可以让学习者先预测概念关系，再用原文或例子核对。",
	},
	needs_bridge: {
		id: "whole_to_bridge_reasoning",
		label: "先建立整体关联，再补因果桥梁",
		description: "倾向先看到两端的总体联系，之后需要帮助拆出中间机制。",
		teaching_implication: "先认可整体方向，再用“中间发生了什么”追问，把推理拆成两三步。",
	},
	explore: {
		id: "cross_concept_exploration",
		label: "跨概念主动联想",
		description: "愿意把系统尚未直接相连的概念放在一起探索。",
		teaching_implication: "保留跨概念联想，再邀请学习者提出证据或候选桥梁，而不是立即判错。",
	},
};

/**
 * Fold a completed connection round into L1 as aggregate learning style.
 * Raw node pairs and reasons remain in the private personal-links record and
 * deliberately never enter the per-turn learner prompt.
 */
export function updateCognitivePatternsFromLinks(dataDir: string, links: PersonalLink[]): CognitivePattern[] {
	const profile = loadProfile(dataDir);
	const counts = new Map<PersonalLinkVerdict, number>();
	for (const link of links) {
		const verdict = link.feedback?.verdict;
		if (verdict) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
	}
	const now = new Date().toISOString();
	for (const [verdict, count] of counts) {
		const definition = PATTERNS[verdict];
		const index = profile.cognitive_patterns.findIndex((pattern) => pattern.pattern_id === definition.id);
		if (index === -1) {
			profile.cognitive_patterns.push({
				pattern_id: definition.id,
				label: definition.label,
				description: definition.description,
				teaching_implication: definition.teaching_implication,
				confidence: Math.min(0.65, 0.3 + count * 0.12),
				evidence_count: count,
				updated_at: now,
			});
			continue;
		}
		const current = profile.cognitive_patterns[index]!;
		profile.cognitive_patterns[index] = {
			...current,
			confidence: Math.min(0.9, current.confidence + count * 0.07),
			evidence_count: current.evidence_count + count,
			updated_at: now,
		};
	}
	saveProfile(dataDir, profile);
	return profile.cognitive_patterns;
}
