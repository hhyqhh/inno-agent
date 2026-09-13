import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledJob } from "../types/jobs.js";

const mocks = vi.hoisted(() => ({
	listJobs: vi.fn(),
	createJob: vi.fn(),
	updateJob: vi.fn(),
	deleteJob: vi.fn(),
	streamJobRun: vi.fn(),
}));

vi.mock("../api/jobs.js", () => ({
	listJobs: mocks.listJobs,
	createJob: mocks.createJob,
	updateJob: mocks.updateJob,
	deleteJob: mocks.deleteJob,
	streamJobRun: mocks.streamJobRun,
}));

import { jobsStore } from "./jobs-store.js";

function job(id: string): ScheduledJob {
	return {
		id,
		name: `Job ${id}`,
		cron: "0 9 * * *",
		timezone: "Asia/Shanghai",
		prompt: "prompt",
		taskType: "custom_prompt",
		enabled: true,
		createdAt: "2026-09-10T00:00:00.000Z",
		updatedAt: "2026-09-10T00:00:00.000Z",
	};
}

describe("jobsStore", () => {
	beforeEach(() => {
		jobsStore.jobs = [job("a"), job("b"), job("c")];
		mocks.deleteJob.mockReset().mockResolvedValue(undefined);
	});

	it("remove drops the deleted job and keeps the rest", async () => {
		await jobsStore.remove("b");
		expect(jobsStore.jobs.map((j) => j.id)).toEqual(["a", "c"]);
	});
});
