import { apiGet } from "./client";

// The learner profile shape is large and mostly read-only display in the new
// UI; keep it loosely typed so the frontend doesn't drift on backend changes.
export interface LearnerProfile {
  name?: string;
  avatar?: string;
  _rev?: string;
  [key: string]: unknown;
}

export function getLearnerProfile(): Promise<LearnerProfile> {
  return apiGet<LearnerProfile>("/learner/profile");
}
