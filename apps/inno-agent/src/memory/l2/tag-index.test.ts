import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalizeTag,
	normalizeTagList,
	rebuildTagIndex,
	suggestTags,
	wikiPathsForTag,
} from "./tag-index.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-tag-index-"));
	roots.push(root);
	return root;
}

describe("L2 tag index", () => {
	it("normalizes delimiters and case without splitting a tag on spaces", () => {
		expect(canonicalizeTag("  Machine   Learning ")).toBe("machine learning");
		expect(normalizeTagList(["Machine Learning", "machine learning", "TypeScript，Agent"])).toEqual([
			"Machine Learning",
			"TypeScript",
			"Agent",
		]);
	});

	it("keeps stable tag ids while rebuilding page relationships", () => {
		const root = tempRoot();
		const first = rebuildTagIndex(root, [
			{ wikiPath: "wiki/concepts/a.md", tags: ["Agent", "TypeScript"] },
			{ wikiPath: "wiki/concepts/b.md", tags: ["agent"] },
		]);
		const agentId = first.tags.find((tag) => tag.canonicalKey === "agent")?.id;
		expect(first.tags[0]).toMatchObject({ canonicalKey: "agent", usageCount: 2 });
		expect(wikiPathsForTag(root, "AGENT")).toEqual([
			"wiki/concepts/a.md",
			"wiki/concepts/b.md",
		]);

		const second = rebuildTagIndex(root, [
			{ wikiPath: "wiki/concepts/c.md", tags: ["Agent"] },
		]);
		expect(second.tags).toHaveLength(1);
		expect(second.tags[0]?.id).toBe(agentId);
		expect(suggestTags(root, "age")).toEqual(["Agent"]);
	});
});
