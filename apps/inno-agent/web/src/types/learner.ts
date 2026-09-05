export interface LearnerProfile {
	learner_id: string;
	version: number;
	updated_at: string;
	goals: LearningGoal[];
	knowledge_states: KnowledgeState[];
	misconceptions: Misconception[];
	preferences: LearnerPreferences;
	profile_summary: string;
}

export type GoalType = "skill" | "concept" | "project" | "exam" | "habit";
export type GoalStatus = "active" | "paused" | "completed" | "archived";

export interface LearningGoal {
	goal_id: string;
	title: string;
	type: GoalType;
	priority: number;
	status: GoalStatus;
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

export type MisconceptionStatus = "active" | "repairing" | "resolved" | "stale";

export interface Misconception {
	misconception_id: string;
	concept_id: string;
	description: string;
	status: MisconceptionStatus;
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

export type PersonalLinkStatus = "proposed" | "accepted" | "rejected";
export type PersonalLinkAlignment = "aligned" | "system_indirect" | "learner_only";
export type PersonalLinkVerdict = "supported" | "needs_bridge" | "explore";
export type PersonalLinkRecommendedAction = "keep" | "add_bridge" | "replace" | "remove";

export interface PersonalLinkFeedback {
	verdict: PersonalLinkVerdict;
	concept_clarification: string;
	misconception_check: string;
	summary: string;
	evidence: string;
	bridge_node_ids: string[];
	recommended_action: PersonalLinkRecommendedAction;
	recommended_node_ids: string[];
	recommendation: string;
	generated_by: "rules" | "model";
	reviewed_at: string;
}

export interface PersonalLink {
	id: string;
	source: string;
	target: string;
	reason: string;
	status: PersonalLinkStatus;
	feedback?: PersonalLinkFeedback;
	created_at: string;
	updated_at: string;
	comparison: {
		alignment: PersonalLinkAlignment;
		intermediates: string[];
	};
}

export interface PersonalLinksResponse {
	links: PersonalLink[];
}

export interface PersonalLinksBatchReviewResponse {
	links: PersonalLink[];
	patterns: CognitivePattern[];
	chat_feedback: string;
	chat_feedback_persisted: boolean;
}

export interface CognitivePattern {
	pattern_id: string;
	label: string;
	description: string;
	teaching_implication: string;
	confidence: number;
	evidence_count: number;
	updated_at: string;
}
