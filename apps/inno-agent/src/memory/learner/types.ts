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
	/** Abstract, revisable observations about how the learner organizes ideas. */
	cognitive_patterns: CognitivePattern[];
	profile_summary: string;
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
	/**
	 * Heuristic score in [0,1] accumulated from fixed per-event increments
	 * (see MASTERY_DELTAS in auto-profile.ts). NOT a calibrated probability —
	 * use for relative ordering (what to review first), not absolute claims.
	 */
	mastery: number;
	/** Heuristic: how much evidence backs the mastery score. Not statistical confidence. */
	confidence: number;
	/** Heuristic: resistance to decay. Grows with positive deltas; no real forgetting model. */
	stability: number;
	estimate_confidence?: number;
	stability_days?: number;
	retrievability?: number;
	state_label?: KnowledgeStateLabel;
	last_evidence_at?: string;
	last_successful_retrieval_at?: string;
	last_result?: EvidenceResult;
	exposure_count?: number;
	retrieval_count?: number;
	lapse_count?: number;
	successful_transfer_count?: number;
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

// ============================================================================
// Learning Event Types
// ============================================================================

export type LearningEventType =
	| "goal_declared"
	| "exercise_attempt"
	| "concept_explained"
	| "learning_evidence"
	| "self_assessed"
	| "preference_stated"
	| "feedback_received"
	| "milestone_reached";

export type EvidenceKind =
	| "exposure"
	| "recognition"
	| "guided_recall"
	| "free_recall"
	| "application"
	| "transfer"
	| "self_report"
	| "manual_override";

export type EvidenceResult = "correct" | "partial" | "incorrect" | "unknown";

export type EvidenceEvaluator = "deterministic" | "rubric" | "model" | "teacher" | "self";

export interface LearningEvidence {
	evidence_id: string;
	event_id: string;
	learner_id: string;
	concept_id: string;
	occurred_at: string;
	kind: EvidenceKind;
	result: EvidenceResult;
	score?: number;
	hint_level: 0 | 1 | 2 | 3;
	delay_seconds?: number;
	transfer_distance?: number;
	learner_confidence?: number;
	evaluator: EvidenceEvaluator;
	evaluator_confidence: number;
	session_id?: string;
	/** Explicitly links a repair check to one known misconception. */
	misconception_id?: string;
	metadata?: Record<string, unknown>;
}

export type KnowledgeStateLabel =
	| "unknown"
	| "learning"
	| "fragile"
	| "review_due"
	| "stable"
	| "misconception";

export interface DerivedKnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	mastery: number;
	estimate_confidence: number;
	stability_days: number;
	retrievability?: number;
	last_evidence_at?: string;
	last_successful_retrieval_at?: string;
	last_result?: EvidenceResult;
	next_review_at?: string;
	exposure_count: number;
	retrieval_count: number;
	lapse_count: number;
	successful_transfer_count: number;
	active_misconception_ids: string[];
	evidence_ids: string[];
	state_label: KnowledgeStateLabel;
	diagnosis: string;
	next_actions: string[];
}

export interface LearningEvent {
	schema_version?: 1 | 2;
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
	dedupe_key?: string;
	evidence?: LearningEvidence;
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
		estimate_confidence?: number;
		retrievability?: number;
		state_label?: KnowledgeStateLabel;
		recommended_action?: string;
	}[];
	active_misconceptions: string[];
	teaching_hints: string[];
	cognitive_patterns?: Pick<CognitivePattern, "label" | "teaching_implication">[];
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
		cognitive_patterns: [],
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
