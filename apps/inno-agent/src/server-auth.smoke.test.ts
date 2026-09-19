import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Auth-specific smoke tests for server.ts (issue #159 / #162 item 8),
 * separate from server.smoke.test.ts because this suite needs a
 * `server.token` configured, whereas the main suite intentionally runs
 * without one to exercise the (more common) default posture.
 *
 * Same spawn-a-real-child-process approach as server.smoke.test.ts — the
 * token gate lives in the request handler / WS upgrade handler, not in any
 * unit-testable pure function, so this is the only way to exercise it
 * end-to-end.
 */

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const TOKEN = "smoke-test-token-abc123";
const DUMMY_API_KEY = "sk-test-secret-key-12345";

let home: string;
let workspace: string;
let port: number;
let child: ChildProcess;
let childLog = "";

async function getFreePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const freePort = (srv.address() as AddressInfo).port;
			srv.close(() => resolvePort(freePort));
		});
		srv.on("error", reject);
	});
}

function api(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, init);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "inno-auth-smoke-home-"));
	workspace = mkdtempSync(join(tmpdir(), "inno-auth-smoke-ws-"));
	mkdirSync(join(home, "config"), { recursive: true });
	writeFileSync(
		join(home, "config", "config.json"),
		JSON.stringify({
			defaultProvider: "dummy",
			defaultModel: "dummy-model",
			providers: {
				dummy: {
					baseUrl: "http://127.0.0.1:9", // nothing listens here; no LLM call is made
					apiKey: DUMMY_API_KEY,
					api: "openai-completions",
					models: [{ id: "dummy-model" }],
				},
			},
			server: { token: TOKEN },
		}),
		"utf-8",
	);

	port = await getFreePort();
	child = spawn(
		process.execPath,
		["--import", "tsx", SERVER_ENTRY, "--home", home, "--data-dir", join(home, "data"), "--workspace", workspace, "--port", String(port)],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.on("data", (chunk) => (childLog += chunk));
	child.stderr?.on("data", (chunk) => (childLog += chunk));

	const deadline = Date.now() + 90_000;
	let ready = false;
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code;
	});
	while (Date.now() < deadline) {
		if (exitCode !== null) {
			throw new Error(`server exited early with code ${exitCode}\n--- child log ---\n${childLog}`);
		}
		try {
			const res = await api("/health");
			if (res.status === 200) {
				ready = true;
				break;
			}
		} catch {
			// connection refused while the server is still starting
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!ready) {
		throw new Error(`server did not become ready within 90s\n--- child log ---\n${childLog}`);
	}
}, 120_000);

afterAll(async () => {
	if (child && !child.killed) {
		child.kill("SIGTERM");
		await new Promise<void>((resolveDone) => {
			const force = setTimeout(() => {
				child.kill("SIGKILL");
				resolveDone();
			}, 5_000);
			child.on("exit", () => {
				clearTimeout(force);
				resolveDone();
			});
		});
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
}, 30_000);

describe("server auth smoke (server.token configured)", () => {
	it("/health stays open without a token — Electron's loading screen polls it pre-auth", async () => {
		const res = await api("/health");
		expect(res.status).toBe(200);
	});

	it("rejects /api/* with no token, and with a wrong token", async () => {
		expect((await api("/api/sessions")).status).toBe(401);
		expect((await api("/api/sessions", { headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
		expect((await api("/api/sessions", { headers: { Authorization: TOKEN } })).status).toBe(401); // missing "Bearer " scheme
	});

	it("accepts the correct token via Authorization: Bearer", async () => {
		const res = await api("/api/sessions", { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(200);
	});

	it("accepts the correct token via ?token= (for contexts that can't set headers)", async () => {
		// /api/sessions itself matches on an exact URL with no query string, so
		// this uses a route that already takes query params — the same as the
		// real callers (workspaceFileUrl, terminalWsUrl) that append ?token=
		// alongside their own params.
		const res = await api(`/api/workspace/tree?token=${encodeURIComponent(TOKEN)}`);
		expect(res.status).toBe(200);
	});

	it("still rejects a cross-origin request even with a valid token", async () => {
		const res = await api("/api/sessions", {
			headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" },
		});
		expect(res.status).toBe(403);
	});

	it("exempts /api/bridge/messages from server.token (it has its own bridge token)", async () => {
		// No bridge configured in this test's config → 404 (not 401), proving
		// the request reached the bridge route handler instead of being
		// rejected by the server-wide token gate.
		const res = await api("/api/bridge/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(res.status).toBe(404);
	});

	it("index.html carries the injected window.__INNO_API_TOKEN__ when a token is configured", async () => {
		const res = await api("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(`window.__INNO_API_TOKEN__=${JSON.stringify(TOKEN)}`);
	});

	it("terminal WS upgrade: 401 without a token, 101 with one (real status line, not a silent RST)", async () => {
		const created = await api("/api/sessions", { headers: { Authorization: `Bearer ${TOKEN}` }, method: "POST", body: "{}" });
		expect(created.status).toBe(201);
		const { id: sessionId } = (await created.json()) as { id: string };
		const term = await api(`/api/terminal/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId }),
		});
		expect(term.status).toBe(201);
		const { id: terminalId } = (await term.json()) as { id: string };

		// fetch() can't drive a WS handshake, but node:http's client can, and
		// crucially distinguishes a genuine 101 (fires "upgrade") from a
		// rejection that returns a normal status code (fires "response") —
		// exactly the two paths the server's upgrade handler can take now.
		const probeUpgrade = (extraHeaders: Record<string, string>): Promise<number | undefined> =>
			new Promise((resolveProbe, rejectProbe) => {
				const req = httpRequest({
					host: "127.0.0.1",
					port,
					path: `/api/terminal/sessions/${encodeURIComponent(terminalId)}/ws`,
					headers: {
						Connection: "Upgrade",
						Upgrade: "websocket",
						"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
						"Sec-WebSocket-Version": "13",
						...extraHeaders,
					},
				});
				req.on("upgrade", (res, socket) => {
					socket.destroy();
					resolveProbe(res.statusCode);
				});
				req.on("response", (res) => {
					res.resume();
					res.on("end", () => resolveProbe(res.statusCode));
				});
				req.on("error", rejectProbe);
				req.end();
			});

		expect(await probeUpgrade({})).toBe(401);
		expect(await probeUpgrade({ Authorization: `Bearer ${TOKEN}` })).toBe(101);
	});
});
