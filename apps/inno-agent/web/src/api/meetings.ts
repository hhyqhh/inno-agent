export function createMeetingSocket(): WebSocket {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocket(`${protocol}//${window.location.host}/api/meetings/ws`);
}

export interface ActiveMeeting {
	id: string;
	title: string;
	rawPath: string;
	state: string;
	startedAt: number;
	updatedAt: number;
	audioPath?: string;
	error?: string;
}

export type PersistedMeeting = ActiveMeeting;

export interface MeetingImportJob {
	id: string;
	meetingId: string;
	fileName: string;
	status: "queued" | "converting" | "transcribing" | "summarizing" | "completed" | "failed";
	progress: number;
	error?: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

export async function importMeetingAudio(file: File): Promise<{ jobId: string; meetingId: string; rawPath: string }> {
	const response = await fetch("/api/meetings/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fileName: file.name, mimeType: file.type, dataBase64: arrayBufferToBase64(await file.arrayBuffer()) }),
	});
	if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "Failed to import audio");
	return response.json() as Promise<{ jobId: string; meetingId: string; rawPath: string }>;
}

export async function getMeetingImportJob(jobId: string): Promise<MeetingImportJob> {
	const response = await fetch(`/api/meetings/import/${encodeURIComponent(jobId)}`);
	if (!response.ok) throw new Error("Failed to load import progress");
	return response.json() as Promise<MeetingImportJob>;
}

export async function retranscribeMeeting(meetingId: string): Promise<{ jobId: string; meetingId: string }> {
	const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/retranscribe`, { method: "POST" });
	if (!response.ok) throw new Error("Failed to start retranscription");
	return response.json() as Promise<{ jobId: string; meetingId: string }>;
}

export async function getActiveMeetings(): Promise<ActiveMeeting[]> {
	const response = await fetch("/api/meetings/active");
	if (!response.ok) throw new Error("Failed to load active meetings");
	const data = await response.json() as { meetings: ActiveMeeting[] };
	return data.meetings;
}

export async function getMeeting(meetingId: string, signal?: AbortSignal): Promise<PersistedMeeting> {
	const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, { signal });
	if (!response.ok) throw new Error("Failed to load meeting");
	return response.json() as Promise<PersistedMeeting>;
}

export async function retryMeetingSummary(meetingId: string): Promise<void> {
	const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/retry-summary`, { method: "POST" });
	if (!response.ok) throw new Error("Failed to retry meeting summary");
}

export function meetingAudioUrl(meetingId: string): string {
	return `/api/meetings/${encodeURIComponent(meetingId)}/audio`;
}
