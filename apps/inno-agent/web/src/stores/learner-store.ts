import { EventEmitter } from "./event-emitter.js";
import {
	getLearnerProfile,
	patchLearnerProfile,
	createGoal as apiCreateGoal,
	updateGoal as apiUpdateGoal,
	deleteGoal as apiDeleteGoal,
	updateKnowledge as apiUpdateKnowledge,
	updateMisconception as apiUpdateMisconception,
} from "../api/learner.js";
import type {
	LearnerProfile,
	LearningGoal,
	KnowledgeState,
	Misconception,
	LearnerPreferences,
} from "../types/learner.js";

interface LearnerStoreEvents {
	change: void;
}

class LearnerStoreImpl extends EventEmitter<LearnerStoreEvents> {
	profile: LearnerProfile | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.profile = await getLearnerProfile();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async patchSummary(summary: string): Promise<void> {
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			this.profile = await patchLearnerProfile({ profile_summary: summary });
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async patchPreferences(prefs: LearnerPreferences): Promise<void> {
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			this.profile = await patchLearnerProfile({ preferences: prefs });
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async addGoal(input: Partial<LearningGoal>): Promise<LearningGoal> {
		const goal = await apiCreateGoal(input);
		if (this.profile) {
			this.profile = { ...this.profile, goals: [goal, ...this.profile.goals] };
			this.emit("change", undefined);
		}
		return goal;
	}

	async patchGoal(goalId: string, patch: Partial<LearningGoal>): Promise<void> {
		const updated = await apiUpdateGoal(goalId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				goals: this.profile.goals.map((g) => (g.goal_id === goalId ? updated : g)),
			};
			this.emit("change", undefined);
		}
	}

	async deleteGoal(goalId: string): Promise<void> {
		await apiDeleteGoal(goalId);
		if (this.profile) {
			this.profile = {
				...this.profile,
				goals: this.profile.goals.filter((g) => g.goal_id !== goalId),
			};
			this.emit("change", undefined);
		}
	}

	async patchKnowledge(conceptId: string, patch: Partial<KnowledgeState>): Promise<void> {
		const updated = await apiUpdateKnowledge(conceptId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				knowledge_states: this.profile.knowledge_states.map((k) =>
					k.concept_id === conceptId ? updated : k,
				),
			};
			this.emit("change", undefined);
		}
	}

	async patchMisconception(miscId: string, patch: Partial<Misconception>): Promise<void> {
		const updated = await apiUpdateMisconception(miscId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				misconceptions: this.profile.misconceptions.map((m) =>
					m.misconception_id === miscId ? updated : m,
				),
			};
			this.emit("change", undefined);
		}
	}
}

export const learnerStore = new LearnerStoreImpl();
