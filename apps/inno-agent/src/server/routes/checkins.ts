import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { CheckInStore } from "../../checkins/check-in-store.js";
import { cancelDeferredRun, listDeferredRuns } from "../../scheduler/deferred-runs.js";
import { json, readBody } from "../http-helpers.js";

export interface CheckInsRouteContext {
	checkInStore: CheckInStore;
}

/** /api/checkins* route domain for the personal learning check-in MVP. */
export async function handleCheckInsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: CheckInsRouteContext,
): Promise<boolean> {
	// Read-only by design: check-in state is derived server-side from job runs;
	// clients cannot create or forge a check-in.
	if (method === "GET" && (url === "/api/checkins" || url === "/api/checkins/today")) {
		json(res, 200, ctx.checkInStore.status());
		return true;
	}

	// Fired-but-not-yet-started interactive slots, for the in-app banner.
	// Slots that already settled today are filtered out — no reminder for a
	// completed task even if a stale deferred entry is still armed.
	if (method === "GET" && url === "/api/checkins/pending-runs") {
		const runs = listDeferredRuns().filter((run) => {
			if (!ctx.checkInStore) return true;
			const occurrence = ctx.checkInStore.getOccurrence(run.jobId, run.occurrenceId);
			return !occurrence || (occurrence.status !== "success" && occurrence.status !== "skipped");
		});
		json(res, 200, runs);
		return true;
	}

	// 「立即执行」/ countdown takeover: the client cancels the deferred timer
	// and runs the slot itself in a fresh conversation (visible streaming).
	if (method === "POST" && url === "/api/checkins/claim") {
		const body = await readBody(req) as Record<string, unknown>;
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		if (!occurrenceId) {
			json(res, 400, { error: "occurrenceId is required" });
			return true;
		}
		const cancelled = cancelDeferredRun(occurrenceId);
		if (!cancelled) {
			json(res, 409, { error: "This slot is no longer pending." });
			return true;
		}
		json(res, 200, { claimed: true });
		return true;
	}

	// 「不执行」: cancel the pending auto-execution and mark the slot skipped.
	if (method === "POST" && url === "/api/checkins/skip") {
		const body = await readBody(req) as Record<string, unknown>;
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		if (!occurrenceId) {
			json(res, 400, { error: "occurrenceId is required" });
			return true;
		}
		const cancelled = cancelDeferredRun(occurrenceId);
		if (!cancelled) {
			json(res, 409, { error: "This slot is no longer pending." });
			return true;
		}
		ctx.checkInStore.releaseOccurrenceClaim(occurrenceId);
		ctx.checkInStore.recordOccurrence({
			occurrenceId,
			jobId: cancelled.jobId,
			scheduledAt: cancelled.scheduledAt,
			status: "skipped",
			runId: `skip_${randomUUID().slice(0, 8)}`,
			finishedAt: new Date().toISOString(),
		});
		json(res, 200, { skipped: true });
		return true;
	}

	return false;
}
