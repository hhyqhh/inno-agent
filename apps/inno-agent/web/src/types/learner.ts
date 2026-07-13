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

export interface LearningBoundary {
	stage: string;
	subjects: string[];
	knowledge_scope: string;
	default_difficulty: string;
	beyond_scope_strategy: string;
	method_constraint: string;
	notation_standard: string;
	reference_materials: string;
	warn_before_beyond_scope: boolean;
	annotate_knowledge_scope: boolean;
}
