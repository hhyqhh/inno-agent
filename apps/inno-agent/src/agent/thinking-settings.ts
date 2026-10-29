import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function parseThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (!THINKING_LEVELS.includes(value as ModelThinkingLevel)) throw new Error("Invalid thinkingLevel");
	return value as ModelThinkingLevel;
}

// Like the agent's ConfigHolder, this resolver is process-local. The callback
// reads live config after provider edits; no keys or copied config are stored.
let resolvePreference: (model: Pick<Model<any>, "provider" | "id">) => ModelThinkingLevel | undefined = () => undefined;
export function setThinkingLevelResolver(resolver: typeof resolvePreference): void { resolvePreference = resolver; }
export function getConfiguredThinkingLevel(model: Pick<Model<any>, "provider" | "id">): ModelThinkingLevel | undefined { return resolvePreference(model); }

/** SDK hides extended levels on unknown custom models unless explicitly mapped.
 * A manual choice opts into that value; it is NOT capability detection. */
export function manualThinkingLevelMap(level?: ModelThinkingLevel) {
	return level === "xhigh" || level === "max" ? { [level]: level } : undefined;
}
