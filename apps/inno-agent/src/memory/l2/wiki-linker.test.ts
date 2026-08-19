import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: completeMock }));

import { writeText } from "../../storage/file-store.js";
import type { ManifestEntry } from "./types.js";
import { buildWikiGraph } from "./wiki-graph.js";
import { maintainLinkedWikiPages } from "./wiki-linker.js";
import { createSourcePage, ensureL2Directories, parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-linker-"));
	tempDirs.push(dir);
	return dir;
}

function entry(): ManifestEntry {
	return {
		id: "l2src_linker1",
		title: "关系测试资料",
		sourceType: "markdown",
		rawPath: "raw/uploads/source.md",
		extractedPath: "extracted/source.md",
		wikiPages: [],
		tags: ["test"],
		contentHash: "abcdef",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
	};
}

function modelResponse(text: string) {
	return { stopReason: "stop", content: [{ type: "text", text }] };
}

afterEach(() => {
	completeMock.mockReset();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("L2 wiki link maintenance", () => {
	it("closes summary links when the planner omits candidates and adds only validated peer links", async () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const source = entry();
		const summary = "## 关键概念\n\n- [[Alpha]]\n- [[Beta]]\n- [[Planner Omitted]]";
		const sourcePath = createSourcePage(root, source, summary, source.extractedPath);
		writeText(
			join(root, "wiki", "concepts", "existing.md"),
			`${serializeFrontmatter({
				title: "Existing Knowledge",
				created: "2026-07-30",
				type: "concept",
				tags: ["concept"],
				sources: [],
				source_ids: [],
				updated: "2026-07-30",
				status: "draft",
				confidence: "medium",
			})}\n# Existing Knowledge\n\n## 定义\n\n已有知识。\n`,
		);

		completeMock
			.mockResolvedValueOnce(
				modelResponse(JSON.stringify({
					items: [
						{ title: "Alpha", type: "concept", description: "Alpha 定义", tags: ["alpha topic", "mechanism", "durable", "ignored"] },
						{ title: "Beta", type: "concept", description: "Beta 定义" },
					],
				})),
			)
			.mockResolvedValueOnce(
				modelResponse(JSON.stringify({
					items: [{
						title: "Alpha",
						type: "concept",
						action: "create",
						definition: "Alpha 融合定义",
						relatedTitles: ["Beta", "Existing Knowledge", "Hallucinated Page"],
					}],
				})),
			);

		const result = await maintainLinkedWikiPages(
			root,
			source,
			sourcePath,
			summary,
			{} as any,
			{ getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test", headers: {} }) } as any,
		);

		expect(result.pages).toHaveLength(3);
		expect(result.sourcePageBody).toBe(summary);
		const alphaPath = result.pages.find((path) => path.endsWith("alpha.md"));
		const betaPath = result.pages.find((path) => path.endsWith("beta.md"));
		const omittedPath = result.pages.find((path) => path.includes("planner-omitted"));
		expect(alphaPath).toBeDefined();
		expect(betaPath).toBeDefined();
		expect(omittedPath).toBeDefined();

		const alpha = readFileSync(join(root, alphaPath!), "utf8");
		expect(alpha).toContain("[[Beta]]");
		expect(alpha).toContain("[[Existing Knowledge]]");
		expect(alpha).not.toContain("Hallucinated Page");
		expect(parseFrontmatter(alpha).frontmatter?.tags).toEqual(["concept", "alpha-topic", "mechanism", "durable"]);
		expect(parseFrontmatter(alpha).frontmatter?.tags).not.toContain("test");

		const graph = buildWikiGraph(root);
		expect(graph.maintenance.missing).toEqual([]);
		expect(graph.edges).toContainEqual(expect.objectContaining({
			source: alphaPath,
			target: betaPath,
			type: "link",
			weight: expect.any(Number),
		}));
	});

	it("reuses an existing page type when extraction classifies a shared title differently", async () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const source = entry();
		const summary = "## 关键概念\n\n- [[Shared Memory]]";
		const sourcePath = createSourcePage(root, source, summary, source.extractedPath);
		writeText(
			join(root, "wiki", "concepts", "shared-memory.md"),
			`${serializeFrontmatter({
				title: "Shared Memory",
				created: "2026-07-29",
				type: "concept",
				tags: ["concept"],
				sources: ["wiki/sources/older.md"],
				source_ids: ["l2src_older"],
				updated: "2026-07-29",
				status: "draft",
				confidence: "medium",
			})}\n# Shared Memory\n\n## 定义\n\n旧定义。\n`,
		);

		completeMock
			.mockResolvedValueOnce(modelResponse(JSON.stringify({
				items: [{ title: "Shared Memory", type: "entity", description: "新资料定义" }],
			})))
			.mockResolvedValueOnce(modelResponse(JSON.stringify({
				items: [{
					title: "Shared Memory",
					type: "entity",
					action: "update",
					definition: "融合后的共享记忆定义。",
					relatedTitles: [],
				}],
			})));

		const result = await maintainLinkedWikiPages(
			root,
			source,
			sourcePath,
			summary,
			{} as any,
			{ getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test", headers: {} }) } as any,
		);

		expect(result.pages).toEqual(["wiki/concepts/shared-memory.md"]);
		expect(result.created).toEqual([]);
		expect(result.updated).toEqual(["wiki/concepts/shared-memory.md"]);
		expect(readFileSync(join(root, "wiki", "concepts", "shared-memory.md"), "utf8")).toContain(source.id);
		expect(() => readFileSync(join(root, "wiki", "entities", "shared-memory.md"), "utf8")).toThrow();
	});
});
