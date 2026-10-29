/**
 * Tests for the UNO sidecar RPC layer (apps/inno-agent/scripts/uno-bridge.py
 * is exercised separately in live smoke runs; here a fake bridge emulates the
 * JSON-lines protocol so we can test queueing, correlation and crash recovery
 * without LibreOffice).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnoSidecar, resetUnoSidecarForTests } from "./uno-sidecar.js";

const FAKE_BRIDGE = `
let buffer = "";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		const req = JSON.parse(line);
		if (req.cmd === "crash") process.exit(2);
		if (req.cmd === "shutdown") {
			process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { bye: true } }) + "\\n");
			process.exit(0);
		}
		if (req.cmd === "slow") {
			const id = req.id;
			setTimeout(() => {
				process.stdout.write(JSON.stringify({ id, ok: true, result: { slow: true } }) + "\\n");
			}, 30);
			continue;
		}
		process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { cmd: req.cmd, payload: req } }) + "\\n");
	}
});
`;

let workDir: string;
let fakePythonDir: string;
let originalEnv: NodeJS.ProcessEnv;

function stageFakeEngine(): void {
	// darwin layout: <app>/Contents/MacOS/soffice + <app>/Contents/Resources/python
	const appDir = join(workDir, "libreoffice", "LibreOffice.app", "Contents");
	fakePythonDir = join(appDir, "Resources");
	mkdirSync(join(appDir, "MacOS"), { recursive: true });
	mkdirSync(fakePythonDir, { recursive: true });
	writeFileSync(join(appDir, "MacOS", "soffice"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(appDir, "MacOS", "soffice"), 0o755);
	const bridgePath = join(workDir, "fake-bridge.mjs");
	writeFileSync(bridgePath, FAKE_BRIDGE);
	writeFileSync(
		join(fakePythonDir, "python"),
		`#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(bridgePath)} "$@"\n`,
	);
	chmodSync(join(fakePythonDir, "python"), 0o755);
	process.env.INNO_BUNDLED_TOOLS_DIR = join(workDir, "libreoffice");
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "uno-sidecar-"));
	originalEnv = { ...process.env };
	delete process.env.INNO_LIBREOFFICE_PATH;
	delete process.env.INNO_BUNDLED_TOOLS_DIR;
	resetUnoSidecarForTests();
	if (process.platform === "darwin") stageFakeEngine();
});

afterEach(() => {
	process.env = { ...originalEnv };
	rmSync(workDir, { recursive: true, force: true });
	resetUnoSidecarForTests();
});

const itOnDarwin = process.platform === "darwin" ? it : it.skip;

describe("UnoSidecar", () => {
	itOnDarwin("round-trips a call through the fake bridge", async () => {
		const sidecar = new UnoSidecar();
		const res = await sidecar.call("ping");
		expect(res.ok).toBe(true);
		expect((res.result as { payload: { cmd: string } }).payload.cmd).toBe("ping");
		await sidecar.dispose();
	});

	itOnDarwin("correlates concurrent calls by id", async () => {
		const sidecar = new UnoSidecar();
		const [slow, fast] = await Promise.all([
			sidecar.call("slow"),
			sidecar.call("ping"),
		]);
		expect(slow.ok).toBe(true);
		expect(fast.ok).toBe(true);
		expect((slow.result as { slow?: boolean }).slow).toBe(true);
		await sidecar.dispose();
	});

	itOnDarwin("fails pending calls on crash and recovers on the next call", async () => {
		const sidecar = new UnoSidecar();
		await sidecar.call("ping"); // ensure started
		const crashed = await sidecar.call("crash");
		// The crash request itself may time out as the process dies; what
		// matters is it never hangs and never rejects.
		expect(crashed.ok).toBe(false);
		// Give the exit event a tick to land, then the next call must restart.
		await new Promise((r) => setTimeout(r, 100));
		const after = await sidecar.call("ping");
		expect(after.ok).toBe(true);
		await sidecar.dispose();
	}, 30_000);

	it("returns an unavailable error when no engine exists", async () => {
		process.env.INNO_LIBREOFFICE_PATH = join(workDir, "missing-soffice");
		process.env.INNO_BUNDLED_TOOLS_DIR = join(workDir, "nothing");
		process.env.PATH = join(workDir, "empty-path");
		const { existsSync } = await import("node:fs");
		if (process.platform === "darwin"
			&& existsSync("/Applications/LibreOffice.app/Contents/MacOS/soffice")) {
			return; // developer machine with a real system install; skip
		}
		const sidecar = new UnoSidecar();
		const res = await sidecar.call("ping");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("LibreOffice");
	});
});
