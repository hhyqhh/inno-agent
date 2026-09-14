import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionContextUsage } from "../shared/context-usage.js";

type ContextSession = Pick<AgentSession, "getContextUsage" | "systemPrompt" | "messages" | "getAllTools" | "getActiveToolNames">;

export function unavailableContextUsage(sessionId: string, status: "inactive" | "unavailable"): SessionContextUsage {
	return { sessionId, status, source: "sdk", tokens: null, contextWindow: null, percent: null, breakdown: [] };
}

/** Categories are heuristic weights, calibrated to the SDK's current context total.
 * Tool results stay in messages; tool schemas are counted only once. MCP attribution
 * uses extension provenance as well as names (direct MCP tools can have any prefix).
 */
export function buildContextUsage(sessionId: string, session: ContextSession): SessionContextUsage {
	const usage = session.getContextUsage();
	if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
		return unavailableContextUsage(sessionId, "unavailable");
	}
	const base = { sessionId, contextWindow: usage.contextWindow };
	if (usage.tokens === null) {
		return { ...base, status: "pending", source: "sdk", tokens: null, percent: null, breakdown: [] };
	}
	const weights = { system: 0, tools: 0, messages: 0, mcp: 0, skills: 0 };
	const estimateText = (text: string) => Math.ceil(text.length / 4);
	const prompt = session.systemPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, (block) => {
		weights.skills += estimateText(block);
		return "";
	});
	weights.system = estimateText(prompt);
	const active = new Set(session.getActiveToolNames());
	for (const tool of session.getAllTools()) {
		if (!active.has(tool.name)) continue;
		const provenance = `${tool.sourceInfo?.path ?? ""} ${tool.sourceInfo?.source ?? ""}`;
		const category = /^mcp(?:_|$)/i.test(tool.name) || /pi-mcp-adapter/.test(provenance) ? "mcp" : "tools";
		weights[category] += estimateText(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	}
	for (const message of session.messages) weights.messages += estimateTokens(message);
	const entries = Object.entries(weights) as Array<[keyof typeof weights, number]>;
	const weightTotal = entries.reduce((sum, [, value]) => sum + value, 0);
	// Before the first successful provider response the SDK only estimates messages,
	// omitting the system prompt and schemas. Include them in the initial estimate.
	const hasUsage = session.messages.some((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted"
		&& m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0);
	const rawTotal = hasUsage ? usage.tokens : weightTotal;
	if (!Number.isFinite(rawTotal) || rawTotal < 0) return unavailableContextUsage(sessionId, "unavailable");
	const tokens = Math.round(rawTotal);
	// Largest-remainder allocation keeps the category tokens equal to the total.
	const parts = entries.map(([id, weight]) => {
		const exact = weightTotal ? tokens * weight / weightTotal : (id === "messages" ? tokens : 0);
		return { id, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	let remaining = tokens - parts.reduce((sum, part) => sum + part.tokens, 0);
	for (const part of [...parts].sort((a, b) => b.remainder - a.remainder)) {
		if (remaining-- > 0) part.tokens++;
	}
	return {
		...base, status: "ready", source: hasUsage ? "sdk" : "estimated", tokens,
		percent: tokens / usage.contextWindow * 100,
		breakdown: parts.map(({ id, tokens }) => ({ id, tokens, percent: tokens / usage.contextWindow * 100 })),
	};
}
