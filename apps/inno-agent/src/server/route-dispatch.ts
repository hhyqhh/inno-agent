import type { IncomingMessage, ServerResponse } from "node:http";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, method: string, url: string) => Promise<boolean>;

export type RouteHandlers = Record<
	| "checkins" | "jobs" | "channels" | "skills" | "sessions" | "search" | "wiki" | "learner"
	| "workspaces" | "presets" | "practice" | "settings" | "commands" | "btw" | "chat",
	RouteHandler
>;

export function createRouteDispatcher(handlers: RouteHandlers) {
	const registry = [
		{ prefix: "/api/checkins", handler: handlers.checkins },
		{ prefix: "/api/jobs", handler: handlers.jobs },
		{ prefix: "/api/channels", handler: handlers.channels },
		{ prefix: "/api/bridge", handler: handlers.channels },
		{ prefix: "/api/skills", handler: handlers.skills },
		{ prefix: "/api/skill-library", handler: handlers.skills },
		{ prefix: "/api/sessions", handler: handlers.sessions },
		// Keep the WIP unified-search route reachable after the prefix-dispatch merge.
		{ prefix: "/api/search", handler: handlers.search },
		{ prefix: "/api/wiki", handler: handlers.wiki },
		{ prefix: "/api/l2", handler: handlers.wiki },
		{ prefix: "/api/learner", handler: handlers.learner },
		{ prefix: "/api/workspace", handler: handlers.workspaces },
		{ prefix: "/api/workspaces", handler: handlers.workspaces },
		// Preserve the old chain's sessions -> workspaces order. Sessions must
		// decline before workspaces handles /api/sessions/:id/workspace[/...].
		{ prefix: "/api/sessions", handler: handlers.workspaces },
		{ prefix: "/api/presets", handler: handlers.presets },
		{ prefix: "/api/preset-library", handler: handlers.presets },
		{ prefix: "/api/terminal", handler: handlers.practice },
		{ prefix: "/api/runs", handler: handlers.practice },
		{ prefix: "/api/settings", handler: handlers.settings },
		{ prefix: "/api/mcp", handler: handlers.settings },
		{ prefix: "/api/commands", handler: handlers.commands },
		{ prefix: "/api/btw", handler: handlers.btw },
		{ prefix: "/api/chat", handler: handlers.chat },
	];
	const byPrefix = new Map<string, RouteHandler[]>();
	for (const { prefix, handler } of registry) {
		const candidates = byPrefix.get(prefix) ?? [];
		candidates.push(handler);
		byPrefix.set(prefix, candidates);
	}

	const dispatch: RouteHandler = async (req, res, method, url) => {
		// Strip only the query for lookup; handlers receive the original URL.
		// Whole path segments keep /api/workspace and /api/workspaces distinct.
		const prefix = url.split("?", 1)[0].split("/", 3).join("/");
		for (const handler of byPrefix.get(prefix) ?? []) {
			if (await handler(req, res, method, url)) return true;
		}
		return false;
	};
	return { registry, dispatch };
}

/** Data routes stay usable while extension/MCP startup runs in the background. */
export function requiresAgent(method: string, url: string): boolean {
	const path = url.split("?", 1)[0];
	if (method === "GET") return path === "/api/commands";
	if (method !== "POST") return false;
	return ["/api/chat", "/api/chat/stream", "/api/sessions", "/api/btw/ask", "/api/btw/bring-back", "/api/bridge/messages"].includes(path)
		|| /^\/api\/sessions\/[^/]+\/(activate|branch-before-message|generate-topic)$/.test(path)
		|| /^\/api\/jobs\/[^/]+\/run(?:\/stream)?$/.test(path);
}
