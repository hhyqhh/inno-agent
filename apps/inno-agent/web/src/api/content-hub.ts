import { apiFetch } from "./client.js";
import type { ContentHubStatus } from "../types/content-hub.js";

/** Cheap status check used by the background catalog update detector. */
export async function getContentHubStatus(): Promise<ContentHubStatus> {
	return apiFetch<ContentHubStatus>("/api/content-hub/status");
}
