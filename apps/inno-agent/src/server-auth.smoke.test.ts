import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Smoke tests for the optional server.token API auth (issue #159). Same
 * spawn-a-real-server approach as server.smoke.test.ts, but with a config
 * that sets server.host + server.token.
 */

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SERVER_TOKEN = "test-server-token-abc123";

let home: string;
let workspace: string;
let port: number;
let child: ChildProcess;
let childLog = "";
let createdStubDist = false;

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

function authed(path: string, init?: RequestInit): Promise<Response> {
	return api(path, {
		...init,
		headers: { Authorization: `Bearer ${SERVER_TOKEN}`, ...init?.headers },
	});
}

/** Raw HTTP upgrade request; resolves with the first response bytes ("" when the socket closes silently). */
function rawUpgrade(path: string): Promise<string> {
	return new Promise((resolveReq, rejectReq) => {
		const socket = new Socket();
		let data = "";
		socket.connect(port, "127.0.0.1", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
		});
		socket.on("data", (chunk) => {
			data += chunk.toString();
			socket.destroy();
			resolveReq(data);
		});
		socket.on("close", () => resolveReq(data));
		socket.on("error", rejectReq);
		setTimeout(() => { socket.destroy(); resolveReq(data); }, 5_000);
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "inno-auth-home-"));
	workspace = mkdtempSync(join(tmpdir(), "inno-auth-ws-"));
	mkdirSync(join(home, "config"), { recursive: true });
	writeFileSync(
		join(home, "config", "config.json"),
		JSON.stringify({
			defaultProvider: "dummy",
			defaultModel: "dummy-model",
			providers: {
				dummy: {
					baseUrl: "http://127.0.0.1:9",
					apiKey: "sk-dummy",
					api: "openai-completions",
					models: [{ id: "dummy-model" }],
				},
			},
			server: { port: 3000, host: "127.0.0.1", token: SERVER_TOKEN },
		}),
		"utf-8",
	);

	port = await getFreePort();

	// CI runs tests before the frontend build, so web/dist may not exist.
	// The index.html injection test needs one — stub it (and clean up only
	// what we created).
	const distDir = resolve(REPO_ROOT, "apps/inno-agent/web/dist");
	if (!existsSync(join(distDir, "index.html"))) {
		mkdirSync(distDir, { recursive: true });
		writeFileSync(join(distDir, "index.html"), "<html><head><title>t</title></head><body></body></html>", "utf-8");
		createdStubDist = true;
	}

	child = spawn(
		process.execPath,
		["--import", "tsx", SERVER_ENTRY, "--home", home, "--workspace", workspace, "--port", String(port)],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.on("data", (chunk) => (childLog += chunk));
	child.stderr?.on("data", (chunk) => (childLog += chunk));

	const deadline = Date.now() + 90_000;
	let ready = false;
	let exitCode: number | null = null;
	child.on("exit", (code) => { exitCode = code; });
	while (Date.now() < deadline) {
		if (exitCode !== null) {
			throw new Error(`server exited early with code ${exitCode}\n--- child log ---\n${childLog}`);
		}
		try {
			const res = await api("/health");
			if (res.status === 200) { ready = true; break; }
		} catch {
			// connection refused while starting
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
			const force = setTimeout(() => { child.kill("SIGKILL"); resolveDone(); }, 5_000);
			child.on("exit", () => { clearTimeout(force); resolveDone(); });
		});
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
	if (createdStubDist) {
		rmSync(resolve(REPO_ROOT, "apps/inno-agent/web/dist"), { recursive: true, force: true });
	}
}, 30_000);

describe("server.token auth", () => {
	it("GET /health stays open (Electron loading screen polls it)", async () => {
		const res = await api("/health");
		expect(res.status).toBe(200);
	});

	it("/api/* without a token returns 401", async () => {
		expect((await api("/api/settings")).status).toBe(401);
		expect((await api("/api/settings", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
	});

	it("/api/* accepts the Bearer token and the ?token= query form", async () => {
		expect((await authed("/api/settings")).status).toBe(200);
		expect((await api(`/api/settings?token=${encodeURIComponent(SERVER_TOKEN)}`)).status).toBe(200);
	}, 60_000 /* first authed call triggers lazy bootstrap */);

	it("index.html carries the injected token for the web UI", async () => {
		const res = await api("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("window.__INNO_API_TOKEN__");
		expect(html).toContain(SERVER_TOKEN);
	});

	it("/api/bridge/messages is not gated by the server token (it has its own)", async () => {
		const res = await api("/api/bridge/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		// 404 (no bridge configured) — not 401.
		expect(res.status).toBe(404);
	});

	it("terminal WS upgrade without a token gets an HTTP 401; with a token it passes auth", async () => {
		const denied = await rawUpgrade("/api/terminal/sessions/x/ws");
		expect(denied).toContain("401");

		// Auth passes here; the upgrade then fails downstream (no such
		// terminal session) — the point is that it is NOT a 401.
		const allowed = await rawUpgrade(`/api/terminal/sessions/x/ws?token=${encodeURIComponent(SERVER_TOKEN)}`);
		expect(allowed).not.toContain("401");
	});

	it("WS upgrade with a mismatched Origin gets an HTTP 403", async () => {
		const socket = new Socket();
		const data = await new Promise<string>((resolveReq, rejectReq) => {
			let buf = "";
			socket.connect(port, "127.0.0.1", () => {
				socket.write(
					`GET /api/terminal/sessions/x/ws?token=${SERVER_TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				);
			});
			socket.on("data", (chunk) => { buf += chunk.toString(); socket.destroy(); resolveReq(buf); });
			socket.on("close", () => resolveReq(buf));
			socket.on("error", rejectReq);
			setTimeout(() => { socket.destroy(); resolveReq(buf); }, 5_000);
		});
		expect(data).toContain("403");
	});
});
