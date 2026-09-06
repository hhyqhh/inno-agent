import { apiGet } from "./client";
import type { ProjectSkill } from "./types";

export function listSkills(): Promise<ProjectSkill[]> {
  return apiGet<ProjectSkill[]>("/skills");
}

// The skill-library browse/import is part of the content hub; typed loosely.
export function listSkillLibrary(): Promise<unknown[]> {
  return apiGet<unknown[]>("/skill-library");
}
