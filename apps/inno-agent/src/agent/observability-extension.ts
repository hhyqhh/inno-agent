/**
 * Observability extension for Inno Agent.
 *
 * Subscribes to pi-coding-agent lifecycle events via the Extension system and
 * emits structured observability logs through pino.  All handlers are wrapped
 * in try-catch — observability must never affect agent execution.
 *
 * Events that are NOT available through pi.on() (auto_retry_start /
 * auto_retry_end) are covered in pi-runner.ts via session.subscribe() and
 * re-use the same obsLogger instance exported below.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Child logger — also exported so pi-runner.ts can use it for auto_retry events
// ---------------------------------------------------------------------------
export const obsLogger = logger.child({ module: "observability" });

// ---------------------------------------------------------------------------
// Duration tracking
// ---------------------------------------------------------------------------
const turnStartTimes = new Map<number, number>();
const toolStartTimes = new Map<string, number>();

function clearTrackingMaps(): void {
  turnStartTimes.clear();
  toolStartTimes.clear();
}

// ---------------------------------------------------------------------------
// Safe handler wrapper — catches all errors so observability is invisible
// to the agent loop.
// ---------------------------------------------------------------------------
function safeHandler<E>(
  eventName: string,
  handler: (event: E) => void,
): (event: E) => void {
  return (event) => {
    try {
      handler(event);
    } catch (err) {
      obsLogger.error({ err, eventName }, "observability handler error");
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract token/cost usage from an assistant message, returning null for
 *  non-assistant messages or when usage is absent. */
function extractUsage(msg: unknown): Record<string, unknown> | null {
  const m = msg as Record<string, unknown> | null | undefined;
  if (!m || m.role !== "assistant") return null;
  const usage = m.usage as Record<string, number | Record<string, number>> | undefined;
  if (!usage) return null;
  const cost = usage.cost as Record<string, number> | undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    inputCost: cost?.input,
    outputCost: cost?.output,
    cacheReadCost: cost?.cacheRead,
    cacheWriteCost: cost?.cacheWrite,
    totalCost: cost?.total,
  };
}

/** Safely read a nested property path, returning undefined for missing keys. */
function safeGet(obj: unknown, ...path: string[]): unknown {
  let cur = obj as Record<string, unknown> | null | undefined;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key] as Record<string, unknown> | null | undefined;
  }
  return cur;
}

/** First 8 chars of an id string. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------
export function createObservabilityExtension(): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    // ---- Session lifecycle ------------------------------------------------

    pi.on(
      "session_start",
      safeHandler("session_start", (event) => {
        obsLogger.info({
          event: "session_start",
          reason: event.reason,
          previousSessionFile: event.previousSessionFile ?? undefined,
        });
      }),
    );

    pi.on(
      "session_shutdown",
      safeHandler("session_shutdown", (event) => {
        clearTrackingMaps();
        obsLogger.info({
          event: "session_shutdown",
          reason: event.reason,
        });
      }),
    );

    // ---- Compaction -------------------------------------------------------

    pi.on(
      "session_before_compact",
      safeHandler("session_before_compact", (event) => {
        obsLogger.info({
          event: "session_before_compact",
          entryCount: event.branchEntries?.length ?? 0,
          hasCustomInstructions: Boolean(event.customInstructions),
        });
      }),
    );

    pi.on(
      "session_compact",
      safeHandler("session_compact", (event) => {
        obsLogger.info({
          event: "session_compact",
          fromExtension: event.fromExtension,
        });
      }),
    );

    // ---- Agent lifecycle --------------------------------------------------

    pi.on(
      "agent_start",
      safeHandler("agent_start", (_event) => {
        obsLogger.debug({
          event: "agent_start",
          timestamp: Date.now(),
        });
      }),
    );

    pi.on(
      "agent_end",
      safeHandler("agent_end", (event) => {
        obsLogger.info({
          event: "agent_end",
          messageCount: event.messages?.length ?? 0,
        });
      }),
    );

    // ---- Turn lifecycle ---------------------------------------------------

    pi.on(
      "turn_start",
      safeHandler("turn_start", (event) => {
        turnStartTimes.set(event.turnIndex, Date.now());
        obsLogger.info({
          event: "turn_start",
          turnIndex: event.turnIndex,
          timestamp: event.timestamp,
        });
      }),
    );

    pi.on(
      "turn_end",
      safeHandler("turn_end", (event) => {
        const startTime = turnStartTimes.get(event.turnIndex);
        const durationMs = startTime != null ? Date.now() - startTime : undefined;
        turnStartTimes.delete(event.turnIndex);

        const usage = extractUsage(event.message);

        obsLogger.info({
          event: "turn_end",
          turnIndex: event.turnIndex,
          toolResultsCount: event.toolResults?.length ?? 0,
          turnDurationMs: durationMs,
          ...(usage ?? {}),
        });
      }),
    );

    // ---- Message lifecycle ------------------------------------------------

    pi.on(
      "message_start",
      safeHandler("message_start", (event) => {
        const msg = event.message as unknown as Record<string, unknown> | undefined;
        const role = msg?.role;
        const logObj: Record<string, unknown> = {
          event: "message_start",
          role,
        };

        if (role === "user") {
          const content = msg?.content;
          if (Array.isArray(content)) {
            logObj.contentLength = content
              .filter((c): c is { type: "text"; text: string } => c?.type === "text")
              .reduce((sum, c) => sum + c.text.length, 0);
            logObj.hasImages = content.some((c) => c?.type === "image");
          }
        } else if (role === "assistant") {
          logObj.provider = msg?.provider;
          logObj.model = msg?.model;
        } else if (role === "toolResult") {
          logObj.toolName = msg?.toolName;
        }

        obsLogger.debug(logObj);
      }),
    );

    pi.on(
      "message_end",
      safeHandler("message_end", (event) => {
        const msg = event.message as unknown as Record<string, unknown> | undefined;
        const role = msg?.role;

        if (role === "assistant") {
          const usage = extractUsage(msg);
          const logObj: Record<string, unknown> = {
            event: "message_end",
            role: "assistant",
            provider: msg?.provider,
            model: msg?.model,
            stopReason: msg?.stopReason,
            ...(usage ?? {}),
          };

          // Error stop reasons get elevated to warn
          const errorMsg = msg?.errorMessage;
          if (typeof errorMsg === "string" && errorMsg) {
            logObj.errorMessage = errorMsg;
            obsLogger.warn(logObj);
          } else {
            obsLogger.info(logObj);
          }
        } else if (role === "user") {
          obsLogger.debug({
            event: "message_end",
            role: "user",
          });
        } else if (role === "toolResult") {
          obsLogger.debug({
            event: "message_end",
            role: "toolResult",
            toolName: msg?.toolName,
            isError: msg?.isError,
          });
        }
      }),
    );

    // ---- Tool execution ---------------------------------------------------

    pi.on(
      "tool_execution_start",
      safeHandler("tool_execution_start", (event) => {
        toolStartTimes.set(event.toolCallId, Date.now());
        obsLogger.debug({
          event: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: shortId(event.toolCallId),
        });
      }),
    );

    pi.on(
      "tool_execution_end",
      safeHandler("tool_execution_end", (event) => {
        const startTime = toolStartTimes.get(event.toolCallId);
        const durationMs = startTime != null ? Date.now() - startTime : undefined;
        toolStartTimes.delete(event.toolCallId);

        const logObj = {
          event: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: shortId(event.toolCallId),
          isError: event.isError,
          durationMs,
        };

        if (event.isError) {
          obsLogger.warn(logObj);
        } else {
          obsLogger.debug(logObj);
        }
      }),
    );

    // ---- Tool call / result (pre/post hooks) ------------------------------

    pi.on(
      "tool_call",
      safeHandler("tool_call", (event) => {
        obsLogger.debug({
          event: "tool_call",
          toolName: event.toolName,
          toolCallId: shortId(event.toolCallId),
        });
      }),
    );

    pi.on(
      "tool_result",
      safeHandler("tool_result", (event) => {
        if (!event.isError) return; // success case already covered by tool_execution_end

        const content = event.content;
        let errorSnippet: string | undefined;
        if (Array.isArray(content)) {
          const text = content
            .filter((c): c is { type: "text"; text: string } => c?.type === "text")
            .map((c) => c.text)
            .join("\n");
          errorSnippet = text.slice(0, 200) || undefined;
        }

        obsLogger.warn({
          event: "tool_result_error",
          toolName: event.toolName,
          toolCallId: shortId(event.toolCallId),
          errorSnippet,
        });
      }),
    );

    // ---- Provider request -------------------------------------------------

    let lastProviderRequestTime = 0;

    pi.on(
      "before_provider_request",
      safeHandler("before_provider_request", () => {
        lastProviderRequestTime = Date.now();
        obsLogger.debug({
          event: "before_provider_request",
        });
      }),
    );

    pi.on(
      "after_provider_response",
      safeHandler("after_provider_response", (event) => {
        const requestDurationMs =
          lastProviderRequestTime > 0 ? Date.now() - lastProviderRequestTime : undefined;

        const logObj = {
          event: "after_provider_response",
          status: event.status,
          contentType: event.headers?.["content-type"],
          requestDurationMs,
        };

        if (event.status >= 400) {
          obsLogger.warn(logObj);
        } else {
          obsLogger.info(logObj);
        }
      }),
    );

    // ---- Model / thinking level -------------------------------------------

    pi.on(
      "model_select",
      safeHandler("model_select", (event) => {
        obsLogger.info({
          event: "model_select",
          provider: event.model?.provider,
          modelId: event.model?.id,
          source: event.source,
          previousProvider: event.previousModel?.provider,
          previousModelId: event.previousModel?.id,
        });
      }),
    );

    pi.on(
      "thinking_level_select",
      safeHandler("thinking_level_select", (event) => {
        obsLogger.info({
          event: "thinking_level_select",
          level: event.level,
          previousLevel: event.previousLevel,
        });
      }),
    );

    // ---- Context / before-agent -------------------------------------------

    pi.on(
      "context",
      safeHandler("context", (event) => {
        obsLogger.debug({
          event: "context",
          messageCount: event.messages?.length ?? 0,
        });
      }),
    );

    pi.on(
      "before_agent_start",
      safeHandler("before_agent_start", (event) => {
        obsLogger.debug({
          event: "before_agent_start",
          promptLength: event.prompt?.length ?? 0,
          hasImages: Boolean(event.images?.length),
          systemPromptLength: event.systemPrompt?.length ?? 0,
        });
      }),
    );
  };
}
