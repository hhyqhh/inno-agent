import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendAssistantNotificationInSession, completeSideQuestion } from "../../agent/pi-runner.js";
import { json, readBody } from "../http-helpers.js";
import { logger } from "../../logger.js";
import type { SessionMessageSummary } from "../session-model.js";

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

export async function handleBtwRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: BtwRouteContext,
): Promise<boolean> {
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
		const sessionPath = ctx.sessionFileFromId(join(ctx.dataDir, "sessions"), sessionId);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = ctx.parseSessionFile(sessionPath);
		const digest = parsed ? buildBtwContextDigest(parsed.messages) : "";
		const answer = await completeSideQuestion({ contextDigest: digest, thread, question });
		if (!answer) {
			json(res, 502, { error: "Side question completion failed or timed out" });
			return true;
		}
		json(res, 200, { answer });
		return true;
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
		const sessionPath = ctx.sessionFileFromId(join(ctx.dataDir, "sessions"), sessionId);
		if (!sessionPath || !existsSync(sessionPath)) {
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
