import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createRouteDispatcher, requiresAgent, type RouteHandlers } from "./route-dispatch.js";

const routesDir = join(import.meta.dirname, "routes");
// Fonts is a settings sub-handler; its HTTP routes are tested in fonts.test.ts.
const routeFiles = readdirSync(routesDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "fonts.ts");
const req = {} as IncomingMessage;
const res = {} as ServerResponse;

function makeHandlers() {
	return {
		checkins: vi.fn<RouteHandlers["checkins"]>().mockResolvedValue(false),
		jobs: vi.fn<RouteHandlers["jobs"]>().mockResolvedValue(false),
		channels: vi.fn<RouteHandlers["channels"]>().mockResolvedValue(false),
		skills: vi.fn<RouteHandlers["skills"]>().mockResolvedValue(false),
		sessions: vi.fn<RouteHandlers["sessions"]>().mockResolvedValue(false),
		search: vi.fn<RouteHandlers["search"]>().mockResolvedValue(false),
		wiki: vi.fn<RouteHandlers["wiki"]>().mockResolvedValue(false),
		learner: vi.fn<RouteHandlers["learner"]>().mockResolvedValue(false),
		workspaces: vi.fn<RouteHandlers["workspaces"]>().mockResolvedValue(false),
		presets: vi.fn<RouteHandlers["presets"]>().mockResolvedValue(false),
		practice: vi.fn<RouteHandlers["practice"]>().mockResolvedValue(false),
		settings: vi.fn<RouteHandlers["settings"]>().mockResolvedValue(false),
		commands: vi.fn<RouteHandlers["commands"]>().mockResolvedValue(false),
		btw: vi.fn<RouteHandlers["btw"]>().mockResolvedValue(false),
		chat: vi.fn<RouteHandlers["chat"]>().mockResolvedValue(false),
	} satisfies RouteHandlers;
}

function routePatterns(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(join(routesDir, file), "utf8"), ts.ScriptTarget.Latest, true);
	const patterns = new Set<string>();
	const visit = (node: ts.Node): void => {
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.startsWith("/api/")) {
			patterns.add(node.text);
		} else if (ts.isTemplateExpression(node) && node.head.text.startsWith("/api/")) {
			patterns.add(node.head.text + node.templateSpans.map((span) => "route-probe" + span.literal.text).join(""));
		} else if (ts.isRegularExpressionLiteral(node)) {
			// The settings model-delete route uses an anchored regex instead of
			// matchRoute. Replace its variable path segments with a concrete ID.
			const pattern = node.text.slice(1, node.text.lastIndexOf("/")).replaceAll("\\/", "/");
			if (pattern.startsWith("^/api/")) {
				patterns.add(pattern.replace(/^\^|\$$/g, "").replaceAll("[^/]+", "route-probe"));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...patterns].map((pattern) => pattern.replace(/:[A-Za-z]\w*/g, "route-probe"));
}

describe("route prefix dispatch", () => {
	it("registers every route domain and every registry entry covers a declared URL", () => {
		const handlers = makeHandlers();
		const { registry } = createRouteDispatcher(handlers);
		expect(routeFiles.map((file) => file.slice(0, -3)).sort()).toEqual(Object.keys(handlers).sort());
		for (const { prefix, handler } of registry) {
			const domain = Object.entries(handlers).find(([, candidate]) => candidate === handler)![0];
			expect(routePatterns(`${domain}.ts`).some((pattern) => pattern.split("?", 1)[0].split("/", 3).join("/") === prefix), prefix)
				.toBe(true);
		}
	});

	it.each(routeFiles)("dispatches every URL literal/pattern in %s to its owning handler", async (file) => {
		const handlers = makeHandlers();
		const domain = file.slice(0, -3) as keyof RouteHandlers;
		handlers[domain].mockResolvedValue(true);
		const { dispatch } = createRouteDispatcher(handlers);
		const patterns = routePatterns(file);
		expect(patterns.length).toBeGreaterThan(0);
		for (const url of patterns) {
			vi.clearAllMocks();
			expect(await dispatch(req, res, "GET", url), `${file}: ${url}`).toBe(true);
			expect(handlers[domain], url).toHaveBeenCalledExactlyOnceWith(req, res, "GET", url);
			for (const [other, handler] of Object.entries(handlers)) {
				if (other !== domain && !(domain === "workspaces" && url.startsWith("/api/sessions/"))) {
					expect(handler, `${file}: unrelated ${other} called for ${url}`).not.toHaveBeenCalled();
				}
			}
		}
	});

	it("uses the query-free prefix while passing the original URL and method to the handler", async () => {
		const handlers = makeHandlers();
		handlers.jobs.mockResolvedValue(true);
		const { dispatch } = createRouteDispatcher(handlers);
		const url = "/api/jobs?next=/api/chat&bad=%";
		expect(await dispatch(req, res, "POST", url)).toBe(true);
		expect(handlers.jobs).toHaveBeenCalledExactlyOnceWith(req, res, "POST", url);
		expect(handlers.chat).not.toHaveBeenCalled();
	});

	it("tries sessions before workspaces on their shared prefix and stops when handled", async () => {
		const handlers = makeHandlers();
		handlers.workspaces.mockResolvedValue(true);
		const { dispatch } = createRouteDispatcher(handlers);
		const url = "/api/sessions/session.jsonl/workspace/switch-preview?targetWorkspaceId=test";
		expect(await dispatch(req, res, "GET", url)).toBe(true);
		expect(handlers.sessions.mock.invocationCallOrder[0]).toBeLessThan(handlers.workspaces.mock.invocationCallOrder[0]);
		vi.clearAllMocks();
		handlers.sessions.mockResolvedValue(true);
		expect(await dispatch(req, res, "GET", "/api/sessions/session.jsonl")).toBe(true);
		expect(handlers.sessions).toHaveBeenCalledOnce();
		expect(handlers.workspaces).not.toHaveBeenCalled();
	});

	it("declines when all handlers on a known prefix decline", async () => {
		const handlers = makeHandlers();
		const { dispatch } = createRouteDispatcher(handlers);
		expect(await dispatch(req, res, "DELETE", "/api/sessions/session.jsonl/unknown")).toBe(false);
		expect(handlers.sessions).toHaveBeenCalledOnce();
		expect(handlers.workspaces).toHaveBeenCalledOnce();
		expect(handlers.chat).not.toHaveBeenCalled();
	});

	it.each(["/", "/health", "/api/health", "/api", "/assets/app.js", "/api/unknown", "/api/chatty", "/api/workspaces-extra", "/api/skill-library-extra"])(
		"leaves unmatched or special URL %s to the server skeleton",
		async (url) => {
			const handlers = makeHandlers();
			const { dispatch } = createRouteDispatcher(handlers);
			expect(await dispatch(req, res, "GET", url)).toBe(false);
			for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
		},
	);
});


describe("Agent readiness boundary", () => {
	it.each([
		["GET", "/api/sessions"], ["GET", "/api/sessions/history.jsonl"],
		["GET", "/api/sessions/history.jsonl/context-usage"],
		["GET", "/api/workspaces"], ["GET", "/api/workspace/raw?path=test.docx"],
		["GET", "/api/workspace/word-preview?path=test.docx"],
		["GET", "/api/workspace/tree"], ["GET", "/api/workspace/activity"],
		["GET", "/api/search?q=test"], ["GET", "/api/settings"],
		["POST", "/api/settings/model"], ["PUT", "/api/settings/providers"],
		["GET", "/api/jobs"], ["POST", "/api/jobs"],
		["POST", "/api/terminal"], ["GET", "/api/chat/status/history.jsonl"],
		["POST", "/api/chat/abort"], ["POST", "/api/jobs/run/stop"],
		["GET", "/api/mcp"], ["GET", "/api/skills"],
	])("does not wait for Agent: %s %s", (method, path) => {
		expect(requiresAgent(method, path)).toBe(false);
	});
	it.each([
		["GET", "/api/commands"], ["POST", "/api/chat"], ["POST", "/api/chat/stream"],
		["POST", "/api/sessions"], ["POST", "/api/sessions/a.jsonl/activate?source=history"],
		["POST", "/api/sessions/a.jsonl/branch-before-message"], ["POST", "/api/sessions/a.jsonl/generate-topic"],
		["POST", "/api/btw/ask"], ["POST", "/api/btw/bring-back"],
		["POST", "/api/bridge/messages"], ["POST", "/api/jobs/a/run"], ["POST", "/api/jobs/a/run/stream"],
	])("waits for runtime operations: %s %s", (method, path) => {
		expect(requiresAgent(method, path)).toBe(true);
	});
});
