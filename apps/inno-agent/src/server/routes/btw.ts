import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendAssistantNotificationInSession, completeSideQuestion } from "../../agent/pi-runner.js";
import { json, matchRoute, readBody } from "../http-helpers.js";
import { logger } from "../../logger.js";
import type { SessionMessageSummary } from "../session-model.js";
import {
	readBtwState,
	writeBtwState,
	type BtwExchangeState,
	type BtwSessionState,
	type BtwStateResponse,
	type BtwTabState,
} from "../btw-store.js";

/**
 * /api/btw route domain — "顺便问问" side-question channel.
 *
 * A btw answer is a stateless side-channel completion (completeSideQuestion):
 * it never touches the session file, never enters the shared prompt queue,
 * and has no tools. The only write path is /api/btw/bring-back, which appends
 * a confirmed Q/A pair to the main session as an assistant notification so
 * the agent can build on it later.
 */

export interface BtwRouteContext {
	dataDir: string;
	sessionFileFromId: (sessionDir: string, id: string) => string | null;
	parseSessionFile: (filePath: string) => { messages: SessionMessageSummary[] } | null;
}

const MAX_QUESTION_LEN = 4000;
const MAX_THREAD_TURNS = 20;
/** Recent messages sampled into the digest, and per-message truncation. */
const DIGEST_MESSAGE_COUNT = 12;
const DIGEST_MESSAGE_MAX_CHARS = 800;

interface BtwThreadTurn {
	question: string;
	answer: string;
}

/** Build the read-only digest of the conversation the side question refers to. */
export function buildBtwContextDigest(messages: SessionMessageSummary[]): string {
	const recent = messages
		.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
		.slice(-DIGEST_MESSAGE_COUNT);
	if (!recent.length) return "";
	const lines = recent.map((m) => {
		const who = m.role === "user" ? "学生" : "助教";
		const text = m.content.length > DIGEST_MESSAGE_MAX_CHARS
			? `${m.content.slice(0, DIGEST_MESSAGE_MAX_CHARS)}…`
			: m.content;
		return `${who}: ${text}`;
	});
	return [
		"以下是主线学习对话的最近片段(只读参考,不是本次对话的一部分):",
		"",
		...lines,
		"",
		"以上仅供你理解上下文。接下来的问答不会进入主线对话。",
	].join("\n");
}

function readThread(raw: unknown): BtwThreadTurn[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const thread: BtwThreadTurn[] = [];
	for (const item of raw.slice(-MAX_THREAD_TURNS)) {
		if (!item || typeof item !== "object") return null;
		const { question, answer } = item as Record<string, unknown>;
		if (typeof question !== "string" || typeof answer !== "string" || !question.trim() || !answer.trim()) return null;
		thread.push({ question: question.slice(0, MAX_QUESTION_LEN), answer: answer.slice(0, 16_000) });
	}
	return thread;
}

function formatBtwForSession(question: string, answer: string): string {
	return [
		"📌 旁注问答(学生在“顺便问问”中确认过的内容,供后续参考):",
		"",
		`Q: ${question}`,
		"",
		`A: ${answer}`,
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseExchange(raw: unknown): BtwExchangeState | null {
	if (!isRecord(raw)) return null;
	if (
		typeof raw.id !== "string" || !raw.id ||
		typeof raw.question !== "string" ||
		typeof raw.answer !== "string" ||
		(raw.status !== "pending" && raw.status !== "done" && raw.status !== "error")
	) return null;
	return {
		id: raw.id,
		question: raw.question,
		answer: raw.answer,
		status: raw.status,
		...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
		...(raw.broughtBack === true ? { broughtBack: true } : {}),
	};
}

function parseTab(raw: unknown): BtwTabState | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || !finiteNumber(raw.number) || raw.number < 1) return null;
	if (typeof raw.draft !== "string" || !finiteNumber(raw.scrollTop) || !Array.isArray(raw.exchanges)) return null;
	const exchanges = raw.exchanges.map(parseExchange);
	if (exchanges.some((exchange) => exchange === null)) return null;
	return {
		id: raw.id,
		number: Math.floor(raw.number),
		draft: raw.draft,
		scrollTop: Math.max(0, raw.scrollTop),
		exchanges: exchanges as BtwExchangeState[],
	};
}

function parseSessionState(raw: unknown): BtwSessionState | null {
	if (!isRecord(raw) || !finiteNumber(raw.nextTabNumber) || raw.nextTabNumber < 1 || !Array.isArray(raw.tabs)) return null;
	const tabs = raw.tabs.map(parseTab);
	if (tabs.some((tab) => tab === null)) return null;
	if (raw.activeTabId !== null && typeof raw.activeTabId !== "string") return null;
	return {
		nextTabNumber: Math.floor(raw.nextTabNumber),
		activeTabId: raw.activeTabId,
		tabs: tabs as BtwTabState[],
	};
}

function parseStatePayload(raw: unknown): BtwStateResponse | null {
	if (!isRecord(raw) || !isRecord(raw.window)) return null;
	const session = parseSessionState(raw.session);
	if (!session) return null;
	const window = raw.window;
	if (!finiteNumber(window.x) || !finiteNumber(window.y) || !finiteNumber(window.width) || !finiteNumber(window.height)) return null;
	if (window.width < 1 || window.height < 1 || typeof raw.windowInitialized !== "boolean" || typeof raw.minimized !== "boolean") return null;
	return {
		session,
		window: { x: window.x, y: window.y, width: window.width, height: window.height },
		windowInitialized: raw.windowInitialized,
		minimized: raw.minimized,
	};
}

function sessionPathFor(ctx: BtwRouteContext, sessionId: string): string | null {
	const sessionPath = ctx.sessionFileFromId(join(ctx.dataDir, "sessions"), sessionId);
	return sessionPath && existsSync(sessionPath) ? sessionPath : null;
}

function attachAbortSignal(req: HttpReq, res: ServerResponse): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const onRequestClose = () => {
		// A normal request can emit close after its body has been read. Only treat
		// an incomplete request as a client disconnect here.
		if (req.complete === false) abort();
	};
	const onResponseClose = () => {
		if (!res.writableEnded) abort();
	};
	req.once("aborted", abort);
	req.once("close", onRequestClose);
	if (typeof res.once === "function") res.once("close", onResponseClose);
	return {
		signal: controller.signal,
		cleanup: () => {
			req.removeListener("aborted", abort);
			req.removeListener("close", onRequestClose);
			if (typeof res.removeListener === "function") res.removeListener("close", onResponseClose);
		},
	};
}

export async function handleBtwRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: BtwRouteContext,
): Promise<boolean> {
	const stateMatch = matchRoute("GET", method, url, "/api/btw/state/:sessionId")
		?? matchRoute("PUT", method, url, "/api/btw/state/:sessionId");
	if (stateMatch) {
		const sessionId = stateMatch.sessionId;
		if (!sessionPathFor(ctx, sessionId)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (method === "GET") {
			json(res, 200, readBtwState(ctx.dataDir, sessionId));
			return true;
		}
		const body = await readBody(req);
		const parsed = parseStatePayload(body);
		if (!parsed) {
			json(res, 400, { error: "Malformed btw state" });
			return true;
		}
		json(res, 200, writeBtwState(ctx.dataDir, sessionId, parsed));
		return true;
	}

	if (method === "POST" && url === "/api/btw/ask") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const question = typeof body.question === "string" ? body.question.trim() : "";
		const thread = readThread(body.thread);
		if (!sessionId || !question || !thread) {
			json(res, 400, { error: "Missing sessionId/question, or malformed thread" });
			return true;
		}
		if (question.length > MAX_QUESTION_LEN) {
			json(res, 400, { error: `question too long (max ${MAX_QUESTION_LEN} chars)` });
			return true;
		}
		const sessionPath = sessionPathFor(ctx, sessionId);
		if (!sessionPath) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = ctx.parseSessionFile(sessionPath);
		const digest = parsed ? buildBtwContextDigest(parsed.messages) : "";
		const requestAbort = attachAbortSignal(req, res);
		try {
			const answer = await completeSideQuestion({ contextDigest: digest, thread, question, signal: requestAbort.signal });
			if (requestAbort.signal.aborted) return true;
			if (!answer) {
				json(res, 502, { error: "Side question completion failed or timed out" });
				return true;
			}
			json(res, 200, { answer });
			return true;
		} finally {
			requestAbort.cleanup();
		}
	}

	if (method === "POST" && url === "/api/btw/bring-back") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const question = typeof body.question === "string" ? body.question.trim() : "";
		const answer = typeof body.answer === "string" ? body.answer.trim() : "";
		if (!sessionId || !question || !answer) {
			json(res, 400, { error: "Missing sessionId, question or answer" });
			return true;
		}
		const sessionPath = sessionPathFor(ctx, sessionId);
		if (!sessionPath) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		try {
			await appendAssistantNotificationInSession(sessionPath, formatBtwForSession(question, answer));
		} catch (err) {
			logger.warn({ err, sessionId }, "btw bring-back failed");
			json(res, 500, { error: "Failed to append the note to the session" });
			return true;
		}
		json(res, 200, { ok: true });
		return true;
	}

	return false;
}
