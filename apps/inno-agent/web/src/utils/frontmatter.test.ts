import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
	it("parses CRLF-delimited pages without losing the body", () => {
		const parsed = parseFrontmatter([
			"---",
			"title: Windows page",
			"created: 2026-08-18",
			"type: concept",
			"tags: [acceptance]",
			"sources:",
			"  - wiki/sources/windows.md",
			"source_ids:",
			"  - l2src_windows",
			"updated: 2026-08-18",
			"status: draft",
			"confidence: medium",
			"---",
			"Body line 1",
			"Body line 2",
		].join("\r\n"));

		expect(parsed.frontmatter?.title).toBe("Windows page");
		expect(parsed.frontmatter?.sources).toEqual(["wiki/sources/windows.md"]);
		expect(parsed.body).toBe("Body line 1\r\nBody line 2");
	});
});
