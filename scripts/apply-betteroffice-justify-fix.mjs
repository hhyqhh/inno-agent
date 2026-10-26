#!/usr/bin/env node
// Re-applies the vendored BetterOffice justification fix after every
// dependency install. The npm package @betteroffice/docx@0.5.0 justifies a
// line by pouring its whole slack into the U+0020 gaps, so a Chinese
// paragraph whose only space sits after a question number ("2. 在轴对称…")
// shows a ~100px gap there. The fix shares the slack across spaces AND East
// Asian inter-character boundaries (matching Word) and lives in the Rust
// engine: crates/ooxml-text/src/word_metrics.rs (character class) and
// crates/docx-layout/src/display_list.rs (distribution). BOTH compiled cores
// embed that code — the layout wasm the viewer paints with and the edit wasm
// whose resident layout produces caret/selection/range geometry — so both are
// swapped. The JS glue in the shipped package is byte-compatible (same
// import surface, same export set); no JS file changes.
//
// Idempotent: an already-patched install is detected by hash and left alone.
// A different @betteroffice/docx version is skipped with a warning — rebuild
// the vendored cores against that version instead of shipping a mismatch.
import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Optional --root <dir> override for the regression test; defaults to the
// repository root this script lives in.
const argRoot = process.argv[process.argv.indexOf("--root") + 1];
const root = argRoot && process.argv.includes("--root")
	? argRoot
	: join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = join(root, "node_modules/@betteroffice/docx/dist/generated");
const vendor = join(root, "vendor/betteroffice");

// Upstream @betteroffice/docx@0.5.0 (gitHead 756b9205…) and the vendored fix,
// hashed so a foreign or already-patched install is never touched twice.
const TARGETS = [
	{
		wasm: join(generated, "layout/docx_layout_bg.wasm"),
		fix: join(vendor, "docx_layout_bg-justify-fix-0.5.0.wasm"),
		upstream: "994514028a050facec88a37ea677722be9868311b4645b4e590adf7931d1c247",
		patched: "bb2dcea29f68c53fed8e93fbb3a620c67eef62419b34befdbafb8b6fb40700fd",
	},
	{
		wasm: join(generated, "edit/docx_edit_bg.wasm"),
		fix: join(vendor, "docx_edit_bg-justify-fix-0.5.0.wasm"),
		upstream: "c47f2b275ea403b1a61689799c1598bcd51bbff3ab110e3406e3c5e1aefcdbf7",
		patched: "9564b4d37982a775ce63dba5b1bdcd552597011d8a489096520fc33fff700efc",
	},
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let packageVersion = "unknown";
try {
	const manifest = JSON.parse(await readFile(join(root, "node_modules/@betteroffice/docx/package.json"), "utf8"));
	packageVersion = manifest.version;
} catch {
	console.log("[betteroffice-justify-fix] @betteroffice/docx is not installed; nothing to patch");
	process.exit(0);
}
if (packageVersion !== "0.5.0") {
	console.warn(`[betteroffice-justify-fix] skipping: @betteroffice/docx ${packageVersion} is not 0.5.0 — rebuild vendor/betteroffice against that version`);
	process.exit(0);
}

let applied = 0;
for (const target of TARGETS) {
	const current = await readFile(target.wasm).catch(() => null);
	if (!current) {
		console.warn(`[betteroffice-justify-fix] ${target.wasm} missing; skipping`);
		continue;
	}
	const currentSha = sha256(current);
	if (currentSha === target.patched) continue;
	if (currentSha !== target.upstream) {
		console.warn(`[betteroffice-justify-fix] skipping ${target.wasm}: sha ${currentSha} matches neither upstream 0.5.0 nor the fix`);
		continue;
	}
	const fixStat = await stat(target.fix).catch(() => null);
	if (!fixStat?.isFile()) {
		console.warn(`[betteroffice-justify-fix] vendored fix missing: ${target.fix}`);
		continue;
	}
	await copyFile(target.fix, target.wasm);
	const written = sha256(await readFile(target.wasm));
	if (written !== target.patched) {
		console.error(`[betteroffice-justify-fix] hash mismatch after copying ${target.fix}`);
		process.exit(1);
	}
	applied += 1;
}
if (applied > 0) {
	console.log(`[betteroffice-justify-fix] applied the CJK-aware justification cores (${applied} wasm)`);
}
