import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const run = promisify(execFile);
const script = new URL("./apply-betteroffice-justify-fix.mjs", import.meta.url).pathname;
const vendored = new URL("../vendor/betteroffice/", import.meta.url).pathname;
const roots = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixtureRoot(wasmBytes) {
	const root = await mkdtemp(join(tmpdir(), "justify-fix-"));
	roots.push(root);
	await mkdir(join(root, "node_modules/@betteroffice/docx/dist/generated/layout"), { recursive: true });
	await mkdir(join(root, "node_modules/@betteroffice/docx/dist/generated/edit"), { recursive: true });
	await writeFile(
		join(root, "node_modules/@betteroffice/docx/package.json"),
		JSON.stringify({ name: "@betteroffice/docx", version: "0.5.0" }),
	);
	await copyFile(join(vendored, "docx_layout_bg-justify-fix-0.5.0.wasm"), join(root, "node_modules/@betteroffice/docx/dist/generated/layout/docx_layout_bg.wasm"));
	await copyFile(join(vendored, "docx_edit_bg-justify-fix-0.5.0.wasm"), join(root, "node_modules/@betteroffice/docx/dist/generated/edit/docx_edit_bg.wasm"));
	// the fixture starts from the patched bytes; tests overwrite what they need
	if (wasmBytes) {
		await writeFile(join(root, "node_modules/@betteroffice/docx/dist/generated/layout/docx_layout_bg.wasm"), wasmBytes);
		await writeFile(join(root, "node_modules/@betteroffice/docx/dist/generated/edit/docx_edit_bg.wasm"), wasmBytes);
	}
	return root;
}

const runScript = (root) => run("node", [script, "--root", root]);

describe("apply-betteroffice-justify-fix", () => {
	it("leaves an already-patched install untouched and exits 0", async () => {
		const root = await fixtureRoot();
		const { stdout, stderr } = await runScript(root);
		// silent success is the idempotent path: nothing was swapped
		assert.equal(stdout, "");
		assert.equal(stderr, "");
	});

	it("skips with a warning on a foreign @betteroffice/docx version", async () => {
		const root = await fixtureRoot();
		await writeFile(
			join(root, "node_modules/@betteroffice/docx/package.json"),
			JSON.stringify({ name: "@betteroffice/docx", version: "0.6.0" }),
		);
		const { stdout, stderr } = await runScript(root);
		assert.match(stderr, /skipping: @betteroffice\/docx 0\.6\.0 is not 0\.5\.0/);
		assert.ok(stdout.length === 0 || !stdout.includes("applied"));
	});

	it("exits 0 when @betteroffice/docx is not installed", async () => {
		const root = await mkdtemp(join(tmpdir(), "justify-fix-empty-"));
		roots.push(root);
		const { stdout } = await runScript(root);
		assert.match(stdout, /not installed/);
	});
});
