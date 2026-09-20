import { apiFetch } from "./client.js";
import type {
	LearnerProfile,
	LearningGoal,
	KnowledgeState,
	Misconception,
	LearnerPreferences,
	PersonalLink,
	PersonalLinkCreateResponse,
	PersonalLinksResponse,
	PersonalLinkStatus,
} from "../types/learner.js";

export async function getLearnerProfile(): Promise<LearnerProfile> {
	return apiFetch<LearnerProfile>("/api/learner/profile");
}

export async function patchLearnerProfile(patch: { profile_summary?: string; preferences?: LearnerPreferences }): Promise<LearnerProfile> {
	return apiFetch<LearnerProfile>("/api/learner/profile", {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function createGoal(input: Partial<LearningGoal>): Promise<LearningGoal> {
	return apiFetch<LearningGoal>("/api/learner/profile/goals", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updateGoal(goalId: string, patch: Partial<LearningGoal>): Promise<LearningGoal> {
	return apiFetch<LearningGoal>(`/api/learner/profile/goals/${encodeURIComponent(goalId)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/learner/profile/goals/${encodeURIComponent(goalId)}`, { method: "DELETE" });
}

export async function updateKnowledge(conceptId: string, patch: Partial<KnowledgeState>): Promise<KnowledgeState> {
	return apiFetch<KnowledgeState>(`/api/learner/profile/knowledge/${encodeURIComponent(conceptId)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function updateMisconception(miscId: string, patch: Partial<Misconception>): Promise<Misconception> {
	return apiFetch<Misconception>(`/api/learner/profile/misconceptions/${encodeURIComponent(miscId)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function listPersonalLinks(): Promise<PersonalLinksResponse> {
	return apiFetch<PersonalLinksResponse>("/api/learner/personal-links");
}

export async function createPersonalLink(input: { source: string; target: string; reason: string; session_id?: string | null }): Promise<PersonalLinkCreateResponse> {
	return apiFetch<PersonalLinkCreateResponse>("/api/learner/personal-links", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updatePersonalLinkStatus(id: string, status: PersonalLinkStatus): Promise<PersonalLink> {
	return apiFetch<PersonalLink>(`/api/learner/personal-links/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify({ status }),
	});
}

export async function deletePersonalLink(id: string): Promise<void> {
	await apiFetch(`/api/learner/personal-links/${encodeURIComponent(id)}`, { method: "DELETE" });
}
