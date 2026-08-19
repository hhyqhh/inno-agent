import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	applyWorkspaceCwd,
	createNewSession,
	getCurrentSessionId,
	switchSessionFile,
} from "../../agent/pi-runner.js";
import { streamRegistry } from "../../chat/stream-registry.js";
import type { RemoteContentSource } from "../../content-source/index.js";
import { logger } from "../../logger.js";
import {
	archiveConversation,
	type ArchiveConversationOptions,
} from "../../memory/l2/conversation-archive-service.js";
import { ensurePresetCached, instantiatePreset } from "../../presets/preset-store.js";
import type { RuntimePaths } from "../../runtime.js";
import {
	buildPathRewrites,
	deriveCaseId,
	exportShowcaseCase,
	readSessionCwd,
	upsertShowcaseIndex,
	type CaseSpec,
} from "../../showcase/case-exporter.js";
import { readJson, writeJson } from "../../storage/file-store.js";
import { TEMP_WORKSPACE_ID, type WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import { contentDispositionAttachment } from "../file-helpers.js";
import { HttpError, json, matchRoute, readBody } from "../http-helpers.js";
import {
	mergeChannels,
	type SessionChannel,
	type SessionChannelMetadata,
	type SessionMessageSummary,
	type SessionQuestionMetadata,
	type SessionSummary,
	type SessionTopicMetadata,
} from "../session-model.js";

/**
 * Server-owned dependencies the sessions routes touch. Most of these are
 * session-metadata helpers that still live in server.ts because the chat
 * domain (not yet extracted) uses them too; they are injected rather than
 * imported so the route bodies stay verbatim.
 */
export interface SessionsRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	dataDir: string;
	l2DataDir: string;
	paths: RuntimePaths;
	getContentSource: () => RemoteContentSource;
	parseSessionFile: (filePath: string) => { summary: SessionSummary; messages: SessionMessageSummary[] } | null;
	sessionRevision: (filePath: string) => string;
	readSessionChannelMetadata: () => SessionChannelMetadata;
	sessionChannelMetadataPath: () => string;
	readSessionTopicMetadata: () => SessionTopicMetadata;
	sessionTopicMetadataPath: () => string;
	writeSessionTopic: (id: string, topic: string, generated?: boolean, extra?: { upgraded?: boolean }) => void;
	readSessionQuestionMetadata: () => SessionQuestionMetadata;
	writeSessionQuestionMetadata: (meta: SessionQuestionMetadata) => void;
	recordCurrentSessionChannel: (channel: SessionChannel, explicitSessionId?: string, options?: { setOriginIfEmpty?: boolean }) => void;
	generateSessionTopic: (summary: SessionSummary, messages: SessionMessageSummary[]) => Promise<string>;
	sessionFileFromId: (sessionDir: string, id: string) => string | null;
	releaseQueueFromQuestionBlockedTurn: (sessionId: string) => void;
	runQueueOpWithTimeout: <T>(
		req: HttpReq,
		res: ServerResponse,
		op: (signal: AbortSignal) => Promise<T>,
		timeoutMs?: number,
	) => Promise<T | null>;
	getArchiveRuntime: () => Pick<ArchiveConversationOptions, "model" | "modelRegistry" | "memory">;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split). The two that closed
// over server module state take it as an explicit first parameter instead.
// ---------------------------------------------------------------------------

function sessionArchiveMetadataPath(dataDir: string): string {
	return join(dataDir, "sessions", "archives.json");
}

/** Format an ISO date string for display; returns "—" on invalid input. */
function safeFormatDate(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Pretty JSON.stringify with a fallback for non-serializable values. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Serialize a parsed session (summary + merged messages) into a review-friendly
 * Markdown document. User turns become `## 🧑 用户`, assistant turns become
 * `## 🤖 助手`; thinking traces and tool calls are folded into `<details>` so
 * the linear reading flow stays clean while the full trace remains available.
 *
 * Images are inlined as data URLs so the exported file is self-contained.
 */
function sessionToMarkdown(
	summary: SessionSummary,
	messages: SessionMessageSummary[],
): string {
	const lines: string[] = [];
	const title = summary.name?.trim() || "未命名对话";
	lines.push(`# ${title}`, "");
	const createdAt = safeFormatDate(summary.createdAt);
	const updatedAt = safeFormatDate(summary.updatedAt);
	const channels = summary.channels.length > 0 ? summary.channels.join("、") : "—";
	lines.push(
		`> 共 ${messages.length} 条消息 · 渠道：${channels}`,
		`> 创建：${createdAt} · 更新：${updatedAt}`,
		`> 导出：${new Date().toISOString()}`,
		"",
		"---",
		"",
	);
	for (const msg of messages) {
		const time = safeFormatDate(new Date(msg.timestamp).toISOString());
		if (msg.role === "user") {
			lines.push(`## 🧑 用户`, "");
			lines.push(`*${time}*`, "");
		} else {
			lines.push(`## 🤖 助手`, "");
			lines.push(`*${time}*`, "");
		}
		if (msg.content.trim()) {
			lines.push(msg.content.trim(), "");
		}
		if (msg.images && msg.images.length > 0) {
			for (const img of msg.images) {
				if (img.previewUrl) {
					lines.push(`![image](${img.previewUrl})`, "");
				}
			}
		}
		if (msg.thinking && msg.thinking.trim()) {
			lines.push(
				"<details><summary>💭 思考过程</summary>",
				"",
				msg.thinking.trim(),
				"",
				"</details>",
				"",
			);
		}
		if (msg.tools && msg.tools.length > 0) {
			for (const tool of msg.tools) {
				const tag = tool.isError ? "❌" : "🔧";
				lines.push(
					`<details><summary>${tag} 工具调用：${tool.toolName}</summary>`,
					"",
					"**参数：**",
					"",
					"```json",
					safeStringify(tool.args),
					"```",
					"",
				);
				if (tool.result !== undefined) {
					lines.push("**结果：**", "", "```json", safeStringify(tool.result), "```", "");
				}
				lines.push("</details>", "");
			}
		}
	}
	return lines.join("\n");
}

/** Derive a session's origin, with backfill for legacy sessions lacking one. */
function deriveOrigin(meta: { channels: SessionChannel[]; origin?: SessionChannel } | undefined): SessionChannel {
	if (meta?.origin) return meta.origin;
	// Legacy backfill: prefer the first non-web channel the session touched
	// (channel-native sessions), otherwise treat it as web.
	const nonWeb = (meta?.channels ?? []).find((c) => c !== "web");
	return nonWeb ?? "web";
}

function withRecordedChannels(summary: SessionSummary, metadata: SessionChannelMetadata): SessionSummary {
	const meta = metadata[summary.id];
	const explicit = meta?.channels ?? [];
	if (explicit.length > 0) {
		// channels.json is the source of truth — merge with content-detected channels
		// but exclude the empty-array fallback from parseSessionFile.
		const contentChannels = summary.channels; // may be [] if nothing detected from JSONL
		return { ...summary, channels: mergeChannels(contentChannels, explicit), origin: deriveOrigin(meta) };
	}
	// No explicit metadata — use content-detected channels, or fall back to "cli"
	// for legacy sessions that predate channel tracking.
	const channels = summary.channels.length > 0 ? summary.channels : ["cli" as SessionChannel];
	return {
		...summary,
		channels,
		origin: deriveOrigin({ channels }),
	};
}

function withRecordedTopic(summary: SessionSummary, metadata: SessionTopicMetadata): SessionSummary {
	const topic = metadata[summary.id]?.topic?.trim();
	// hasTopic lets clients distinguish "no topic recorded yet" (auto-topic may
	// still be generating) from a fallback preview name, without guessing.
	return topic ? { ...summary, name: topic, hasTopic: true } : { ...summary, hasTopic: false };
}

/**
 * CLI-origin sessions are created by the terminal agent, which never touches
 * the workspace registry, so they stay unbound and fall back to tmp. Lazily
 * bind them to the dedicated CLI workspace so they group under "CLI 区".
 */
function bindCliSessionWorkspace(workspaceRegistry: WorkspaceRegistry, summary: SessionSummary): SessionSummary {
	if (summary.origin !== "cli") return summary;
	try {
		if (!workspaceRegistry.isSessionBound(summary.id)) {
			const ws = workspaceRegistry.ensureChannelWorkspace("cli");
			workspaceRegistry.bindSession(summary.id, ws.id);
		}
	} catch (err) {
		// best-effort — never fail the listing on a binding hiccup
	}
	return summary;
}

/**
 * /api/sessions* route domain (list/detail/create/delete, export.md,
 * showcase-export, topic, activate, archive). Returns true when the request
 * was handled. Extracted verbatim from server.ts during the P2 route split —
 * behavior unchanged.
 */
export async function handleSessionsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SessionsRouteContext,
): Promise<boolean> {
	const {
		workspaceRegistry,
		dataDir,
		l2DataDir,
		paths,
		getContentSource,
		parseSessionFile,
		sessionRevision,
		readSessionChannelMetadata,
		sessionChannelMetadataPath,
		readSessionTopicMetadata,
		sessionTopicMetadataPath,
		writeSessionTopic,
		readSessionQuestionMetadata,
		writeSessionQuestionMetadata,
		recordCurrentSessionChannel,
		generateSessionTopic,
		sessionFileFromId,
		releaseQueueFromQuestionBlockedTurn,
		runQueueOpWithTimeout,
		getArchiveRuntime,
	} = ctx;

	// --- Sessions API ---
	if (method === "GET" && url === "/api/sessions") {
		const sessionDir = join(dataDir, "sessions");
		const channelMetadata = readSessionChannelMetadata();
		const topicMetadata = readSessionTopicMetadata();
		const archiveMetadata = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
		const currentSessionId = getCurrentSessionId();
		const sessions = existsSync(sessionDir)
			? readdirSync(sessionDir)
					.filter((file) => file.endsWith(".jsonl"))
					.map((file) => parseSessionFile(join(sessionDir, file))?.summary)
					.filter((summary): summary is SessionSummary => Boolean(summary))
					.map((summary) => withRecordedChannels(summary, channelMetadata))
					.map((summary) => bindCliSessionWorkspace(workspaceRegistry, summary))
					.map((summary) => withRecordedTopic(summary, topicMetadata))
					.map((summary) => ({ ...summary, archived: archiveMetadata[summary.id] === true }))
					.filter((summary) => summary.messageCount > 0 || (summary.id === currentSessionId && summary.origin === "web"))
					.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			: [];
		json(res, 200, sessions);
		return true;
	}

	if (method === "POST" && url === "/api/l2/conversations/archive") {
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = (typeof body.sessionId === "string" ? body.sessionId : "").trim();
		const title = (typeof body.title === "string" ? body.title : "").trim();
		const messageIds = Array.isArray(body.messageIds)
			? body.messageIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
			: undefined;
		const tags = Array.isArray(body.tags)
			? body.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
			: undefined;
		if (!sessionId) {
			json(res, 400, { error: "Missing sessionId" });
			return true;
		}

		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}

		try {
			const result = await archiveConversation(l2DataDir, {
				sessionId,
				title: title || parsed.summary.name,
				tags,
				messageIds,
				messages: parsed.messages.map((message) => ({
					id: message.id,
					role: message.role,
					content: message.content,
					timestamp: message.timestamp,
				})),
				...getArchiveRuntime(),
			});
			json(res, 201, result);
		} catch (err) {
			logger.warn({ err, sessionId }, "failed to archive conversation");
			const message = err instanceof Error ? err.message : "Archive conversation failed";
			json(res, message === "没有可归档的对话消息" ? 422 : 500, { error: message });
		}
		return true;
	}

	const exportSessionMatch = matchRoute("GET", method, url, "/api/sessions/:id/export.md");
	if (exportSessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(exportSessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			readSessionTopicMetadata(),
		);
		const md = sessionToMarkdown(summary, parsed.messages);
		const baseName = (summary.name?.trim() || summary.id.replace(/\.jsonl$/, "")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
		res.writeHead(200, {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": contentDispositionAttachment(`${baseName}.md`),
			"Cache-Control": "no-store",
		});
		res.end(md);
		return true;
	}

	// One-click showcase export: bundle the session (messages + workspace
	// files + wiki/profile keyframes) as a replayable case under
	// <dataDir>/showcase-exports/cases. View it with `npm run showcase:view`.
	const showcaseExportMatch = matchRoute("POST", method, url, "/api/sessions/:id/showcase-export");
	if (showcaseExportMatch) {
		const sessionsDir = join(dataDir, "sessions");
		const sessionPath = sessionFileFromId(sessionsDir, decodeURIComponent(showcaseExportMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const body = await readBody(req).catch((err: unknown) => {
			// An oversized body must still surface as 413 — only a missing or
			// malformed payload is treated as {}.
			if (err instanceof HttpError && err.statusCode === 413) throw err;
			return {};
		}) as Record<string, unknown>;
		const sessionFile = basename(sessionPath);
		const sessionInfo = readSessionCwd(sessionPath);
		const parsed = parseSessionFile(sessionPath);
		const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
		const spec: CaseSpec = {
			id: str(body.id) || deriveCaseId(sessionFile),
			sessionFile,
			// Falls back to the session's custom/generated name, then to the
			// first user message (inside exportShowcaseCase).
			title: str(body.title) || parsed?.summary.name?.trim() || "",
			titleEn: str(body.titleEn),
			description: str(body.description),
			tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
			maxUserTurns: typeof body.maxUserTurns === "number" && body.maxUserTurns > 0 ? body.maxUserTurns : undefined,
			workspaceName: str(body.workspaceName) || undefined,
			excludePaths: Array.isArray(body.excludePaths)
				? body.excludePaths.filter((p): p is string => typeof p === "string")
				: undefined,
		};
		const rewrites = buildPathRewrites({
			workspaceContainers: sessionInfo ? [dirname(sessionInfo.cwd)] : [],
		});
		const outDir = join(dataDir, "showcase-exports", "cases");
		try {
			const entry = exportShowcaseCase(spec, { sessionsDir, dataDir, outDir }, rewrites);
			if (!entry) {
				json(res, 422, { error: "Unable to export session" });
				return true;
			}
			upsertShowcaseIndex(outDir, [entry]);
			json(res, 200, { ok: true, caseId: entry.id, title: entry.title, casesDir: outDir });
		} catch (err) {
			json(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	const sessionMatch = matchRoute("GET", method, url, "/api/sessions/:id");
	if (sessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(sessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const channelMetadata = readSessionChannelMetadata();
		const topicMetadata = readSessionTopicMetadata();
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, channelMetadata),
			topicMetadata,
		);
		json(res, 200, {
			...summary,
			messages: parsed.messages,
			messageCount: parsed.messages.length,
			sessionRevision: sessionRevision(sessionPath),
			// Attach any persisted pending question so the frontend can restore
			// the card after a full process restart (the in-memory turn and its
			// event replay are gone by then).
			pendingQuestion: readSessionQuestionMetadata()[basename(sessionPath)] ?? undefined,
		});
		return true;
	}

	const updateSessionMatch = matchRoute("PATCH", method, url, "/api/sessions/:id");
	if (updateSessionMatch) {
		const id = decodeURIComponent(updateSessionMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const topic = typeof body.name === "string" ? body.name.trim() : "";
		if (!topic) {
			json(res, 400, { error: "Missing session topic" });
			return true;
		}
		writeSessionTopic(basename(sessionPath), topic.slice(0, 120), Boolean(body.generated));
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			readSessionTopicMetadata(),
		);
		json(res, 200, summary);
		return true;
	}

	const generateSessionTopicMatch = matchRoute("POST", method, url, "/api/sessions/:id/generate-topic");
	if (generateSessionTopicMatch) {
		const id = decodeURIComponent(generateSessionTopicMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const topic = await generateSessionTopic(parsed.summary, parsed.messages);
		writeSessionTopic(basename(sessionPath), topic, true, { upgraded: true });
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			readSessionTopicMetadata(),
		);
		json(res, 200, summary);
		return true;
	}

	const activateSessionMatch = matchRoute("POST", method, url, "/api/sessions/:id/activate");
	if (activateSessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(activateSessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		// If the queue is held by another session's question-blocked turn,
		// abort it first — otherwise this switch could wait up to 30 min.
		releaseQueueFromQuestionBlockedTurn(basename(sessionPath));
		const switched = await runQueueOpWithTimeout(req, res, (signal) => switchSessionFile(sessionPath, { signal }));
		if (switched === null) return true; // 409 session_busy already sent (or client gone)
		json(res, 200, { id: basename(sessionPath), active: getCurrentSessionId() === basename(sessionPath) });
		return true;
	}

	if (method === "POST" && url === "/api/sessions") {
		const body = await readBody(req).catch((err: unknown) => {
			// An oversized body must still surface as 413 — only a missing or
			// malformed payload is treated as {}.
			if (err instanceof HttpError && err.statusCode === 413) throw err;
			return {};
		}) as Record<string, unknown>;
		// A new session is always a different session — release the queue
		// from a question-blocked turn before enqueueing (issue #124).
		releaseQueueFromQuestionBlockedTurn("");
		const id = await runQueueOpWithTimeout(req, res, (signal) => createNewSession({ signal }));
		if (id === null) return true; // 409 session_busy already sent (or client gone)
		// This endpoint is exclusively the Web UI's session-creation path.
		// Record the origin immediately so Simple Mode includes the new empty
		// session before the first assistant response has finished streaming.
		recordCurrentSessionChannel("web", id, { setOriginIfEmpty: true });

		// Determine target workspace. The UI chooser always sends an explicit
		// choice (new/existing); temp is only a safety fallback. A presetId
		// takes precedence: it instantiates a bundled preset into a fresh
		// workspace (copying its agent.md + .skills) and binds the session to it.
		let workspaceId: string = TEMP_WORKSPACE_ID;
		const explicitWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";
		const newWorkspaceSpec = body.newWorkspace && typeof body.newWorkspace === "object"
			? body.newWorkspace as { name?: unknown; isTemp?: unknown }
			: null;
		// The follow-up cwd apply re-enters the queue; if the client goes
		// away, cancel it while queued rather than switching the runtime's
		// cwd out from under whatever the user moved on to.
		const cwdAborter = new AbortController();
		res.on("close", () => { if (!res.writableFinished) cwdAborter.abort(); });
		try {
			if (presetId) {
				// Ensure the preset's files are in the local cache (download on
				// first use), then instantiate it into a fresh workspace.
				await ensurePresetCached(paths, getContentSource(), presetId);
				const created = instantiatePreset(paths, workspaceRegistry, presetId);
				workspaceId = created.id;
			} else if (newWorkspaceSpec) {
				const created = workspaceRegistry.createWorkspace({
					name: typeof newWorkspaceSpec.name === "string" ? newWorkspaceSpec.name : undefined,
					isTemp: Boolean(newWorkspaceSpec.isTemp),
				});
				workspaceId = created.id;
			} else if (explicitWorkspaceId && workspaceRegistry.getWorkspace(explicitWorkspaceId)) {
				workspaceId = explicitWorkspaceId;
			}
			workspaceRegistry.bindSession(id, workspaceId);
			// Apply the new workspace cwd to the active runtime so the agent's
			// tools (read/write/bash) operate inside the bound directory.
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
			if (sessionPath) {
				await applyWorkspaceCwd(sessionPath, { signal: cwdAborter.signal });
			}
		} catch (err) {
			logger.warn({ err }, `failed to bind workspace for session ${id}`);
		}

		json(res, 201, { id, active: true, workspaceId });
		return true;
	}

	const deleteSessionMatch = matchRoute("DELETE", method, url, "/api/sessions/:id");
	if (deleteSessionMatch) {
		const id = decodeURIComponent(deleteSessionMatch.id);
		if (streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot delete a session with an active chat turn" });
			return true;
		}
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const sessionId = basename(sessionPath);
		// If deleting the currently active session, swap to a fresh one
		// first so the agent runtime doesn't keep writing to a deleted file.
		let newActiveId: string | null = null;
		if (getCurrentSessionId() === sessionId) {
			releaseQueueFromQuestionBlockedTurn("");
			newActiveId = await runQueueOpWithTimeout(req, res, (signal) => createNewSession({ signal }));
			if (newActiveId === null) return true; // 409 session_busy already sent (or client gone)
		}

		// If this session is the sole owner of a temp workspace, remove the
		// workspace folder + registry entry as well.
		const boundWorkspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
		const shouldDropTempWorkspace = workspaceRegistry.isOnlyTempSessionOwner(sessionId, boundWorkspaceId);

		rmSync(sessionPath, { force: true });
		// Clean sidecar metadata.
		try {
			const topicMeta = readSessionTopicMetadata();
			if (topicMeta[sessionId]) {
				delete topicMeta[sessionId];
				writeJson(sessionTopicMetadataPath(), topicMeta);
			}
			const channelMeta = readSessionChannelMetadata();
			if (channelMeta[sessionId]) {
				delete channelMeta[sessionId];
				writeJson(sessionChannelMetadataPath(), channelMeta);
			}
			const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
			if (archiveMeta[sessionId]) {
				delete archiveMeta[sessionId];
				writeJson(sessionArchiveMetadataPath(dataDir), archiveMeta);
			}
			const questionMeta = readSessionQuestionMetadata();
			if (questionMeta[sessionId]) {
				delete questionMeta[sessionId];
				writeSessionQuestionMetadata(questionMeta);
			}
			workspaceRegistry.unbindSession(sessionId);
			if (shouldDropTempWorkspace) {
				workspaceRegistry.deleteWorkspace(boundWorkspaceId, { removeFiles: true });
			}
		} catch (err) {
			logger.warn({ err }, "session delete cleanup failed");
		}
		json(res, 200, { id: sessionId, deleted: true, newActiveId });
		return true;
	}

	// --- Session Archive ---
	const archiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/archive");
	if (archiveMatch) {
		const id = decodeURIComponent(archiveMatch.id);
		const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
		archiveMeta[id] = true;
		writeJson(sessionArchiveMetadataPath(dataDir), archiveMeta);
		json(res, 200, { id, archived: true });
		return true;
	}

	const unarchiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/unarchive");
	if (unarchiveMatch) {
		const id = decodeURIComponent(unarchiveMatch.id);
		const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
		delete archiveMeta[id];
		writeJson(sessionArchiveMetadataPath(dataDir), archiveMeta);
		json(res, 200, { id, archived: false });
		return true;
	}

	return false;
}
