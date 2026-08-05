import { afterEach, describe, expect, it, vi } from "vitest";

import { inlineWorkspaceHtml } from "./workspace.js";

describe("inlineWorkspaceHtml", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("inlines relative CSS and JavaScript while rebasing CSS asset URLs", async () => {
		const files = new Map<string, string>([
			[
				"reports/assets/site.css",
				[
					'.logo { background: url("../images/logo.svg#mark"); }',
					'.remote { background: url("https://cdn.example.com/bg.png"); }',
					'.embedded { background: url(data:image/png;base64,abc); }',
				].join("\n"),
			],
			["reports/summary/scripts/app.js", 'const marker = "$&"; console.log(marker);'],
		]);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.searchParams.get("path") ?? "";
			const content = files.get(path);
			return new Response(
				JSON.stringify(content === undefined
					? { error: "not found" }
					: { path, name: path.split("/").at(-1), kind: "text", content }),
				{
					status: content === undefined ? 404 : 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await inlineWorkspaceHtml(
			[
				'<link rel="stylesheet" href="../assets/site.css?v=3#theme">',
				'<script defer src="./scripts/app.js?cache=1"></script>',
			].join("\n"),
			"reports/summary/index.html",
			"course 1",
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
			"/api/workspace/file?path=reports%2Fassets%2Fsite.css&workspaceId=course+1",
			"/api/workspace/file?path=reports%2Fsummary%2Fscripts%2Fapp.js&workspaceId=course+1",
		]);
		expect(result).toContain(
			'url("/api/workspace/raw?path=reports%2Fimages%2Flogo.svg&workspaceId=course+1#mark")',
		);
		expect(result).toContain('url("https://cdn.example.com/bg.png")');
		expect(result).toContain("url(data:image/png;base64,abc)");
		expect(result).toContain('<script defer>const marker = "$&"; console.log(marker);</script>');
		expect(result).not.toContain("site.css?v=3#theme");
		expect(result).not.toContain("app.js?cache=1");
	});

	it.each([
		["absolute http URL", "https://cdn.example.com/site.css"],
		["absolute https URL", "http://cdn.example.com/site.css"],
		["protocol-relative URL", "//cdn.example.com/site.css"],
		["root-relative URL", "/static/site.css"],
		["data URL", "data:text/css,body{}"],
		["blob URL", "blob:https://example.com/id"],
		["non-http scheme", "mailto:a@b.c"],
		["query-only ref", "?v=3"],
		["fragment-only ref", "#theme"],
	])("leaves %s untouched", async (_label, href) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tag = `<link rel="stylesheet" href="${href}">`;

		const result = await inlineWorkspaceHtml(tag, "index.html");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toBe(tag);
	});

	it("does not inline a script referenced from a stylesheet link tag", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tag = '<link rel="stylesheet" href="app.js">';

		const result = await inlineWorkspaceHtml(tag, "index.html");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toBe(tag);
	});

	it("resolves Windows-style backslash paths", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request) =>
			new Response(
				JSON.stringify({ path: "assets\\site.css", name: "site.css", kind: "text", content: "body{}" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			));
		vi.stubGlobal("fetch", fetchMock);

		const result = await inlineWorkspaceHtml(
			'<link rel="stylesheet" href="..\\assets\\site.css">',
			"reports\\summary\\index.html",
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("path=reports%2Fassets%2Fsite.css");
		expect(result).toContain("<style>body{}</style>");
	});
});
