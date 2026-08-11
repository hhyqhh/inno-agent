import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkPathWithinRoot } from "./workspace-path-guard.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace path containment", () => {
	it("allows existing and new paths that stay inside the root", () => {
		const root = makeTempDir("inno-path-root-");
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", "existing.txt"), "inside");

		expect(checkPathWithinRoot(root, "nested/existing.txt")).toMatchObject({ allowed: true });
		expect(checkPathWithinRoot(root, "nested/new.txt")).toMatchObject({ allowed: true });
	});

	it("rejects direct traversal and absolute paths outside the root", () => {
		const root = makeTempDir("inno-path-root-");
		const outside = makeTempDir("inno-path-outside-");
		writeFileSync(join(outside, "existing.txt"), "outside");

		expect(checkPathWithinRoot(root, "../escape.txt")).toMatchObject({
			allowed: false,
			reason: "outside_workspace",
		});
		expect(checkPathWithinRoot(root, join(outside, "existing.txt"))).toMatchObject({
			allowed: false,
			reason: "outside_workspace",
		});
	});

	it("rejects existing and new paths reached through an escaping directory link", () => {
		const root = makeTempDir("inno-path-root-");
		const outside = makeTempDir("inno-path-outside-");
		writeFileSync(join(outside, "existing.txt"), "outside");
		symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

		expect(checkPathWithinRoot(root, "link/existing.txt")).toMatchObject({
			allowed: false,
			reason: "outside_workspace",
		});
		expect(checkPathWithinRoot(root, "link/new.txt")).toMatchObject({
			allowed: false,
			reason: "outside_workspace",
		});
	});

	it("rejects paths through a dangling link before its outside target exists", () => {
		const root = makeTempDir("inno-path-root-");
		const outside = makeTempDir("inno-path-outside-");
		const missingTarget = join(outside, "not-created");
		symlinkSync(missingTarget, join(root, "dangling"), process.platform === "win32" ? "junction" : "dir");

		expect(checkPathWithinRoot(root, "dangling/new.txt")).toMatchObject({
			allowed: false,
			reason: "invalid_path",
		});
	});
});
