import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeText } from "../../storage/file-store.js";

const indexPageByPath = vi.hoisted(() => vi.fn());
vi.mock("../../memory/l2/l2-memory.js", () => ({
	getL2Memory: () => ({ indexPageByPath, removePage: vi.fn() }),
}));

import { handleWikiRoutes } from "./wiki.js";

const roots: string[] = [];

afterEach(() => {
	indexPageByPath.mockReset();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(body?: unknown): IncomingMessage {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	const req = Readable.from(chunks) as unknown as IncomingMessage;
	req.headers = {};
	return req;
}

function response(): { res: ServerResponse; result: { status: number; body: string } } {
	const result = { status: 0, body: "" };
	const res = {
		writeHead(status: number) {
			result.status = status;
			return res;
		},
		end(body: string) {
			result.body = body;
			return res;
		},
	} as unknown as ServerResponse;
	return { res, result };
}

function page(title: string, tags: string[]): string {
	return [
		"---",
		`title: ${title}`,
		"created: 2026-08-18",
		"type: concept",
		`tags: [${tags.join(", ")}]`,
		"sources: []",
		"source_ids: []",
		"updated: 2026-08-18",
		"status: draft",
		"confidence: medium",
		"---",
		"",
		`${title} body`,
	].join("\n");
}

describe("wiki tag routes", () => {
	it("lists pages filtered by tag", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-wiki-tags-"));
		roots.push(root);
		writeText(join(root, "wiki", "concepts", "agent.md"), page("Agent", ["AI"]));
		writeText(join(root, "wiki", "concepts", "typescript.md"), page("TypeScript", ["code"]));
		const { res, result } = response();

		expect(await handleWikiRoutes(request(), res, "GET", "/api/wiki/pages?tag=ai", { l2DataDir: root })).toBe(true);
		expect(result.status).toBe(200);
		const pages = JSON.parse(result.body) as Array<{ path: string }>;
		expect(pages.map((item) => item.path)).toEqual(["wiki/concepts/agent.md"]);
	});

	it("updates tags and refreshes the semantic index", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-wiki-tags-"));
		roots.push(root);
		writeText(join(root, "wiki", "concepts", "agent.md"), page("Agent", ["old"]));
		const { res, result } = response();

		expect(await handleWikiRoutes(
			request({ path: "wiki/concepts/agent.md", tags: ["AI"] }),
			res,
			"PATCH",
			"/api/wiki/page/tags",
			{ l2DataDir: root },
		)).toBe(true);
		expect(result.status).toBe(200);
		expect(indexPageByPath).toHaveBeenCalledWith("wiki/concepts/agent.md");
	});
});
