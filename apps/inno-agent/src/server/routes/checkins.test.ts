import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckInStore } from "../../checkins/check-in-store.js";
import { JobStore } from "../../scheduler/job-store.js";
import { handleCheckInsRoutes } from "./checkins.js";

let dir: string;
let jobStore: JobStore;
let checkInStore: CheckInStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-checkins-route-"));
	jobStore = new JobStore(join(dir, "jobs"), "Asia/Shanghai");
	checkInStore = new CheckInStore(join(dir, "data"), "Asia/Shanghai", jobStore);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakeReq(body: unknown): HttpReq {
	const req = Readable.from([JSON.stringify(body)]) as HttpReq;
	req.headers = {};
	return req;
}

function fakeRes(): ServerResponse & { statusCode: number; payload: unknown } {
	const res = {
		statusCode: 0,
		payload: undefined as unknown,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(body?: string) {
			res.payload = body ? JSON.parse(body) : undefined;
			return res;
		},
	};
	return res as unknown as ServerResponse & { statusCode: number; payload: unknown };
}

/** Create an enabled daily learning job and return today's planned slot. */
function plannedOccurrence() {
	const job = jobStore.create({
		name: "daily review",
		cron: "0 9 * * *",
		timezone: "Asia/Shanghai",
		enabled: true,
		taskType: "daily_review",
		prompt: "review my notes",
	});
	const occurrence = checkInStore.getTodayPlan().jobs
		.find((candidate) => candidate.jobId === job.id)?.occurrences[0];
	if (!occurrence) throw new Error("expected a planned occurrence for today");
	return { job, occurrence };
}

function skipOccurrence(occurrenceId: string) {
	checkInStore.recordOccurrence({
		occurrenceId,
		jobId: "job",
		scheduledAt: new Date().toISOString(),
		status: "skipped",
		runId: "skip_test",
		finishedAt: new Date().toISOString(),
	});
}

describe("check-ins skip/claim idempotency", () => {
	it("treats a repeated skip of an already-skipped slot as success", async () => {
		const { occurrence } = plannedOccurrence();
		skipOccurrence(occurrence.occurrenceId);
		// No deferred run is registered, so the cancel misses and the route
		// falls back to the persisted slot state.

		const res = fakeRes();
		const handled = await handleCheckInsRoutes(
			fakeReq({ occurrenceId: occurrence.occurrenceId }), res,
			"POST", "/api/checkins/skip", { checkInStore },
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual({ skipped: true, alreadySkipped: true });
	});

	it("returns 409 for a repeated skip of a slot that is still pending", async () => {
		const { occurrence } = plannedOccurrence();

		const res = fakeRes();
		await handleCheckInsRoutes(
			fakeReq({ occurrenceId: occurrence.occurrenceId }), res,
			"POST", "/api/checkins/skip", { checkInStore },
		);

		expect(res.statusCode).toBe(409);
	});

	it("returns 409 for an unknown slot", async () => {
		const res = fakeRes();
		await handleCheckInsRoutes(
			fakeReq({ occurrenceId: "nope" }), res,
			"POST", "/api/checkins/skip", { checkInStore },
		);

		expect(res.statusCode).toBe(409);
	});

	it("lets a late claim of an already-skipped slot stand down quietly", async () => {
		const { occurrence } = plannedOccurrence();
		skipOccurrence(occurrence.occurrenceId);

		const res = fakeRes();
		await handleCheckInsRoutes(
			fakeReq({ occurrenceId: occurrence.occurrenceId }), res,
			"POST", "/api/checkins/claim", { checkInStore },
		);

		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual({ skipped: true, alreadySkipped: true });
	});
});
