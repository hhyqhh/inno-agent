import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WikiGraph } from "../l2/wiki-graph.js";
import {
	comparePersonalLinkToWiki,
	createPersonalLink,
	deletePersonalLink,
	loadPersonalLinks,
	setPersonalLinkFeedback,
	setPersonalLinkStatus,
} from "./personal-links.js";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "inno-personal-links-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

function graph(edges: [string, string][]): WikiGraph {
	const ids = [...new Set(edges.flat())];
	return {
		nodes: ids.map((id) => ({ id, title: id, type: "concept", tags: [] })),
		edges: edges.map(([source, target]) => ({ source, target, type: "link", weight: 1 })),
		maintenance: { missing: [], orphans: [], duplicates: [], contested: [] },
		communities: { count: 0, modularity: 0, lowCohesion: [] },
	};
}

describe("personal learner links", () => {
	it("persists a proposed link and removes reversed duplicates", () => {
		const link = createPersonalLink(dataDir, {
			source: "wiki/concepts/agent.md",
			target: "wiki/concepts/rag.md",
			reason: "Agent 可以通过 RAG 取回完成任务所需的资料。",
		});

		expect(loadPersonalLinks(dataDir)).toEqual([link]);
		expect(() => createPersonalLink(dataDir, {
			source: "wiki/concepts/rag.md",
			target: "wiki/concepts/agent.md",
			reason: "同一条关系。",
		})).toThrow("已经有一条个人连接");
	});

	it("keeps review state private and supports deletion", () => {
		const link = createPersonalLink(dataDir, { source: "a", target: "b", reason: "我的解释" });
		expect(setPersonalLinkStatus(dataDir, link.id, "accepted").status).toBe("accepted");
		expect(deletePersonalLink(dataDir, link.id)).toBe(true);
		expect(loadPersonalLinks(dataDir)).toEqual([]);
	});

	it("only auto-accepts a learner connection when the review supports it", () => {
		const link = createPersonalLink(dataDir, { source: "a", target: "b", reason: "我的解释" });
		const exploratory = setPersonalLinkFeedback(dataDir, link.id, {
			verdict: "needs_bridge",
			concept_clarification: "概念澄清。",
			misconception_check: "可能把共同主题当成直接推导。",
			summary: "缺少一段过渡。",
			evidence: "系统图谱存在间接路径。",
			bridge_node_ids: ["c"],
			recommended_action: "add_bridge",
			recommended_node_ids: ["c"],
			recommendation: "通过 c 拆成两条连接。",
			generated_by: "rules",
			reviewed_at: new Date().toISOString(),
		});
		expect(exploratory.status).toBe("proposed");

		const supported = setPersonalLinkFeedback(dataDir, link.id, {
			...exploratory.feedback!,
			verdict: "supported",
		});
		expect(supported.status).toBe("accepted");
	});

	it("distinguishes direct, two-hop, and learner-only connections", () => {
		expect(comparePersonalLinkToWiki({ source: "a", target: "b" }, graph([["a", "b"]]))).toEqual({
			alignment: "aligned", intermediates: [],
		});
		expect(comparePersonalLinkToWiki({ source: "a", target: "c" }, graph([["a", "b"], ["b", "c"]]))).toEqual({
			alignment: "system_indirect", intermediates: ["b"],
		});
		expect(comparePersonalLinkToWiki({ source: "a", target: "d" }, graph([["a", "b"], ["b", "c"]]))).toEqual({
			alignment: "learner_only", intermediates: [],
		});
	});
});
