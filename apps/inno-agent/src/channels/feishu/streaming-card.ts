/**
 * Manages a single streaming card session for a Feishu message.
 * Handles throttled updates, state accumulation, and graceful finalization.
 */
import { FeishuAPI, type StreamingCardState } from "./feishu-api.js";
import { logger } from "../../logger.js";

const UPDATE_INTERVAL_MS = 800; // throttle card patches to avoid rate limits (5 QPS)
const MIN_DELTA_CHARS = 20; // don't update for trivial deltas

export interface StreamingCardSession {
	/** Append text to the answer section. */
	appendAnswer(delta: string): void;
	/** Append text to the thinking section. */
	appendThinking(delta: string): void;
	/** Record a tool call starting. */
	toolStart(name: string, id?: string): void;
	/** Record a tool call completed. */
	toolEnd(id: string, isError?: boolean, summary?: string): void;
	/** Mark the card as errored. */
	setError(message: string): void;
	/** Finalize the card (last update with complete state). */
	finalize(): Promise<void>;
}

export function createStreamingCardSession(
	api: FeishuAPI,
	cardMessageId: string,
): StreamingCardSession {
	const state: StreamingCardState = {
		answerText: "",
		thinkingText: "",
		toolCalls: [],
		isComplete: false,
	};

	// Track tool calls by ID for matching start/end
	const toolIdMap = new Map<string, number>(); // id -> index in toolCalls

	let updateTimer: ReturnType<typeof setTimeout> | null = null;
	let lastUpdateLen = 0;
	let updateInFlight = false;

	async function flushUpdate(): Promise<void> {
		if (updateInFlight) return;
		updateInFlight = true;
		try {
			const card = api.buildStreamingCard(state);
			await api.patchCard(cardMessageId, card);
			lastUpdateLen = state.answerText.length + state.thinkingText.length;
		} catch (err) {
			logger.warn({ err, cardMessageId }, "[feishu-streaming] card patch failed");
		} finally {
			updateInFlight = false;
		}
	}

	function scheduleUpdate(): void {
		if (updateTimer) return;
		const currentLen = state.answerText.length + state.thinkingText.length;
		if (currentLen - lastUpdateLen < MIN_DELTA_CHARS) return;

		updateTimer = setTimeout(() => {
			updateTimer = null;
			void flushUpdate();
		}, UPDATE_INTERVAL_MS);
	}

	return {
		appendAnswer(delta: string): void {
			state.answerText += delta;
			scheduleUpdate();
		},

		appendThinking(delta: string): void {
			state.thinkingText += delta;
			scheduleUpdate();
		},

		toolStart(name: string, id?: string): void {
			const idx = state.toolCalls.length;
			state.toolCalls.push({ name, status: "running" });
			if (id) toolIdMap.set(id, idx);
			// Tool start is important — flush immediately
			void flushUpdate();
		},

		toolEnd(id: string, isError?: boolean, summary?: string): void {
			const idx = toolIdMap.get(id);
			if (idx !== undefined && state.toolCalls[idx]) {
				state.toolCalls[idx].status = isError ? "error" : "done";
				if (summary) state.toolCalls[idx].summary = summary;
			}
			void flushUpdate();
		},

		setError(message: string): void {
			state.error = message;
			void flushUpdate();
		},

		async finalize(): Promise<void> {
			// Clear any pending timer
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
			state.isComplete = true;
			// Final update
			try {
				const card = api.buildStreamingCard(state);
				await api.patchCard(cardMessageId, card);
			} catch (err) {
				logger.warn({ err, cardMessageId }, "[feishu-streaming] final card patch failed");
			}
		},
	};
}
