import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeText } from "../../storage/file-store.js";
import { buildWikiGraph } from "./wiki-graph.js";
import { ensureL2Directories, serializeFrontmatter } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePage(root: string, name: string, title: string, sourceId: string, body: string): string {
	const path = `wiki/concepts/${name}.md`;
	writeText(
		join(root, "wiki", "concepts", `${name}.md`),
		`${serializeFrontmatter({
			title,
			created: "2026-07-30",
			type: "concept",
			tags: ["test"],
			sources: [],
			source_ids: [sourceId],
			updated: "2026-07-30",
			status: "draft",
			confidence: "medium",
		})}\n# ${title}\n\n${body}\n`,
	);
	return path;
}

describe("L2 wiki graph visualization data", () => {
	it("deduplicates reciprocal links and weights stronger relationships higher", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-l2-graph-"));
		tempDirs.push(root);
		ensureL2Directories(root);

		const alpha = writePage(root, "alpha", "Alpha", "source-1", "[[Beta]] and again [[Beta]], plus [[Gamma]].");
		const beta = writePage(root, "beta", "Beta", "source-1", "[[Alpha]]");
		const gamma = writePage(root, "gamma", "Gamma", "source-2", "A separate source.");

		const graph = buildWikiGraph(root);
		const pageEdges = graph.edges.filter((edge) => edge.type === "link" && edge.target.startsWith("wiki/"));
		const alphaBeta = pageEdges.filter((edge) => new Set([edge.source, edge.target]).has(alpha) && new Set([edge.source, edge.target]).has(beta));
		const alphaGamma = pageEdges.find((edge) => new Set([edge.source, edge.target]).has(alpha) && new Set([edge.source, edge.target]).has(gamma));

		expect(alphaBeta).toHaveLength(1);
		expect(alphaGamma).toBeDefined();
		expect(alphaBeta[0]!.weight).toBeGreaterThan(alphaGamma!.weight);
		expect(graph.nodes.find((node) => node.id === alpha)?.community).toEqual(expect.any(Number));
	});
});
