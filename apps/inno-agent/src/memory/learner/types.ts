import { randomUUID } from "node:crypto";

// ============================================================================
// Learner Profile Types
// ============================================================================

export interface LearnerProfile {
	learner_id: string;
	version: number;
	updated_at: string;
	goals: LearningGoal[];
	knowledge_states: KnowledgeState[];
	misconceptions: Misconception[];
	preferences: LearnerPreferences;
	boundary: LearningBoundary;
	profile_summary: string;
}

export interface LearningGoal {
	goal_id: string;
	title: string;
	type: "skill" | "concept" | "project" | "exam" | "habit";
	priority: number;
	status: "active" | "paused" | "completed" | "archived";
	success_criteria: string[];
	source: "user_declared" | "agent_inferred" | "imported";
	updated_at: string;
}

export interface KnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	mastery: number;
	confidence: number;
	stability: number;
	last_practiced_at?: string;
	review_due_at?: string;
	evidence_ids: string[];
	diagnosis: string;
	next_actions: string[];
}

export interface Misconception {
	misconception_id: string;
	concept_id: string;
	description: string;
	status: "active" | "repairing" | "resolved" | "stale";
	severity: number;
	confidence: number;
	first_seen_at: string;
	last_seen_at: string;
	evidence_ids: string[];
	repair_strategy: string;
}

export interface LearnerPreferences {
	explanation_style: string[];
	practice_style: string[];
	feedback_tone: string[];
	avoid: string[];
}

/**
 * 学习边界 (Learning Boundary) — 长期限定 AI 的讲解范围、术语与方法。
 * 与 preferences（控制“怎么讲”）正交：boundary 控制“能讲到哪里、用什么方法”。
 */
export interface LearningBoundary {
	/** 当前阶段，如“高中二年级”，用于确定解释深度 */
	stage: string;
	/** 主要课程，如 ["数学", "物理"]，限定学科范围 */
	subjects: string[];
	/** 知识范围，如“人教A版必修一至选择性必修二”，防止调用未学内容 */
	knowledge_scope: string;
	/** 默认难度，用于控制题目与讲解层级：school_exam / foundation / advanced / competition */
	default_difficulty: string;
	/** 超纲内容策略：prompt_first / allowed / forbidden */
	beyond_scope_strategy: string;
	/** 解题方法约束：textbook_first / textbook_only / unrestricted */
	method_constraint: string;
	/** 符号规范，如“采用课本常用符号” */
	notation_standard: string;
	/** 参考资料，作为默认知识依据，如“高中数学人教A版” */
	reference_materials: string;
	/** 开关：使用超纲知识前先提醒 */
	warn_before_beyond_scope: boolean;
	/** 开关：解题时标注使用的知识范围 */
	annotate_knowledge_scope: boolean;
}

// ============================================================================
// Learning Event Types
// ============================================================================

export type LearningEventType =
	| "goal_declared"
	| "exercise_attempt"
	| "concept_explained"
	| "self_assessed"
	| "preference_stated"
	| "feedback_received"
	| "milestone_reached";

export interface LearningEvent {
	event_id: string;
	learner_id: string;
	timestamp: string;
	event_type: LearningEventType;
	context: {
		goal_id?: string;
		concept_ids?: string[];
		session_id?: string;
	};
	payload: Record<string, unknown>;
	derived_signals?: {
		mastery_delta?: number;
		misconception_candidates?: string[];
		affect?: string;
		preference_candidates?: string[];
	};
}

// ============================================================================
// Context Pack (injected into system prompt)
// ============================================================================

export interface LearnerContextPack {
	active_goal?: string;
	relevant_concepts: {
		concept_id: string;
		mastery: number;
		diagnosis: string;
	}[];
	active_misconceptions: string[];
	teaching_hints: string[];
	boundary?: LearningBoundary;
	recent_events?: {
		event_id: string;
		event_type: LearningEventType;
		timestamp: string;
		summary: string;
	}[];
	review_due_concepts?: {
		concept_id: string;
		review_due_at: string;
		mastery: number;
	}[];
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createDefaultProfile(learnerId?: string): LearnerProfile {
	return {
		learner_id: learnerId ?? "default",
		version: 0,
		updated_at: new Date().toISOString(),
		goals: [],
		knowledge_states: [],
		misconceptions: [],
		preferences: {
			explanation_style: [],
			practice_style: [],
			feedback_tone: [],
			avoid: [],
		},
		boundary: {
			stage: "",
			subjects: [],
			knowledge_scope: "",
			default_difficulty: "",
			beyond_scope_strategy: "",
			method_constraint: "",
			notation_standard: "",
			reference_materials: "",
			warn_before_beyond_scope: true,
			annotate_knowledge_scope: false,
		},
		profile_summary: "",
	};
}

export function createLearningEvent(
	learnerId: string,
	eventType: LearningEventType,
	context: LearningEvent["context"],
	payload: Record<string, unknown>,
	derivedSignals?: LearningEvent["derived_signals"],
): LearningEvent {
	return {
		event_id: `evt_${randomUUID().slice(0, 8)}`,
		learner_id: learnerId,
		timestamp: new Date().toISOString(),
		event_type: eventType,
		context,
		payload,
		derived_signals: derivedSignals,
	};
}
