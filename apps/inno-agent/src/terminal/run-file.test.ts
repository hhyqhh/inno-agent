import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RUN_FILE_CONTENT_LENGTH, resolveRunFilePath, writeRunFile } from "./run-file.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "inno-run-file-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("resolveRunFilePath", () => {
	it("accepts a bare filename", () => {
		expect(resolveRunFilePath(dir, "model_reply.py")).toBe(path.join(dir, "model_reply.py"));
	});

	it("rejects path segments, traversal, and separators", () => {
		expect(resolveRunFilePath(dir, "../evil.py")).toBeNull();
		expect(resolveRunFilePath(dir, "sub/dir.py")).toBeNull();
		expect(resolveRunFilePath(dir, "..\\evil.py")).toBeNull();
		expect(resolveRunFilePath(dir, ".")).toBeNull();
		expect(resolveRunFilePath(dir, "..")).toBeNull();
		expect(resolveRunFilePath(dir, "  ")).toBeNull();
	});
});

describe("writeRunFile", () => {
	it("writes content into the terminal cwd", () => {
		const target = writeRunFile(dir, "model_reply.py", "print(42)\n");
		expect(readFileSync(target, "utf8")).toBe("print(42)\n");
	});

	it("rejects content above the size cap", () => {
		expect(() => writeRunFile(dir, "big.py", "x".repeat(MAX_RUN_FILE_CONTENT_LENGTH + 1)))
			.toThrow(/too large/);
	});

	it("rejects an escaping file name", () => {
		expect(() => writeRunFile(dir, "../evil.py", "x")).toThrow(/Invalid run file name/);
	});
});
