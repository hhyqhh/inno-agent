import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * HTTP smoke tests for server.ts — the safety net for the route-domain
 * extraction in docs/quality-remediation-plan.md (P2).
 *
 * server.ts is a side-effect-only entry point (no exports), so these tests
 * spawn it as a child process against a throwaway --home with a dummy
 * provider, then assert status codes / redaction on a handful of endpoints.
 * No LLM calls are made.
 */

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const DUMMY_API_KEY = "sk-test-secret-key-12345";

let home: string;
let dataDir: string;
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

function api(path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "inno-smoke-home-"));
	dataDir = join(home, "data");
	workspace = mkdtempSync(join(tmpdir(), "inno-smoke-ws-"));
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
		}),
		"utf-8",
	);

	port = await getFreePort();
	child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			SERVER_ENTRY,
			"--home",
			home,
			"--data-dir",
			dataDir,
			"--workspace",
			workspace,
			"--port",
			String(port),
		],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.on("data", (chunk) => (childLog += chunk));
	child.stderr?.on("data", (chunk) => (childLog += chunk));

	// Wait for readiness: poll /health (it answers before any bootstrap).
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

describe("server smoke", () => {
	it("GET /health returns 200 ok without bootstrap side effects", async () => {
		const res = await api("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("GET /api/settings returns 200 with provider API keys redacted", async () => {
		const res = await api("/api/settings");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: Record<string, { apiKey: string }>;
		};
		const apiKey = body.providers.dummy.apiKey;
		expect(apiKey).not.toBe(DUMMY_API_KEY);
		expect(apiKey).toMatch(/^\*\*\*\*/);
		expect(apiKey.endsWith(DUMMY_API_KEY.slice(-4))).toBe(true);
	}, 60_000 /* first /api/* call triggers lazy bootstrap */);

	it("GET /api/sessions returns 200", async () => {
		const res = await api("/api/sessions");
		expect(res.status).toBe(200);
	}, 60_000);

	it("GET /api/sessions/:id returns 404 for a missing session", async () => {
		const res = await api("/api/sessions/no-such-session.jsonl");
		expect(res.status).toBe(404);
	});

	it("POST /api/sessions/:id/archive + unarchive round-trips", async () => {
		const archive = await fetch(`http://127.0.0.1:${port}/api/sessions/some-session.jsonl/archive`, { method: "POST" });
		expect(archive.status).toBe(200);
		expect((await archive.json()) as { archived: boolean }).toEqual({ id: "some-session.jsonl", archived: true });
		const unarchive = await fetch(`http://127.0.0.1:${port}/api/sessions/some-session.jsonl/unarchive`, { method: "POST" });
		expect(unarchive.status).toBe(200);
		expect((await unarchive.json()) as { archived: boolean }).toEqual({ id: "some-session.jsonl", archived: false });
	});

	it("GET /api/jobs returns 200", async () => {
		const res = await api("/api/jobs");
		expect(res.status).toBe(200);
	});

	it("POST /api/jobs with an invalid cron returns 400 (route-domain extraction guard)", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "bad", cron: "not a cron", prompt: "x", taskType: "custom_prompt" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Invalid cron");
	});

	it("PUT /api/settings/theme accepts a valid theme and rejects an invalid one", async () => {
		const ok = await fetch(`http://127.0.0.1:${port}/api/settings/theme`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: "ocean" }),
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { ui: { theme: string } };
		expect(body.ui.theme).toBe("ocean");

		const bad = await fetch(`http://127.0.0.1:${port}/api/settings/theme`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: "neon" }),
		});
		expect(bad.status).toBe(400);
	});

	it("PUT /api/settings/memory validates boolean fields", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/settings/memory`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ l2Enabled: "yes" }),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/mcp returns 200 with the adapter overview", async () => {
		const res = await api("/api/mcp");
		expect(res.status).toBe(200);
	});

	it("practice: runs list 400 without sessionId, run detail 404, terminal create 400 without sessionId", async () => {
		expect((await api("/api/runs?limit=5")).status).toBe(400);
		expect((await api("/api/runs/run_missing")).status).toBe(404);
		const term = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(term.status).toBe(400);
	});

	it("GET /api/channels returns 200 with an empty list (no channels configured)", async () => {
		const res = await api("/api/channels");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("GET /api/presets returns 200 with the bundled presets", async () => {
		const res = await api("/api/presets");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBeGreaterThan(0);
	});

	it("POST /api/bridge/messages returns 404 when no bridge is configured", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/bridge/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/skills returns 200 with a list", async () => {
		const res = await api("/api/skills");
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("learner profile: goal create → patch → delete round-trip", async () => {
		const profile = await api("/api/learner/profile");
		expect(profile.status).toBe(200);

		const created = await fetch(`http://127.0.0.1:${port}/api/learner/profile/goals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "smoke goal" }),
		});
		expect(created.status).toBe(201);
		const goal = (await created.json()) as { goal_id: string; title: string };
		expect(goal.title).toBe("smoke goal");

		const patched = await fetch(`http://127.0.0.1:${port}/api/learner/profile/goals/${goal.goal_id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "paused" }),
		});
		expect(patched.status).toBe(200);

		const removed = await fetch(`http://127.0.0.1:${port}/api/learner/profile/goals/${goal.goal_id}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		const gone = await fetch(`http://127.0.0.1:${port}/api/learner/profile/goals/${goal.goal_id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "active" }),
		});
		expect(gone.status).toBe(404);
	});

	it("POST /api/skills/upload validates required fields", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/skills/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: "x.zip" }),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/skills/:name/content returns 404 for a missing skill", async () => {
		const res = await api("/api/skills/no-such-skill/content");
		expect(res.status).toBe(404);
	});

	it("GET /api/jobs/:id/runs returns 200 for any id shape", async () => {
		const res = await api("/api/jobs/job_missing/runs");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("wiki: pages/graph/stats return 200, missing page 404, traversal 400", async () => {
		expect((await api("/api/wiki/pages")).status).toBe(200);
		expect((await api("/api/wiki/graph")).status).toBe(200);
		expect((await api("/api/wiki/stats")).status).toBe(200);
		expect((await api("/api/wiki/page?path=wiki/concepts/nope.md")).status).toBe(404);
		expect((await api("/api/wiki/page?path=../escape.md")).status).toBe(400);
	});

	it("wiki page routes cannot read, overwrite, or delete internal L2 files", async () => {
		const l2DataDir = join(dataDir, "l2");
		const fixtures = [
			["raw/uploads/route-secret.md", "immutable raw bytes"],
			["manifest.jsonl", "{\"id\":\"private-manifest-record\"}\n"],
			["extracted/evidence/by-id/route-secret.json", "{\"private\":true}\n"],
			["wiki/index.md", "private navigation bytes"],
		] as const;
		const snapshots = fixtures.map(([relativePath]) => {
			const absolutePath = join(l2DataDir, relativePath);
			return {
				absolutePath,
				existed: existsSync(absolutePath),
				bytes: existsSync(absolutePath) ? readFileSync(absolutePath) : undefined,
			};
		});

		try {
			for (const [relativePath, content] of fixtures) {
				const absolutePath = join(l2DataDir, relativePath);
				mkdirSync(join(absolutePath, ".."), { recursive: true });
				writeFileSync(absolutePath, content, "utf8");
				const originalBytes = readFileSync(absolutePath);
				const encodedPath = encodeURIComponent(relativePath);

				const get = await api(`/api/wiki/page?path=${encodedPath}`);
				expect(get.status).toBe(400);
				expect(await get.json()).toEqual({ error: "Invalid wiki path", code: "invalid_wiki_path" });
				expect(readFileSync(absolutePath)).toEqual(originalBytes);

				const put = await fetch(`http://127.0.0.1:${port}/api/wiki/page`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: relativePath, content: "overwritten" }),
				});
				expect(put.status).toBe(400);
				expect(await put.json()).toEqual({ error: "Invalid wiki path", code: "invalid_wiki_path" });
				expect(readFileSync(absolutePath)).toEqual(originalBytes);

				const remove = await fetch(`http://127.0.0.1:${port}/api/wiki/page?path=${encodedPath}`, {
					method: "DELETE",
				});
				expect(remove.status).toBe(400);
				expect(await remove.json()).toEqual({ error: "Invalid wiki path", code: "invalid_wiki_path" });
				expect(readFileSync(absolutePath)).toEqual(originalBytes);
			}
		} finally {
			for (const snapshot of snapshots) {
				if (snapshot.existed) writeFileSync(snapshot.absolutePath, snapshot.bytes!);
				else rmSync(snapshot.absolutePath, { force: true });
			}
		}
	}, 60_000);

	it("serves immutable L2 source bytes only by manifest id and strong revision", async () => {
		const l2DataDir = join(dataDir, "l2");
		const sourceId = "l2src_smoke_content";
		const rawPath = "raw/uploads/source-route-smoke.md";
		const rawAbsolutePath = join(l2DataDir, rawPath);
		const manifestPath = join(l2DataDir, "manifest.jsonl");
		const rawBytes = Buffer.from("# Smoke source\n\nImmutable source bytes.\n", "utf8");
		const rawContentHash = createHash("sha256").update(rawBytes).digest("hex");
		const sourceRevision = `sha256:${rawContentHash}`;
		const snapshots = [rawAbsolutePath, manifestPath].map((absolutePath) => ({
			absolutePath,
			existed: existsSync(absolutePath),
			bytes: existsSync(absolutePath) ? readFileSync(absolutePath) : undefined,
		}));

		try {
			mkdirSync(join(rawAbsolutePath, ".."), { recursive: true });
			writeFileSync(rawAbsolutePath, rawBytes);
			const existingManifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
			writeFileSync(manifestPath, `${existingManifest}${JSON.stringify({
				id: sourceId,
				title: "Smoke source",
				sourceType: "markdown",
				rawPath,
				extractedPath: "extracted/source-route-smoke.md",
				wikiPages: [],
				tags: [],
				contentHash: rawContentHash.slice(0, 16),
				rawContentHash,
				rawSize: rawBytes.length,
				rawMtimeMs: 0,
				rawKind: "uploaded-original",
				status: "indexed",
				source: { origin: "user_upload" },
				createdAt: "2026-08-16T00:00:00.000Z",
				updatedAt: "2026-08-16T00:00:00.000Z",
			})}\n`, "utf8");

			const missingPrecondition = await api(`/api/l2/sources/${sourceId}/content`);
			expect(missingPrecondition.status).toBe(428);
			expect(await missingPrecondition.json()).toEqual(expect.objectContaining({ code: "if_match_required" }));

			const content = await fetch(`http://127.0.0.1:${port}/api/l2/sources/${sourceId}/content`, {
				headers: { "If-Match": `"${sourceRevision}"` },
			});
			expect(content.status).toBe(200);
			expect(content.headers.get("etag")).toBe(`"${sourceRevision}"`);
			expect(content.headers.get("content-type")).toContain("text/markdown");
			expect(content.headers.get("x-content-type-options")).toBe("nosniff");
			expect(Buffer.from(await content.arrayBuffer())).toEqual(rawBytes);

			const forgedPathId = await fetch(
				`http://127.0.0.1:${port}/api/l2/sources/${encodeURIComponent("../manifest.jsonl")}/content`,
				{ headers: { "If-Match": `"${sourceRevision}"` } },
			);
			expect(forgedPathId.status).toBe(404);
			const forgedPathError = await forgedPathId.json() as { code: string; error: string };
			expect(forgedPathError.code).toBe("source_not_found");
			expect(JSON.stringify(forgedPathError)).not.toContain("private-manifest-record");
		} finally {
			for (const snapshot of snapshots) {
				if (snapshot.existed) writeFileSync(snapshot.absolutePath, snapshot.bytes!);
				else rmSync(snapshot.absolutePath, { force: true });
			}
		}
	}, 60_000);

	it("POST /api/l2/raw/upload stores a file and rejects empty payloads", async () => {
		const bad = await fetch(`http://127.0.0.1:${port}/api/l2/raw/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: "x.md" }),
		});
		expect(bad.status).toBe(400);

		const ok = await fetch(`http://127.0.0.1:${port}/api/l2/raw/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: "notes.md", mimeType: "text/markdown", dataBase64: Buffer.from("# hi").toString("base64") }),
		});
		expect(ok.status).toBe(201);
		const body = (await ok.json()) as { rawPath: string };
		expect(body.rawPath).toMatch(/^raw[\\/]uploads[\\/].*\.md$/);
	});

	it("GET /api/workspaces returns 200 with the default workspaces", async () => {
		const res = await api("/api/workspaces");
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("GET /api/workspace/tree returns 200 for the shared tmp workspace", async () => {
		const res = await api("/api/workspace/tree");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { type: string; children: unknown[] };
		expect(body.type).toBe("directory");
		expect(Array.isArray(body.children)).toBe(true);
	});

	it("GET /api/workspace/file returns 404 for a missing file", async () => {
		const res = await api("/api/workspace/file?path=no-such-file.txt");
		expect(res.status).toBe(404);
	});

	it("GET /api/workspace/file rejects symlinks escaping the workspace (issue #162)", async () => {
		const tree = await api("/api/workspace/tree");
		const { root } = (await tree.json()) as { root: string };

		// A symlink planted inside the workspace (trivial via the agent's bash
		// tool) must not let the endpoint read host files outside the root.
		const secretDir = mkdtempSync(join(tmpdir(), "inno-smoke-secret-"));
		// Track what we plant in the shared workspace so the finally block can
		// leave the fixture exactly as it found it.
		const planted = ["escape-link", "direct-link.txt", "dangling-link.txt", "hello.txt"];
		try {
			writeFileSync(join(secretDir, "secret.txt"), "top-secret");
			// "junction" needs no symlink privilege on Windows and is ignored on POSIX.
			symlinkSync(secretDir, join(root, "escape-link"), "junction");
			// File symlinks do require the privilege on Windows; skip just this
			// assertion there when the shell is not elevated (CI runners are).
			let directLinkPlanted = true;
			try {
				symlinkSync(join(secretDir, "secret.txt"), join(root, "direct-link.txt"));
			} catch (err) {
				if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
					directLinkPlanted = false;
				} else {
					throw err;
				}
			}

			const viaDir = await api("/api/workspace/file?path=escape-link/secret.txt");
			expect(viaDir.status).toBe(404);
			if (directLinkPlanted) {
				const viaFile = await api("/api/workspace/file?path=direct-link.txt");
				expect(viaFile.status).toBe(404);
			}

			// A *dangling* symlink (target missing) must not let write endpoints
			// create the target outside the workspace either. Same Windows
			// privilege caveat as the file symlink above.
			let danglingLinkPlanted = true;
			try {
				symlinkSync(join(secretDir, "missing.txt"), join(root, "dangling-link.txt"));
			} catch (err) {
				if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
					danglingLinkPlanted = false;
				} else {
					throw err;
				}
			}
			if (danglingLinkPlanted) {
				const writeViaDangling = await fetch(`http://127.0.0.1:${port}/api/workspace/upload`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ files: [{ path: "dangling-link.txt", dataBase64: Buffer.from("pwned").toString("base64") }] }),
				});
				expect(writeViaDangling.status).toBe(201);
				const writeBody = (await writeViaDangling.json()) as { uploaded: unknown[] };
				expect(writeBody.uploaded).toHaveLength(0);
				expect(existsSync(join(secretDir, "missing.txt"))).toBe(false);
			}

			// Positive control: a genuine file inside the root stays readable.
			writeFileSync(join(root, "hello.txt"), "hello");
			const ok = await api("/api/workspace/file?path=hello.txt");
			expect(ok.status).toBe(200);
		} finally {
			for (const name of planted) {
				rmSync(join(root, name), { recursive: true, force: true });
			}
			rmSync(secretDir, { recursive: true, force: true });
		}
	});

	it("DELETE /api/workspaces/tmp is rejected with 400", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/tmp`, { method: "DELETE" });
		expect(res.status).toBe(400);
	});

	it("unknown /api/ route returns a JSON 404 (not the SPA index.html)", async () => {
		const res = await api("/api/definitely-not-a-route");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("chat: POST /api/chat 400 without prompt, stream 400 without fields, status 200 found:false", async () => {
		const noPrompt = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(noPrompt.status).toBe(400);

		const noFields = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "hi" }),
		});
		expect(noFields.status).toBe(400);

		const status = await api("/api/chat/status/no-such-session");
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ found: false });

		const abort = await fetch(`http://127.0.0.1:${port}/api/chat/sess/turn/abort`, { method: "POST" });
		expect(abort.status).toBe(404);
	});

	it("POST with a malformed JSON body returns 400 (not 500)", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json{",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("Invalid JSON");
	});

	it("POST with an oversized declared Content-Length returns 413 and survives to serve the next request", async () => {
		// Send headers only — the server must reject from the declared length
		// without consuming a single body byte. (issue #162: readBody had no cap)
		const { status, connection } = await new Promise<{ status: number; connection: string | undefined }>(
			(resolveReq, rejectReq) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port,
						path: "/api/chat",
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": String(33 * 1024 * 1024),
						},
					},
					(res) => {
						res.resume();
						res.on("end", () =>
							resolveReq({ status: res.statusCode ?? 0, connection: res.headers.connection }),
						);
					},
				);
				req.on("error", rejectReq);
				req.flushHeaders();
			},
		);
		expect(status).toBe(413);
		expect(connection).toBe("close");

		// The process must still be healthy after rejecting the oversized body.
		const res = await api("/health");
		expect(res.status).toBe(200);
	});

	it("upload endpoints honour the raised cap: 33 MB is accepted, 193 MB is rejected", async () => {
		// 33 MB exceeds the default 32 MB cap but is under the upload cap, so
		// the body is consumed and fails JSON parsing (400) rather than size
		// rejection (413).
		const accepted = await fetch(`http://127.0.0.1:${port}/api/skills/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "a".repeat(33 * 1024 * 1024),
		});
		expect(accepted.status).toBe(400);

		// 193 MB exceeds even the upload cap — headers only, rejected early.
		const { status } = await new Promise<{ status: number }>((resolveReq, rejectReq) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port,
					path: "/api/skills/upload",
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": String(193 * 1024 * 1024),
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolveReq({ status: res.statusCode ?? 0 }));
				},
			);
			req.on("error", rejectReq);
			req.flushHeaders();
		});
		expect(status).toBe(413);
	});
});
