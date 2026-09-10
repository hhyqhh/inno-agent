import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChannelRegistry } from "../../channels/channel.js";
import type { JobStore } from "../../scheduler/job-store.js";
import type { ScheduledJob } from "../../scheduler/types.js";
import { executeJob, type JobRunResult } from "../../scheduler/job-runner.js";
import { validateCron } from "../../scheduler/cron-utils.js";
import { json, matchRoute, readBody } from "../http-helpers.js";
import { isLearningJob, type CheckInStore } from "../../checkins/check-in-store.js";
import { logger } from "../../logger.js";
import { questionBridge } from "../../agent/question-bridge.js";
import { cancelDeferredRun, isDeferredExecuting } from "../../scheduler/deferred-runs.js";

type JobRunStreamEvent =
	| { type: "job_state"; status: "queued" | "running" }
	| { type: "text_start"; contentIndex?: number }
	| { type: "text_delta"; delta: string; contentIndex?: number }
	| { type: "text_end"; contentIndex?: number }
	| { type: "thinking_start"; contentIndex?: number }
	| { type: "thinking_delta"; delta: string; contentIndex?: number }
	| { type: "thinking_end"; contentIndex?: number }
	| { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
	| { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
	| { type: "question"; questionId: string; params: unknown; turnId?: string; toolCallId?: string }
	| { type: "question_resolved"; questionId: string; cancelled?: boolean; error?: string }
	| { type: "job_result"; result: JobRunResult }
	| { type: "error"; message: string };

const MAX_TOOL_PAYLOAD = 8_000;

/** Tool args/results can be huge (file reads, command output); keep the SSE frame small. */
function compactToolPayload(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_TOOL_PAYLOAD ? `${value.slice(0, MAX_TOOL_PAYLOAD)}…[truncated]` : value;
	}
	if (value === undefined || value === null) return undefined;
	try {
		const json = JSON.stringify(value);
		if (typeof json === "string" && json.length > MAX_TOOL_PAYLOAD) {
			return { truncated: true, preview: json.slice(0, MAX_TOOL_PAYLOAD) };
		}
	} catch {
		return String(value).slice(0, MAX_TOOL_PAYLOAD);
	}
	return value;
}

/**
 * Map a raw pi AgentSessionEvent to the job-run SSE vocabulary. Returns null
 * for events the job chat bubble does not render. Exported for tests.
 */
export function jobStreamEventFromAgent(event: unknown): JobRunStreamEvent | null {
	if (!event || typeof event !== "object") return null;
	const record = event as Record<string, unknown>;
	if (typeof record.toolCallId === "string" && record.toolCallId) {
		const toolName = typeof record.toolName === "string" && record.toolName ? record.toolName : "tool";
		if (record.type === "tool_execution_start") {
			const args = compactToolPayload(record.args);
			return { type: "tool_start", toolCallId: record.toolCallId, toolName, ...(args === undefined ? {} : { args }) };
		}
		if (record.type === "tool_execution_update") {
			const args = compactToolPayload(record.args);
			const partialResult = compactToolPayload(record.partialResult);
			return {
				type: "tool_update",
				toolCallId: record.toolCallId,
				toolName,
				...(args === undefined ? {} : { args }),
				...(partialResult === undefined ? {} : { partialResult }),
			};
		}
		if (record.type === "tool_execution_end") {
			const result = compactToolPayload(record.result);
			return {
				type: "tool_end",
				toolCallId: record.toolCallId,
				toolName,
				...(result === undefined ? {} : { result }),
				isError: record.isError === true,
			};
		}
	}
	const assistantMessageEvent = record.assistantMessageEvent as {
		type?: unknown;
		delta?: unknown;
		contentIndex?: unknown;
	} | undefined;
	if (record.type !== "message_update" || !assistantMessageEvent) return null;
	const assistant = assistantMessageEvent;
	const contentIndex = typeof assistant.contentIndex === "number" ? assistant.contentIndex : undefined;
	switch (assistant.type) {
		case "text_start":
			return { type: "text_start", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "text_delta":
			return typeof assistant.delta === "string"
				? { type: "text_delta", delta: assistant.delta, ...(contentIndex === undefined ? {} : { contentIndex }) }
				: null;
		case "text_end":
			return { type: "text_end", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "thinking_start":
			return { type: "thinking_start", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "thinking_delta":
			return typeof assistant.delta === "string"
				? { type: "thinking_delta", delta: assistant.delta, ...(contentIndex === undefined ? {} : { contentIndex }) }
				: null;
		case "thinking_end":
			return { type: "thinking_end", ...(contentIndex === undefined ? {} : { contentIndex }) };
		default:
			return null;
	}
}

function writeJobStreamEvent(res: ServerResponse, event: JobRunStreamEvent): boolean {
	if (res.writableEnded || res.destroyed) return false;
	try {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
		return true;
	} catch {
		return false;
	}
}

export interface JobsRouteContext {
	jobStore: JobStore;
	channelRegistry: ChannelRegistry;
	checkInStore?: CheckInStore;
	resolveSessionPath?: (sessionId: string) => string | null;
	/** Tag the target session as scheduler-born so the sidebar badges it. */
	recordJobRunSession?: (sessionId: string) => void;
	/** Abort the in-flight manual job run streaming into this session. */
	abortJobRun?: (sessionId: string) => Promise<boolean>;
}

/**
 * /api/jobs* route domain. Returns true when the request was handled.
 * Extracted verbatim from server.ts during the P2 route split (blocks were
 * originally at two sites in the giant handler; relative order within the
 * domain is preserved) — behavior unchanged.
 */
export async function handleJobsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: JobsRouteContext,
): Promise<boolean> {
	const { jobStore, channelRegistry } = ctx;

	if (method === "GET" && url === "/api/jobs") {
		json(res, 200, jobStore.list());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/status") {
		json(res, 200, jobStore.getStatus());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/runs") {
		json(res, 200, jobStore.listRuns());
		return true;
	}

	if (method === "POST" && url === "/api/jobs") {
		const body = await readBody(req) as Record<string, unknown> & Parameters<JobStore["create"]>[0];
		if (typeof body.cron !== "string") {
			json(res, 400, { error: "cron is required" });
			return true;
		}
		const cronCheck = validateCron(body.cron, typeof body.timezone === "string" ? body.timezone : undefined);
		if (!cronCheck.ok) {
			json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
			return true;
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		const job = jobStore.create(body);
		json(res, 201, job);
		return true;
	}

	const runsMatch = matchRoute("GET", method, url, "/api/jobs/:id/runs");
	if (runsMatch) {
		json(res, 200, jobStore.listRuns(runsMatch.id));
		return true;
	}

	const stopMatch = matchRoute("POST", method, url, "/api/jobs/run/stop");
	if (stopMatch) {
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (!sessionId) {
			json(res, 400, { error: "sessionId is required" });
			return true;
		}
		const stopped = ctx.abortJobRun ? await ctx.abortJobRun(sessionId) : false;
		if (stopped) logger.info({ sessionId }, "Manual job run stop requested");
		else logger.warn({ sessionId }, "Job stop request not applied: no matching in-flight run");
		json(res, 200, { stopped });
		return true;
	}

	const runStreamMatch = matchRoute("POST", method, url, "/api/jobs/:id/run/stream");
	if (runStreamMatch) {
		const job = jobStore.get(runStreamMatch.id);
		if (!job) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (!sessionId) {
			json(res, 400, { error: "sessionId is required for streaming job runs" });
			return true;
		}
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		if (occurrenceId) {
			// A manual run takes over a fired-but-waiting slot: cancel its
			// deferred auto-execution and reserve the slot so cron re-fires
			// or another start cannot double-run it.
			cancelDeferredRun(occurrenceId);
			if (isDeferredExecuting(occurrenceId)) {
				json(res, 409, { error: "This slot's auto-execution already started." });
				return true;
			}
			if (isLearningJob(job) && ctx.checkInStore) {
				if (!ctx.checkInStore.claimOccurrence(occurrenceId)) {
					json(res, 409, { error: "This slot is already being handled." });
					return true;
				}
				if (!ctx.checkInStore.resolveOccurrence(job.id, occurrenceId)) {
					ctx.checkInStore.releaseOccurrenceClaim(occurrenceId);
					json(res, 409, { error: "Learning schedule slot is no longer pending." });
					return true;
				}
			}
		}
		const sessionPath = ctx.resolveSessionPath?.(sessionId);
		if (!sessionPath) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		ctx.recordJobRunSession?.(sessionId);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		let disconnected = false;
		let responseEnded = false;
		const heartbeat = setInterval(() => {
			if (disconnected || responseEnded) return;
			try {
				res.write(": heartbeat\n\n");
			} catch {
				disconnected = true;
			}
		}, 15_000);
		const finish = () => {
			if (responseEnded) return;
			responseEnded = true;
			clearInterval(heartbeat);
			if (!disconnected && !res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		};
		writeJobStreamEvent(res, { type: "job_state", status: "queued" });
		writeJobStreamEvent(res, { type: "job_state", status: "running" });
		logger.info({ jobId: job.id, sessionId }, "Manual job run stream opened");
		// The run's agent may call ask_user_question; binding the bridge lets the
		// tool park and wait for an answer instead of failing with "no_ui".
		const runTurnId = randomUUID();
		questionBridge.bindTurn({
			sessionId,
			turnId: runTurnId,
			timeoutMs: 30 * 60_000,
			emit: (event) => {
				const forwarded = event.type === "question" ? { ...event, turnId: runTurnId } : event;
				writeJobStreamEvent(res, forwarded as JobRunStreamEvent);
			},
		});
		res.on("close", () => {
			disconnected = true;
			clearInterval(heartbeat);
			// The run itself keeps going server-side; only the live view is lost.
			logger.info({ jobId: job.id, sessionId }, "Manual job run stream disconnected");
			// Nobody can answer a question with the stream gone — release the tool.
			questionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "client_disconnected" });
		});
		try {
			const result = await executeJob(
				job,
				jobStore,
				channelRegistry,
				"api",
				ctx.checkInStore,
				{
					sessionPath,
					occurrenceId: occurrenceId || undefined,
					onEvent: (event) => {
						const normalized = jobStreamEventFromAgent(event);
						if (normalized && !writeJobStreamEvent(res, normalized)) disconnected = true;
					},
				},
			);
			logger.info({ jobId: job.id, sessionId, runId: result.runId, success: result.success }, "Manual job run stream finished");
			// A fulfilled slot keeps its claim; a failed one is released so the
			// check-in card can retry it.
			if (occurrenceId && !result.success) ctx.checkInStore?.releaseOccurrenceClaim(occurrenceId);
			if (!disconnected) writeJobStreamEvent(res, { type: "job_result", result });
		} catch (err) {
			logger.error({ err, jobId: job.id, sessionId }, "Manual job run stream failed");
			if (occurrenceId) ctx.checkInStore?.releaseOccurrenceClaim(occurrenceId);
			if (!disconnected) {
				writeJobStreamEvent(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			questionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "finished" });
			finish();
		}
		return true;
	}

	const runMatch = matchRoute("POST", method, url, "/api/jobs/:id/run");
	if (runMatch) {
		const job = jobStore.get(runMatch.id);
		if (!job) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		const sessionPath = sessionId ? ctx.resolveSessionPath?.(sessionId) : undefined;
		if (sessionId && !sessionPath) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (sessionId) ctx.recordJobRunSession?.(sessionId);
		if (occurrenceId && isLearningJob(job) && ctx.checkInStore) {
			if (!ctx.checkInStore.claimOccurrence(occurrenceId)) {
				json(res, 409, { error: "This slot is already being handled." });
				return true;
			}
			if (!ctx.checkInStore.resolveOccurrence(job.id, occurrenceId)) {
				ctx.checkInStore.releaseOccurrenceClaim(occurrenceId);
				json(res, 409, { error: "Learning schedule slot is no longer pending." });
				return true;
			}
		}
		const result = await executeJob(
			job,
			jobStore,
			channelRegistry,
			"api",
			ctx.checkInStore,
			sessionPath || occurrenceId ? { sessionPath: sessionPath || undefined, occurrenceId: occurrenceId || undefined } : undefined,
		);
		if (occurrenceId && !result.success) ctx.checkInStore?.releaseOccurrenceClaim(occurrenceId);
		json(res, 200, result);
		return true;
	}

	const patchMatch = matchRoute("PATCH", method, url, "/api/jobs/:id");
	if (patchMatch) {
		const body = await readBody(req) as Partial<ScheduledJob>;
		if (typeof body.cron === "string") {
			const cronCheck = validateCron(body.cron, body.timezone);
			if (!cronCheck.ok) {
				json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
				return true;
			}
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		const updated = jobStore.update(patchMatch.id, body);
		if (!updated) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 200, updated);
		return true;
	}

	const deleteMatch = matchRoute("DELETE", method, url, "/api/jobs/:id");
	if (deleteMatch) {
		const deleted = jobStore.delete(deleteMatch.id);
		if (!deleted) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 204, null);
		return true;
	}

	return false;
}
