import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { join } from "node:path";

import type { MeetingManager } from "../../meeting/meeting-manager.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

export interface MeetingRouteContext {
	dataDir: string;
	meetingManager: MeetingManager;
}

const SUPPORTED_AUDIO = new Set(["wav", "mp3", "m4a", "webm", "ogg", "mp4", "aac", "flac"]);
const SAFE_MEETING_ID = /^meeting_[A-Za-z0-9_-]+$/;

export async function handleMeetingRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: MeetingRouteContext,
): Promise<boolean> {
	const { meetingManager } = ctx;
	if (method === "GET" && url === "/api/meetings/active") {
		json(res, 200, { meetings: meetingManager.getActiveMeetings() });
		return true;
	}

	if (method === "POST" && url === "/api/meetings/import") {
		const body = await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES }) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
		if (!fileName || !dataBase64 || !SUPPORTED_AUDIO.has(extension)) {
			json(res, 400, { error: "Provide a supported audio file: wav, mp3, m4a, webm, ogg, mp4, aac or flac" });
			return true;
		}
		try {
			const data = Buffer.from(dataBase64, "base64");
			const result = meetingManager.importAudio(fileName, data);
			json(res, 202, { jobId: result.job.id, meetingId: result.meeting.id, rawPath: result.meeting.rawPath });
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to import audio" });
		}
		return true;
	}

	const importJob = matchRoute("GET", method, url, "/api/meetings/import/:jobId");
	if (importJob) {
		const job = meetingManager.getImportJob(importJob.jobId);
		json(res, job ? 200 : 404, job ?? { error: "Import job not found" });
		return true;
	}

	const meetingAction = matchRoute(method, method, url, "/api/meetings/:meetingId/:action");
	if (meetingAction) {
		const { meetingId, action } = meetingAction;
		if (!SAFE_MEETING_ID.test(meetingId)) {
			json(res, 400, { error: "Invalid meeting id" });
			return true;
		}
		if (method === "POST" && action === "stop") {
			const stopped = meetingManager.stopMeeting(meetingId);
			json(res, stopped ? 202 : 404, stopped ? { ok: true } : { error: "Active meeting not found" });
			return true;
		}
		if (method === "POST" && action === "retry-summary") {
			const accepted = await meetingManager.retrySummary(meetingId);
			json(res, accepted ? 202 : 404, accepted ? { ok: true } : { error: "Meeting transcript not found" });
			return true;
		}
		if (method === "POST" && action === "retranscribe") {
			const job = meetingManager.retranscribe(meetingId);
			json(res, job ? 202 : 404, job ? { jobId: job.id, meetingId } : { error: "Meeting audio not found" });
			return true;
		}
		if (method === "GET" && action === "audio") {
			const audioPath = join(ctx.dataDir, "meetings", meetingId, "audio.wav");
			if (!existsSync(audioPath) || !statSync(audioPath).isFile()) {
				json(res, 404, { error: "Audio not found" });
				return true;
			}
			const size = statSync(audioPath).size;
			res.writeHead(200, {
				"Content-Type": "audio/wav",
				"Content-Length": size,
				"Accept-Ranges": "bytes",
				"X-Content-Type-Options": "nosniff",
			});
			createReadStream(audioPath).pipe(res);
			return true;
		}
	}

	const meeting = matchRoute("GET", method, url, "/api/meetings/:meetingId");
	if (meeting) {
		if (!SAFE_MEETING_ID.test(meeting.meetingId)) {
			json(res, 400, { error: "Invalid meeting id" });
			return true;
		}
		const value = meetingManager.getMeeting(meeting.meetingId);
		json(res, value ? 200 : 404, value ?? { error: "Meeting not found" });
		return true;
	}

	return false;
}
