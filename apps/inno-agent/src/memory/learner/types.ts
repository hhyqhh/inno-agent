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
	// SM-2 spaced-repetition state (Wozniak & Gorzelanczyk, 1994)
	sm2_ef?: number;          // easiness factor, default 2.5, min 1.3
	sm2_interval?: number;    // days until next review
	sm2_repetitions?: number; // successful review streak
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
