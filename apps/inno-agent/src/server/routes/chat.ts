import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync, mkdirSync, statSync, watch, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	abortPromptForTurnToken,
	getCurrentSessionId,
	getLoadedSkills,
	persistCancelledQueuedTurn,
	persistPendingUserTurn,
	runPromptInSession,
	runPromptSerialized,
	runPromptStreamingInSession,
	type PromptRunOutcome,
} from "../../agent/pi-runner.js";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { expandInnoSlashCommand } from "../../agent/inno-extension.js";
import { questionBridge, type QuestionBridgeResult } from "../../agent/question-bridge.js";
import {
	hasCompleteTurnAfterBaseline,
	streamRegistry,
	type SessionStreamState,
	type StreamPersistence,
} from "../../chat/stream-registry.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import type { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import {
	buildAttachmentContext,
	parseChatAttachments,
	validateChatAttachments,
} from "../attachments.js";
import { recordSessionAttachments } from "../attachments-store.js";
import { recordSessionAgentCommand } from "../agent-command-store.js";
import { recordSessionTrace } from "../trace-store.js";
import { WORKSPACE_IGNORES } from "../file-helpers.js";
import { json, matchRoute, readBody } from "../http-helpers.js";
import type {
	SessionChannel,
	SessionMessageSummary,
	SessionQuestionMetadata,
	SessionSummary,
} from "../session-model.js";

/**
 * Server-owned dependencies the chat routes touch: session-metadata helpers
 * and queue/persistence utilities shared with the channel wiring that stays
 * in server.ts. Injected so the route bodies stay verbatim.
 */
export interface ChatRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	dataDir: string;
	paths: RuntimePaths;
	sessionFileFromId: (sessionDir: string, id: string) => string | null;
	releaseQueueFromQuestionBlockedTurn: (sessionId: string) => void;
	readSessionQuestionMetadata: () => SessionQuestionMetadata;
	writeSessionQuestionMetadata: (meta: SessionQuestionMetadata) => void;
	recordCurrentSessionChannel: (channel: SessionChannel, explicitSessionId?: string, options?: { setOriginIfEmpty?: boolean }) => void;
	maybeAutoGenerateTopic: (sessionId: string) => void;
	parseSessionFile: (filePath: string) => { summary: SessionSummary; messages: SessionMessageSummary[] } | null;
	sessionRevision: (filePath: string) => string;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split)
// ---------------------------------------------------------------------------

function phaseForPiEvent(type: string): "start" | "update" | "end" | undefined {
	if (type.endsWith("_start")) return "start";
	if (type.endsWith("_end")) return "end";
	if (type.endsWith("_update")) return "update";
	return undefined;
}

function piEventSummary(event: any): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	if (typeof event.errorMessage === "string") return event.errorMessage;
	if (typeof event.message === "string") return event.message;
	if (typeof event.reason === "string") return event.reason;
	if (typeof event.toolName === "string") return event.toolName;
	if (typeof event.stopReason === "string") return `stopReason: ${event.stopReason}`;
	if (typeof event.status === "string") return event.status;
	return undefined;
}

function piEventDetail(event: any): Record<string, unknown> | undefined {
	if (!event || typeof event !== "object") return undefined;
	const detail: Record<string, unknown> = {};
	for (const key of [
		"attempt", "maxAttempts", "delayMs", "errorMessage", "finalError", "stopReason",
		"toolCallId", "toolName", "reason", "status", "command", "cwd", "output",
		"entryId", "parentId", "filePath", "compactionId",
	]) {
		if (event[key] !== undefined) detail[key] = event[key];
	}
	return Object.keys(detail).length > 0 ? detail : undefined;
}

function systemEventFromPi(event: any, eventType = typeof event?.type === "string" ? event.type : "pi_event"): unknown {
	const attempt = typeof event?.attempt === "number" ? event.attempt : undefined;
	return {
		type: "system_event",
		eventType,
		phase: phaseForPiEvent(eventType),
		summary: piEventSummary(event),
		detail: piEventDetail(event),
		...(attempt !== undefined ? { attempt } : {}),
		...(typeof event?.success === "boolean" ? { success: event.success } : {}),
	};
}

function piEventToSseEvent(event: any): unknown | null {
	if (!event || typeof event.type !== "string") return null;
	switch (event.type) {
		case "message_update": {
			const ev = event.assistantMessageEvent;
			if (!ev || typeof ev.type !== "string") return systemEventFromPi(event, "message_update");
			if (ev.type === "text_start") return { type: "text_start", contentIndex: ev.contentIndex };
			if (ev.type === "text_delta") return { type: "text_delta", delta: ev.delta, contentIndex: ev.contentIndex };
			if (ev.type === "text_end") return { type: "text_end", contentIndex: ev.contentIndex };
			if (ev.type === "thinking_start") return { type: "thinking_start", contentIndex: ev.contentIndex };
			if (ev.type === "thinking_delta") return { type: "thinking_delta", delta: ev.delta, contentIndex: ev.contentIndex };
			if (ev.type === "thinking_end") return { type: "thinking_end", contentIndex: ev.contentIndex };
			if (ev.type === "toolcall_start" || ev.type === "toolcall_delta" || ev.type === "toolcall_end") {
				return toolCallStreamEventFromAssistantEvent(ev);
			}
			// Mid-stream model errors must not be published as "error" events:
			// "error" is a terminal type reserved for finishTurn(), and the
			// publishStreamEvent guard throws "terminal event error must use
			// finishTurn()", masking the real provider error. The terminal error
			// event published from onFinish carries this same message.
			if (ev.type === "error") return null;
			return systemEventFromPi(ev, `message_update:${ev.type}`);
		}
		case "message_end": {
			const msg = event.message;
			if (msg && typeof msg === "object" && "stopReason" in msg && msg.stopReason === "error") {
				// See the message_update error case above — the terminal event
				// from onFinish surfaces this error; publishing it here throws.
				return null;
			}
			return systemEventFromPi(msg ?? event, "message_end");
		}
		case "tool_execution_start":
			return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
		case "tool_execution_update":
			return {
				type: "tool_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError };
      default:
        return systemEventFromPi(event);
	}
}

function toolCallStreamEventFromAssistantEvent(ev: any): unknown | null {
	const content = Array.isArray(ev.partial?.content) ? ev.partial.content : [];
	const block = typeof ev.contentIndex === "number" ? content[ev.contentIndex] : undefined;
	if (!block || typeof block !== "object" || block.type !== "toolCall") return null;
	const toolCallId = typeof block.id === "string" && block.id ? block.id : `content-${ev.contentIndex}`;
	const toolName = typeof block.name === "string" ? block.name : "";
	if (!toolName) return null;
	const args = ev.type === "toolcall_end"
		? ev.toolCall?.arguments ?? block.arguments
		: undefined;
	return {
		type: ev.type === "toolcall_start" ? "tool_call_start" : ev.type === "toolcall_end" ? "tool_call_end" : "tool_call_delta",
		toolCallId,
		toolName,
		contentIndex: ev.contentIndex,
		...(args !== undefined ? { args } : {}),
		...(ev.type === "toolcall_delta" && typeof ev.delta === "string" ? { argsDelta: ev.delta } : {}),
	};
}

/**
 * Persist inline chat images (base64 data URLs from the web UI) to a
 * workspace-local `.chat-images/` directory so file-path-based tools
 * (`ocr_image`, `parse_document`) can read them. Returns workspace-relative
 * paths. When the chat model cannot natively recognize images, the agent is
 * steered (via the system prompt) to call `ocr_image` with these paths.
 */
function persistInlineImages(images: Array<{ data: string; mimeType: string }>, workspaceRoot: string): string[] {
	if (images.length === 0) return [];
	// `.chat-images` is agent-writable like the rest of the workspace — if it
	// (or an ancestor) is a symlink escaping the workspace, pasted images would
	// be written to a host directory. Fail closed and just skip persistence.
	const chatImagesDir = resolveContainedPath(workspaceRoot, ".chat-images");
	if (!chatImagesDir) {
		logger.warn({ workspaceRoot }, "skipping inline image persistence: .chat-images escapes the workspace");
		return [];
	}
	try {
		if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
	} catch (err) {
		logger.warn({ err }, "failed to create .chat-images dir");
		return [];
	}
	const timestamp = Date.now();
	const paths: string[] = [];
	images.forEach((img, idx) => {
		const ext = mimeTypeToExtension(img.mimeType);
		const filename = `${timestamp}-${idx}${ext}`;
		const filePath = join(chatImagesDir, filename);
		try {
			writeFileSync(filePath, Buffer.from(img.data, "base64"));
			paths.push(`.chat-images/${filename}`);
		} catch (err) {
			logger.warn({ err, filename }, "failed to persist inline image");
		}
	});
	return paths;
}

function mimeTypeToExtension(mimeType: string): string {
	switch (mimeType) {
		case "image/png": return ".png";
		case "image/jpeg": return ".jpg";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/tiff": return ".tiff";
		case "image/bmp": return ".bmp";
		default: return ".png";
	}
}

/**
 * Build the fallback prompt variant carrying the saved-image path hint, so
 * the agent knows which files to pass to `ocr_image` / `parse_document`.
 * Only sent when the model can't natively see images (text-only model or a
 * rejected native payload) — vision-capable turns receive the raw prompt so
 * they aren't steered toward `ocr_image`.
 */
function prependImagePathsHint(prompt: string, imagePaths: string[]): string {
	if (imagePaths.length === 0) return prompt;
	const list = imagePaths.map((p) => `- ${p}`).join("\n");
	return (
		`[用户本轮上传了 ${imagePaths.length} 张图片，已保存到工作区：\n${list}\n` +
		`如果需要识别图片中的文字（当前模型可能不支持图片识别），请调用 ocr_image 工具并传入上述路径。]\n\n${prompt}`
	);
}

function recordAgentCommandIfPresent(dataDir: string, sessionId: string, prompt: string): void {
	const expandedContent = expandInnoSlashCommand(prompt);
	if (!expandedContent) return;
	recordSessionAgentCommand(dataDir, sessionId, {
		commandContent: prompt,
		expandedContent,
	});
}

interface TraceSkillInfo {
	name: string;
	description?: string;
	path?: string;
	source?: string;
}

function traceSkillInfo(value: unknown, sourceFallback?: string): TraceSkillInfo | null {
	if (!value || typeof value !== "object") return null;
	const skill = value as Record<string, unknown>;
	const sourceInfo = skill.sourceInfo && typeof skill.sourceInfo === "object"
		? skill.sourceInfo as Record<string, unknown>
		: undefined;
	if (typeof skill.name !== "string" || !skill.name) return null;
	return {
		name: skill.name,
		description: typeof skill.description === "string" ? skill.description : undefined,
		path: typeof skill.filePath === "string"
			? skill.filePath
			: typeof skill.path === "string"
				? skill.path
				: typeof skill.location === "string" ? skill.location : undefined,
		source: typeof skill.source === "string"
			? skill.source
			: typeof sourceInfo?.source === "string" ? sourceInfo.source : sourceFallback,
	};
}

function loadedSkillsForTrace(workspaceRoot: string): TraceSkillInfo[] {
	const skills: TraceSkillInfo[] = [];
	try {
		const loaded = getLoadedSkills().skills;
		if (Array.isArray(loaded)) {
			for (const skill of loaded) {
				const info = traceSkillInfo(skill, "global");
				if (info) skills.push(info);
			}
		}
	} catch {
		// Skill diagnostics are optional UI metadata and must not block a turn.
	}
	try {
		const privateSkillsDir = join(workspaceRoot, ".skills");
		if (existsSync(privateSkillsDir)) {
			const privateSkills = loadSkillsFromDir({ dir: privateSkillsDir, source: "workspace" }).skills;
			for (const skill of privateSkills) {
				const info = traceSkillInfo(skill, "workspace");
				if (info) skills.push(info);
			}
		}
	} catch {
		// Private skill discovery is best-effort, matching prompt construction.
	}
	const byName = new Map<string, TraceSkillInfo>();
	for (const skill of skills) byName.set(skill.name, skill);
	return Array.from(byName.values());
}

function explicitSkillEvent(prompt: string, skills: TraceSkillInfo[]): unknown | null {
	const match = prompt.trim().match(/^\/skill:([^\s]+)(?:\s+([\s\S]+))?$/);
	if (!match) return null;
	const skillName = match[1]!;
	const loaded = skills.find((skill) => skill.name === skillName);
	return {
		type: "skill_invoked",
		skillName,
		args: match[2]?.trim() || undefined,
		source: loaded?.source,
		path: loaded?.path,
		description: loaded?.description,
	};
}

function readSessionBaseline(
	parseSessionFile: ChatRouteContext["parseSessionFile"],
	sessionRevision: ChatRouteContext["sessionRevision"],
	filePath: string,
): { messageCount: number; revision: string } {
	return {
		messageCount: parseSessionFile(filePath)?.messages.length ?? 0,
		revision: sessionRevision(filePath),
	};
}

function confirmTurnPersistence(
	parseSessionFile: ChatRouteContext["parseSessionFile"],
	sessionRevision: ChatRouteContext["sessionRevision"],
	state: SessionStreamState,
	sessionPath: string,
	outcome: PromptRunOutcome,
): StreamPersistence {
	const parsed = parseSessionFile(sessionPath);
	const revision = sessionRevision(sessionPath);
	if (!parsed) return { persisted: false, finalSessionRevision: revision };
	const structurallyComplete = hasCompleteTurnAfterBaseline(
		parsed.messages,
		state.baselineMessageCount,
	);
	const revisionChanged = revision !== state.baselineSessionRevision;
	const persisted = structurallyComplete && revisionChanged && parsed.messages.length > state.baselineMessageCount;
	if (!persisted) {
		logger.error({
			sessionId: state.sessionId,
			turnId: state.turnId,
			outcome: outcome.type,
			baselineMessageCount: state.baselineMessageCount,
			finalMessageCount: parsed.messages.length,
			baselineSessionRevision: state.baselineSessionRevision,
			finalSessionRevision: revision,
		}, "chat turn persistence confirmation failed");
	}
	return {
		persisted,
		finalMessageCount: parsed.messages.length,
		finalSessionRevision: revision,
	};
}

interface WorkspaceFileChange {
	path: string;
	change: "created" | "modified" | "deleted";
}

interface WorkspaceChangeMonitor {
	noteToolEnd(toolCallId: string, toolName: string): void;
	close(): void;
}

const WORKSPACE_CHANGE_IGNORES = new Set([
	...WORKSPACE_IGNORES,
	".next",
	".vite",
	"coverage",
]);
const MAX_WORKSPACE_CHANGE_EVENTS = 40;
const WORKSPACE_CHANGE_SETTLE_MS = 80;

function createWorkspaceChangeMonitor(
	rootDir: string | null,
	publish: (event: unknown) => void,
): WorkspaceChangeMonitor | null {
	if (!rootDir || !existsSync(rootDir)) return null;
	const root = resolve(rootDir);
	const pending = new Map<string, "change" | "rename">();
	let context: { toolCallId: string; toolName: string } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (pending.size === 0 || !context) return;
		const entries = Array.from(pending.entries());
		pending.clear();
		const changes: WorkspaceFileChange[] = [];
		for (const [path, eventType] of entries.slice(0, MAX_WORKSPACE_CHANGE_EVENTS)) {
			const fullPath = resolve(root, path);
			if (existsSync(fullPath)) {
				try {
					if (!statSync(fullPath).isFile()) continue;
				} catch {
					continue;
				}
				changes.push({ path, change: eventType === "rename" ? "created" : "modified" });
			} else {
				changes.push({ path, change: "deleted" });
			}
		}
		if (changes.length > 0) {
			publish({
				type: "workspace_change",
				...context,
				changes,
				truncated: entries.length > MAX_WORKSPACE_CHANGE_EVENTS,
			});
		}
	};

	const scheduleFlush = () => {
		if (!context || closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, WORKSPACE_CHANGE_SETTLE_MS);
	};

	let watcher: ReturnType<typeof watch>;
	try {
		watcher = watch(root, { recursive: true }, (eventType, filename) => {
			if (!filename || closed) return;
			const fullPath = resolve(root, filename.toString());
			const relativePath = relative(root, fullPath);
			if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
			const normalizedPath = relativePath.replaceAll("\\", "/");
			if (normalizedPath.split("/").some((part) => WORKSPACE_CHANGE_IGNORES.has(part))) return;
			pending.set(normalizedPath, eventType);
			scheduleFlush();
		});
	} catch (err) {
		logger.warn({ err, root }, "workspace file monitoring unavailable");
		return null;
	}

	watcher.on("error", (err) => {
		logger.warn({ err, root }, "workspace file monitor failed");
	});

	return {
		noteToolEnd(toolCallId, toolName) {
			context = { toolCallId, toolName };
			scheduleFlush();
		},
		close() {
			closed = true;
			flush();
			watcher.close();
		},
	};
}

/**
 * /api/chat* route domain: non-streaming chat, question-response, abort,
 * status, SSE event replay, and the SSE streaming turn. Returns true when
 * the request was handled. Extracted verbatim from server.ts during the P2
 * route split — behavior unchanged.
 */
export async function handleChatRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: ChatRouteContext,
): Promise<boolean> {
	const {
		workspaceRegistry,
		dataDir,
		paths,
		sessionFileFromId,
		releaseQueueFromQuestionBlockedTurn,
		readSessionQuestionMetadata,
		writeSessionQuestionMetadata,
		recordCurrentSessionChannel,
		maybeAutoGenerateTopic,
		parseSessionFile,
		sessionRevision,
	} = ctx;

	// --- Chat API ---
	if (method === "POST" && url === "/api/chat") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const prompt = body.prompt as string | undefined;
		if (!prompt) {
			json(res, 400, { error: "Missing prompt" });
			return true;
		}
		const rawImages = Array.isArray(body.images) ? body.images : [];
		const images = rawImages
			.filter((img): img is { data: string; mimeType: string } =>
				img && typeof img.data === "string" && typeof img.mimeType === "string")
			.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
		const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;
		const imageSessionId = requestedSessionId || getCurrentSessionId();
		const imageWorkspaceId = workspaceRegistry.getSessionWorkspaceId(imageSessionId);
		const imageWorkspaceRoot = workspaceRegistry.resolveWorkspaceDir(imageWorkspaceId) ?? paths.workspaceDir;
		const imagePaths = persistInlineImages(images, imageWorkspaceRoot);
		// Sent only when the images can't reach the model natively (text-only
		// model or provider rejection); vision turns get the raw prompt so
		// they aren't steered toward ocr_image.
		const imageFallbackPrompt = prependImagePathsHint(prompt, imagePaths);
		recordAgentCommandIfPresent(dataDir, imageSessionId, prompt);
		// Structured attachments: validate every referenced path against the
		// target workspace and prepare the model-visible context block. The
		// persisted prompt text stays untouched (pi-runner appends the block
		// via transformContext only).
		const parsedAttachments = parseChatAttachments(body.attachments);
		const attachments = parsedAttachments ? validateChatAttachments(parsedAttachments, imageWorkspaceRoot) : null;
		const attachmentContext = attachments ? buildAttachmentContext(attachments) : "";
		if (attachments) {
			recordSessionAttachments(dataDir, imageSessionId, {
				promptContent: prompt,
				attachments,
				timestamp: Date.now(),
			});
		}
		// Use atomic switch+prompt when a specific session is requested.
		let output: string;
		try {
			if (requestedSessionId) {
				const sessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
				if (sessionPath && existsSync(sessionPath)) {
					output = await runPromptInSession(sessionPath, prompt, images.length ? images : undefined, imageFallbackPrompt, attachmentContext || undefined);
				} else {
					output = await runPromptSerialized(prompt, images.length ? images : undefined, imageFallbackPrompt, attachmentContext || undefined);
				}
			} else {
				output = await runPromptSerialized(prompt, images.length ? images : undefined, imageFallbackPrompt, attachmentContext || undefined);
			}
		} catch (err) {
			logger.error({ err, sessionId: requestedSessionId }, "Non-streaming chat LLM call failed");
			json(res, 500, { error: err instanceof Error ? err.message : "LLM API call failed" });
			return true;
		}
		recordCurrentSessionChannel("web", requestedSessionId || undefined, { setOriginIfEmpty: true });
		maybeAutoGenerateTopic(requestedSessionId || getCurrentSessionId());
		json(res, 200, { response: output });
		return true;
	}

	// --- Question response (from web UI) ---
	if (method === "POST" && url === "/api/chat/question-response") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const questionId = typeof body.questionId === "string" ? body.questionId : "";
		const result = body.result as QuestionBridgeResult | undefined;
		if (!sessionId || !turnId || !questionId || !result) {
			json(res, 400, { error: "Missing sessionId, turnId, questionId or result" });
			return true;
		}
		const status = questionBridge.respond({ sessionId, turnId, questionId, result });
		if (status === "not_found") {
			// The live turn is gone (process restarted, or the turn ended while
			// the card was parked). If a persisted card matches, consume it and
			// tell the client to resubmit the answer as a fresh chat turn — the
			// agent then picks the answer up from the session history.
			const questionMeta = readSessionQuestionMetadata();
			const persistedEntry = Object.entries(questionMeta).find(([, q]) => q.questionId === questionId);
			if (persistedEntry) {
				delete questionMeta[persistedEntry[0]];
				writeSessionQuestionMetadata(questionMeta);
				json(res, 200, { accepted: true, expired: true, sessionId: persistedEntry[0] });
				return true;
			}
		}
		json(res, status === "accepted" ? 200 : status === "scope_mismatch" || status === "already_resolved" ? 409 : 404, { accepted: status === "accepted" });
		return true;
	}

	if (method === "POST" && url === "/api/chat/abort") {
		json(res, 400, { error: "Scoped abort requires sessionId and turnId" });
		return true;
	}

	const chatAbortMatch = matchRoute("POST", method, url, "/api/chat/:sessionId/:turnId/abort");
	if (chatAbortMatch) {
		const state = streamRegistry.getByTurn(chatAbortMatch.turnId);
		if (!state || state.sessionId !== chatAbortMatch.sessionId) {
			json(res, 404, { error: "Chat turn not found" });
			return true;
		}
		if (state.status !== "queued" && state.status !== "running") {
			json(res, 200, { status: state.status, cancelRequested: state.cancelRequested });
			return true;
		}
		streamRegistry.requestCancel(state);
		// Resolve a parked ask_user_question before aborting: session.abort()
		// alone cannot wake the agent loop while it awaits the question
		// promise, so the turn (and its queue slot) would stay stuck until
		// the 30-minute question timeout. unbindTurn is idempotent — the
		// onFinish unbind becomes a no-op once the binding is cleared here.
		questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "cancelled" });
		if (state.status === "running") await abortPromptForTurnToken(state.turnId);
		json(res, 202, { status: state.status, cancelRequested: true });
		return true;
	}

	const chatStatusMatch = matchRoute("GET", method, url, "/api/chat/status/:sessionId");
	if (chatStatusMatch) {
		streamRegistry.cleanupExpiredTurns();
		const state = streamRegistry.getLatest(chatStatusMatch.sessionId);
		json(res, 200, state
			? { found: true, stream: streamRegistry.toPublicSnapshot(state) }
			: { found: false });
		return true;
	}

	const chatEventsMatch = matchRoute("GET", method, url, "/api/chat/events/:id");
	if (chatEventsMatch) {
		const sessionId = chatEventsMatch.id;
		const params = new URL(url, "http://localhost").searchParams;
		const turnId = params.get("turnId") ?? "";
		const after = Number.parseInt(params.get("after") ?? "0", 10);
		if (!turnId || !Number.isFinite(after) || after < 0) {
			json(res, 400, { error: "turnId and a non-negative after value are required" });
			return true;
		}
		const state = streamRegistry.getByTurn(turnId);
		if (!state || state.sessionId !== sessionId) {
			json(res, 404, { error: "Chat turn not found" });
			return true;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		let ended = false;
		const eventsHeartbeat = setInterval(() => {
			if (!ended) {
				try {
					res.write(": heartbeat\n\n");
					logger.debug({ sessionId }, "SSE event replay heartbeat sent");
				} catch (err) {
					logger.warn({ sessionId, err }, "SSE event replay heartbeat write failed");
				}
			}
		}, 15_000);
		const finishResponse = () => {
			if (ended) return;
			ended = true;
			clearInterval(eventsHeartbeat);
			res.write("data: [DONE]\n\n");
			res.end();
		};
		const unsub = streamRegistry.subscribe(state, after, (envelope) => {
			if (ended) return;
			res.write(`data: ${JSON.stringify(envelope)}\n\n`);
			if (["done", "error", "aborted"].includes(envelope.event.type)) finishResponse();
		});
		if (state.terminalEventPublished && !ended) finishResponse();
		res.on("close", () => { clearInterval(eventsHeartbeat); unsub(); });
		return true;
	}

	// --- Chat Streaming (SSE) ---
	if (method === "POST" && url === "/api/chat/stream") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const prompt = body.prompt as string | undefined;
		const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
		if (!prompt || !requestedSessionId || !clientRequestId) {
			json(res, 400, { error: "Missing prompt, sessionId or clientRequestId" });
			return true;
		}
		if (streamRegistry.getActiveForSession(requestedSessionId)) {
			json(res, 409, { error: "Session already has an active chat turn" });
			return true;
		}
		// Sending in a different session implicitly abandons another
		// session's unanswered question card — release the queue (issue #124).
		releaseQueueFromQuestionBlockedTurn(requestedSessionId);
		const targetSessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
		if (!targetSessionPath || !existsSync(targetSessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const streamWorkspaceId = workspaceRegistry.getSessionWorkspaceId(requestedSessionId);
		const streamWorkspaceRoot = workspaceRegistry.resolveWorkspaceDir(streamWorkspaceId);
		if (!streamWorkspaceRoot) {
			json(res, 404, { error: "Session workspace not found" });
			return true;
		}
		const rawImages = Array.isArray(body.images) ? body.images : [];
		const images = rawImages
			.filter((img): img is { data: string; mimeType: string } =>
				img && typeof img.data === "string" && typeof img.mimeType === "string")
			.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
		// Persist inline images to the workspace so file-path tools (ocr_image,
		// parse_document) can read them when the chat model can't see images.
		const imagePaths = persistInlineImages(images, streamWorkspaceRoot);
		// Sent only when the images can't reach the model natively (text-only
		// model or provider rejection); vision turns get the raw prompt so
		// they aren't steered toward ocr_image.
		const imageFallbackPrompt = prependImagePathsHint(prompt, imagePaths);
		const imageArgs = images.length ? images : undefined;
		// Structured attachments (bubble bindings + loose files): validated
		// against the session workspace; the model sees them as a context block
		// appended via transformContext while the persisted prompt stays raw.
		const parsedStreamAttachments = parseChatAttachments(body.attachments);
		const streamAttachments = parsedStreamAttachments
			? validateChatAttachments(parsedStreamAttachments, streamWorkspaceRoot)
			: null;
		const attachmentContext = streamAttachments ? buildAttachmentContext(streamAttachments) : "";
		const baseline = readSessionBaseline(parseSessionFile, sessionRevision, targetSessionPath);
		let state: SessionStreamState;
		try {
			state = streamRegistry.createTurn({
				sessionId: requestedSessionId,
				clientRequestId,
				workspaceId: streamWorkspaceId,
				workspaceRoot: streamWorkspaceRoot,
				inputSnapshot: {
					prompt,
					submittedAt: new Date().toISOString(),
					images: imagePaths.map((workspacePath, index) => ({ mimeType: images[index]?.mimeType ?? "image/png", workspacePath })),
					attachments: streamAttachments ?? undefined,
				},
				baselineMessageCount: baseline.messageCount,
				baselineSessionRevision: baseline.revision,
			});
		} catch {
			json(res, 409, { error: "Session already has an active chat turn" });
			return true;
		}
		// Accepted — record sidecar metadata for the session-detail merge. Even
		// if this turn later fails, an unmatched entry is inert.
		recordAgentCommandIfPresent(dataDir, requestedSessionId, prompt);
		if (streamAttachments) {
			recordSessionAttachments(dataDir, requestedSessionId, {
				promptContent: prompt,
				attachments: streamAttachments,
				timestamp: Date.now(),
			});
		}
		streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "queued" });

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});

		let disconnected = false;
		let responseEnded = false;

		const heartbeatInterval = setInterval(() => {
			if (!disconnected && !responseEnded) {
				try {
					res.write(": heartbeat\n\n");
					logger.debug({ sessionId: requestedSessionId, turnId: state.turnId }, "SSE heartbeat sent");
				} catch (err) {
					logger.warn({ sessionId: requestedSessionId, turnId: state.turnId, err }, "SSE heartbeat write failed");
				}
			}
		}, 15_000);
		const finishResponse = () => {
			if (responseEnded || disconnected) return;
			responseEnded = true;
			clearInterval(heartbeatInterval);
			res.write("data: [DONE]\n\n");
			res.end();
		};
		const unsubscribeResponse = streamRegistry.subscribe(state, 0, (envelope) => {
			if (disconnected || responseEnded) return;
			res.write(`data: ${JSON.stringify(envelope)}\n\n`);
			if (["done", "error", "aborted"].includes(envelope.event.type)) finishResponse();
		});
		res.on("close", () => {
			disconnected = true;
			clearInterval(heartbeatInterval);
			unsubscribeResponse();
		});

		let workspaceChangeMonitor: ReturnType<typeof createWorkspaceChangeMonitor> = null;
		const closeWorkspaceChangeMonitor = () => workspaceChangeMonitor?.close();

		// Track whether the model API surfaced an error this turn. The PI SDK
		// does NOT throw on model API errors (e.g. HTTP 413 from an over-long
		// context) — it converts them into a terminal assistant message with
		// stopReason "error" + errorMessage, delivered via message_end. If we
		// don't forward that, runPromptStreaming resolves with empty text and
		// the UI shows nothing. So we detect it here and emit an error event.
		let promptStartTime = 0;
		const onEvent = (event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => {
			// Logging regardless of aborted state
			switch (event.type) {
				case "message_update": {
					const ev = event.assistantMessageEvent;
					if (ev.type === "error") {
						const errorMsg = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
						logger.error({ errorMessage: errorMsg, stopReason: ev.error.stopReason, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error event");
					}
					break;
				}
				case "message_end": {
					const msg = event.message;
					if (
						msg && typeof msg === "object" && "stopReason" in msg &&
						(msg as { stopReason?: string }).stopReason === "error"
					) {
						const detail = (msg as { errorMessage?: string }).errorMessage;
						const errorMsg = detail || "The model request failed.";
						logger.error({ stopReason: "error", errorMessage: errorMsg, message: msg, elapsedMs: Date.now() - promptStartTime }, "Model request failed (message_end stopReason=error)");
					}
					break;
				}
					case "tool_execution_start":
						logger.info(
							{ toolName: event.toolName, toolCallId: event.toolCallId },
							"tool call started: %s", event.toolName,
						);
						break;
					case "tool_execution_update":
						// Partial tool output is forwarded to the stream registry below.
						// Do not report these normal progress events as unhandled.
						break;
					case "tool_execution_end":
					workspaceChangeMonitor?.noteToolEnd(event.toolCallId, event.toolName);
					if (event.isError) {
						const errText = Array.isArray(event.result?.content)
							? event.result.content.map((c: { text?: string }) => c.text ?? "").join(" ").slice(0, 500)
							: String(event.result?.content ?? "").slice(0, 500);
						logger.warn(
							{ toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
							"tool call failed: %s — %s",
							event.toolName,
							errText || "(no error text)",
						);
					} else {
						logger.info(
							{ toolName: event.toolName, toolCallId: event.toolCallId },
							"tool call completed: %s", event.toolName,
						);
					}
					break;
				case "auto_retry_start":
					logger.warn({ attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage, elapsedMs: Date.now() - promptStartTime }, "LLM API call failed, auto-retrying...");
					break;
				case "auto_retry_end":
					if (!event.success) {
						logger.error({ finalError: event.finalError, elapsedMs: Date.now() - promptStartTime }, "LLM API auto-retry failed");
					}
					break;
				default:
					logger.info({ eventType: (event as { type?: string }).type }, "unhandled SSE event type: %s", (event as { type?: string }).type);
					break;
			}

			// Convert to an SSE event and publish to broadcaster + live client.
			const sseEvent = piEventToSseEvent(event);
			if (sseEvent) {
				const piEventType = event.type === "message_update" && event.assistantMessageEvent?.type
					? event.assistantMessageEvent.type
					: event.type;
				const normalizedEvent = sseEvent as { type: string; [key: string]: unknown };
				streamRegistry.publishStreamEvent(state, { ...normalizedEvent, piEventType });
			}
		};

		promptStartTime = Date.now();
		try {
			await runPromptStreamingInSession(targetSessionPath, prompt, onEvent, imageArgs, {
				token: state.turnId,
				shouldStart: () => !state.cancelRequested,
				isCancellationRequested: () => state.cancelRequested,
				onStart: () => {
					streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "running" });
					const traceSkills = loadedSkillsForTrace(streamWorkspaceRoot);
					streamRegistry.publishStreamEvent(state, {
						type: "skill_loaded",
						count: traceSkills.length,
						skills: traceSkills,
					});
					const skillEvent = explicitSkillEvent(prompt, traceSkills);
					if (skillEvent) streamRegistry.publishStreamEvent(state, skillEvent as { type: string });
					questionBridge.bindTurn({
						sessionId: state.sessionId,
						turnId: state.turnId,
						emit: (event) => streamRegistry.publishStreamEvent(state, event),
						timeoutMs: 30 * 60_000,
					});
					workspaceChangeMonitor = createWorkspaceChangeMonitor(streamWorkspaceRoot, (event) => {
						streamRegistry.publishStreamEvent(state, event as { type: string });
					});
				},
				onFinish: async (outcome) => {
					if (outcome.type === "aborted" && outcome.reason === "cancelled_before_start") {
						persistCancelledQueuedTurn(prompt, state.sessionId, imageArgs);
					} else if (outcome.type !== "completed") {
						persistPendingUserTurn(state.sessionId);
					}
					const persistence = confirmTurnPersistence(parseSessionFile, sessionRevision, state, targetSessionPath, outcome);
					questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: outcome.type });
					closeWorkspaceChangeMonitor();
					workspaceChangeMonitor = null;
					recordCurrentSessionChannel("web", state.sessionId, { setOriginIfEmpty: true });
					if (outcome.type === "completed" && persistence.persisted) {
						streamRegistry.finishTurn(state, "completed", { type: "done", fullText: outcome.fullText }, persistence);
						maybeAutoGenerateTopic(state.sessionId);
					} else if (outcome.type === "completed") {
						streamRegistry.finishTurn(state, "error", { type: "error", message: "Final chat history could not be confirmed.", code: "persistence_confirmation_failed" }, persistence);
					} else if (outcome.type === "aborted") {
						const message = outcome.reason === "cancelled"
							? "Stopped by user"
							: `Prompt aborted: ${outcome.reason}`;
						streamRegistry.finishTurn(state, "aborted", { type: "aborted", message }, persistence);
					} else {
						const message = outcome.error instanceof Error ? outcome.error.message : "Unknown error";
						if (state.status === "queued") {
							streamRegistry.finishTurn(state, "aborted", { type: "aborted", message: `Prompt failed before start: ${message}` }, persistence);
						} else {
							streamRegistry.finishTurn(state, "error", { type: "error", message }, persistence);
						}
					}
					// Record the trace after the terminal event is published so historical
					// messages can distinguish a normal completion from an abort or error.
					if (persistence.persisted && state.history.length > 0) {
						try {
							const persistedMessages = parseSessionFile(targetSessionPath)?.messages ?? [];
							const assistantMessage = persistedMessages[state.baselineMessageCount + 1];
							recordSessionTrace(dataDir, state.sessionId, {
								assistantIndex: state.baselineMessageCount + 1,
								assistantMessageId: assistantMessage?.role === "assistant" ? assistantMessage.entryId : undefined,
								startedAt: state.startedAt,
								finishedAt: state.finishedAt ?? new Date().toISOString(),
								events: state.history,
							});
						} catch (err) {
							// Trace is observability metadata. Never turn a successful PI
							// response into a failed chat turn because the sidecar is unwritable.
							logger.warn({ err, sessionId: state.sessionId, turnId: state.turnId }, "chat trace sidecar write failed");
						}
					}
				},
				onFinalizeFailure: async (outcome, error) => {
					try {
						logger.error({ error, outcome: outcome.type, sessionId: state.sessionId, turnId: state.turnId }, "chat turn finalization failed");
					} catch {
						// Observability must not block the forced terminal path.
					}
					try {
						questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "finalization_failed" });
					} catch {
						// Continue to the unique terminal event even if question cleanup fails.
					}
					try {
						closeWorkspaceChangeMonitor();
					} catch {
						// Continue to the unique terminal event even if monitor cleanup fails.
					}
					workspaceChangeMonitor = null;
					if (!state.terminalEventPublished) {
						const message = error instanceof Error ? error.message : "Finalization failed";
						if (state.status === "queued") {
							streamRegistry.finishTurn(state, "aborted", { type: "aborted", message: `Prompt failed before start: ${message}` }, { persisted: false });
						} else {
							streamRegistry.finishTurn(state, "error", { type: "error", message, code: "finalization_failed" }, { persisted: false });
						}
					}
				},
			}, streamWorkspaceRoot, imageFallbackPrompt, attachmentContext || undefined);
		} catch (err) {
			logger.error({ err, sessionId: state.sessionId, turnId: state.turnId }, "SSE chat turn failed");
		} finally {
			clearInterval(heartbeatInterval);
			closeWorkspaceChangeMonitor();
			unsubscribeResponse();
			streamRegistry.cleanupExpiredTurns();
		}
		finishResponse();
		return true;
	}

	return false;
}
