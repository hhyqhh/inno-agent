import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonl, readJson, readJsonAsync, readJsonl, readJsonlAsync, readJsonlTail, readTextAsync, writeJson } from "./file-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-filestore-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("asynchronous readers", () => {
	it("uses defaults for missing files and malformed JSON", async () => {
		expect(await readTextAsync(join(dir, "missing"), "default")).toBe("default");
		expect(await readJsonAsync(join(dir, "missing"), { fallback: true })).toEqual({ fallback: true });
		writeFileSync(join(dir, "broken.json"), "not JSON");
		expect(await readJsonAsync(join(dir, "broken.json"), [])).toEqual([]);
	});
	it("reads JSON and skips malformed JSONL records without losing valid entries", async () => {
		writeJson(join(dir, "valid.json"), { value: "你好" });
		expect(await readJsonAsync(join(dir, "valid.json"), {})).toEqual({ value: "你好" });
		writeFileSync(join(dir, "records.jsonl"), '{"n":1}\ninvalid\n{"n":2}\n');
		expect(await readJsonlAsync(join(dir, "records.jsonl"))).toEqual([{ n: 1 }, { n: 2 }]);
	});
});

describe("appendJsonl rotation", () => {
	it("appends without rotation when maxBytes is not set", () => {
		const file = join(dir, "log.jsonl");
		appendJsonl(file, { n: 1 });
		appendJsonl(file, { n: 2 });
		expect(readJsonl<{ n: number }>(file).map((r) => r.n)).toEqual([1, 2]);
		expect(readdirSync(dir)).toEqual(["log.jsonl"]);
	});

	it("rolls the file to a timestamped archive once it exceeds maxBytes", () => {
		const file = join(dir, "log.jsonl");
		const record = { payload: "x".repeat(100) };
		appendJsonl(file, record);
		appendJsonl(file, record);
		// File now holds ~230 bytes; a maxBytes below that must trigger rotation
		// before the next append.
		appendJsonl(file, record, { maxBytes: 200 });

		const archives = readdirSync(dir).filter((f) => f.endsWith(".archive"));
		expect(archives).toHaveLength(1);
		expect(archives[0]).toMatch(/^log\.jsonl\..*\.archive$/);
		// The archive holds the pre-rotation content; the live file holds the new record.
		expect(readJsonl<{ payload: string }>(join(dir, archives[0]))).toHaveLength(2);
		expect(readJsonl<{ payload: string }>(file)).toHaveLength(1);
	});

	it("does not rotate while the file is still below maxBytes", () => {
		const file = join(dir, "log.jsonl");
		appendJsonl(file, { n: 1 }, { maxBytes: 1024 * 1024 });
		appendJsonl(file, { n: 2 }, { maxBytes: 1024 * 1024 });
		expect(readdirSync(dir).filter((f) => f.endsWith(".archive"))).toHaveLength(0);
		expect(readJsonl<{ n: number }>(file)).toHaveLength(2);
	});
});

describe("readJsonlTail", () => {
	it("returns empty array for a missing file", () => {
		expect(readJsonlTail(join(dir, "nope.jsonl"), 1024)).toEqual([]);
	});

	it("reads everything when the file is smaller than maxBytes", () => {
		const file = join(dir, "small.jsonl");
		appendJsonl(file, { n: 1 });
		appendJsonl(file, { n: 2 });
		expect(readJsonlTail<{ n: number }>(file, 1024 * 1024).map((r) => r.n)).toEqual([1, 2]);
	});

	it("reads only the tail and drops the possibly-partial first line", () => {
		const file = join(dir, "big.jsonl");
		for (let n = 0; n < 50; n++) {
			appendJsonl(file, { n, pad: "y".repeat(50) });
		}
		const tail = readJsonlTail<{ n: number }>(file, 400);
		expect(tail.length).toBeGreaterThan(0);
		expect(tail.length).toBeLessThan(50);
		// Every returned record is intact (the partial line was dropped) and
		// they are the newest records in original order.
		expect(tail[tail.length - 1].n).toBe(49);
		expect(tail.map((r) => r.n)).toEqual([...tail.map((r) => r.n)].sort((a, b) => a - b));
	});

	it("skips malformed lines without failing the whole read", () => {
		const file = join(dir, "mixed.jsonl");
		writeFileSync(file, '{"n":1}\nnot json\n{"n":2}\n', "utf-8");
		expect(readJsonlTail<{ n: number }>(file, 1024).map((r) => r.n)).toEqual([1, 2]);
	});
});

describe("writeJson mode option", () => {
	it.skipIf(process.platform === "win32")("writes secret files with 0o600 and fixes pre-existing 0644 files", () => {
		const file = join(dir, "secret.json");

		writeJson(file, { key: "v1" }, { mode: 0o600 });
		expect(statSync(file).mode & 0o777).toBe(0o600);

		// Simulate a file written before the mode option existed.
		writeFileSync(file, "{}", "utf-8");
		chmodSync(file, 0o644);
		writeJson(file, { key: "v2" }, { mode: 0o600 });
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("leaves permissions alone when no mode is given", () => {
		const file = join(dir, "plain.json");
		writeJson(file, { a: 1 });
		expect(readJson(file, null)).toEqual({ a: 1 });
	});
});
