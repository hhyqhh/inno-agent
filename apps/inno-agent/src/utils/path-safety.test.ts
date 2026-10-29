import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContainedPathAsync } from "./path-safety.js";

describe("async path containment", () => {
	let dir: string;
	let root: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "inno-path-async-"));
		root = join(dir, "root");
		mkdirSync(root);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("accepts existing and missing descendants through a symlinked root", async () => {
		symlinkSync(root, join(dir, "alias"), "dir");
		writeFileSync(join(root, "inside.txt"), "inside");
		for (const path of ["inside.txt", "nested/new.txt"]) {
			expect(await resolveContainedPathAsync(join(dir, "alias"), path)).toBe(join(dir, "alias", path));
		}
	});
	it("rejects lexical escapes, symlink escapes and dangling symlink targets", async () => {
		symlinkSync(dir, join(root, "outside"), "dir");
		symlinkSync(join(dir, "absent"), join(root, "dangling"), "dir");
		for (const path of ["../outside.txt", "outside/new.txt", "dangling/new.txt"]) {
			expect(await resolveContainedPathAsync(root, path)).toBeNull();
		}
	});
});
