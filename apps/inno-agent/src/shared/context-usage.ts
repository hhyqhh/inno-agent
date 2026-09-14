/** Aggregate-only payload: never expose prompt text, tool schemas or message content. */
export interface SessionContextUsage {
	sessionId: string;
	status: "ready" | "pending" | "inactive" | "unavailable";
	source: "sdk" | "estimated";
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	breakdown: Array<{
		id: "system" | "tools" | "messages" | "mcp" | "skills";
		tokens: number;
		percent: number;
	}>;
}
