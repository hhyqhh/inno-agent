import { describe, expect, it } from "vitest";
import { computeNextRunAt, getCronDueAt, getCronOccurrencesForDate, isCronDue, isOneShotCron, validateCron } from "./cron-utils.js";

describe("validateCron", () => {
	it("accepts a valid 5-field expression", () => {
		expect(validateCron("0 9 * * *")).toEqual({ ok: true });
	});

	it("rejects an empty expression", () => {
		const result = validateCron("   ");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/required/i);
	});

	it("rejects expressions with the wrong field count", () => {
		const result = validateCron("0 9 * *");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("5 fields");
	});

	it("rejects unparseable field values", () => {
		const result = validateCron("99 9 * * *");
		expect(result.ok).toBe(false);
	});
});

describe("computeNextRunAt", () => {
	it("returns a future ISO timestamp for a valid cron", () => {
		const now = new Date("2026-08-09T10:00:00Z");
		const next = computeNextRunAt("* * * * *", "Asia/Shanghai", now);
		expect(next).toBeDefined();
		expect(new Date(next!).getTime()).toBeGreaterThan(now.getTime());
	});

	it("returns undefined for an invalid cron instead of throwing", () => {
		expect(computeNextRunAt("not a cron", "Asia/Shanghai")).toBeUndefined();
	});

	it("honours the timezone: 9am Shanghai is 01:00Z", () => {
		// 2026-08-10 is a Monday; pick a cron that fires daily at 09:00.
		const now = new Date("2026-08-09T00:00:00Z");
		const next = computeNextRunAt("0 9 * * *", "Asia/Shanghai", now);
		expect(next).toBe("2026-08-09T01:00:00.000Z");
	});
});

describe("isCronDue", () => {
	it("is due within the 2-minute catch-up window when never run", () => {
		// Every-minute cron: prev fire is the start of the current minute.
		const now = new Date("2026-08-09T10:00:30Z");
		expect(isCronDue("* * * * *", "Asia/Shanghai", undefined, now)).toBe(true);
	});

	it("is not due when the previous fire is older than the catch-up window", () => {
		// Hourly cron at minute 0; "now" is 30 minutes past the last fire.
		const now = new Date("2026-08-09T10:30:00Z");
		expect(isCronDue("0 * * * *", "Asia/Shanghai", undefined, now)).toBe(false);
	});

	it("is not due when it already ran after the previous fire", () => {
		const now = new Date("2026-08-09T10:00:30Z");
		const lastRunAt = "2026-08-09T10:00:05.000Z";
		expect(isCronDue("* * * * *", "Asia/Shanghai", lastRunAt, now)).toBe(false);
	});

	it("returns false for an invalid cron instead of throwing", () => {
		expect(isCronDue("garbage", "Asia/Shanghai", undefined)).toBe(false);
	});
});

describe("getCronDueAt", () => {
	it("returns the exact occurrence that is due", () => {
		const now = new Date("2026-08-09T10:00:30Z");
		expect(getCronDueAt("0 * * * *", "Asia/Shanghai", undefined, now)).toBe("2026-08-09T10:00:00.000Z");
	});

	it("returns undefined after the latest occurrence has been recorded", () => {
		const now = new Date("2026-08-09T10:00:30Z");
		expect(getCronDueAt("0 * * * *", "Asia/Shanghai", "2026-08-09T10:00:05.000Z", now)).toBeUndefined();
	});
});

describe("getCronOccurrencesForDate", () => {
	it("enumerates every occurrence in a local calendar day", () => {
		expect(getCronOccurrencesForDate("0 9,18 * * *", "Asia/Shanghai", "2026-09-10", "Asia/Shanghai"))
			.toEqual(["2026-09-10T01:00:00.000Z", "2026-09-10T10:00:00.000Z"]);
	});

	it("uses the day timezone boundary while preserving the job timezone", () => {
		expect(getCronOccurrencesForDate("0 0 * * *", "UTC", "2026-09-10", "Asia/Shanghai"))
			.toEqual(["2026-09-10T00:00:00.000Z"]);
	});

	it("returns no occurrences for an invalid expression", () => {
		expect(getCronOccurrencesForDate("not a cron", "Asia/Shanghai", "2026-09-10")).toEqual([]);
	});
});

describe("isOneShotCron", () => {
	it("flags a fully pinned date-time expression", () => {
		expect(isOneShotCron("30 14 28 2 *")).toBe(true);
	});

	it("does not flag recurring expressions", () => {
		expect(isOneShotCron("0 9 * * *")).toBe(false);
		expect(isOneShotCron("30 14 28 * *")).toBe(false);
	});

	it("returns false for malformed input", () => {
		expect(isOneShotCron("")).toBe(false);
		expect(isOneShotCron("* * *")).toBe(false);
	});
});
