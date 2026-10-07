import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeText } from "../../storage/file-store.js";
import type { WikiGraph } from "../l2/wiki-graph.js";
import { reviewPersonalLink } from "./personal-link-review.js";
import {
	comparePersonalLinkToWiki,
	createPersonalLink,
	deletePersonalLink,
	loadPersonalLinks,
	setPersonalLinkFeedback,
	setPersonalLinkStatus,
	type PersonalLink,
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
			relation_type: "shared_problem",
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
			recommended_action: "keep",
		});
		expect(supported.status).toBe("accepted");
	});

	it("rejects a link when the review recommends removal, even if the verdict is supported", () => {
		const link = createPersonalLink(dataDir, { source: "a", target: "b", reason: "我的解释" });
		const reviewed = setPersonalLinkFeedback(dataDir, link.id, {
			verdict: "supported",
			relation_type: "learner_hypothesis",
			concept_clarification: "概念已澄清。",
			misconception_check: "理由仍然把两个不同层次混在一起。",
			summary: "当前不应保留这条连接。",
			evidence: "现有材料不足以支持该连接。",
			bridge_node_ids: [],
			recommended_action: "remove",
			recommended_node_ids: [],
			recommendation: "删除这条个人连接。",
			generated_by: "model",
			reviewed_at: new Date().toISOString(),
		});
		expect(reviewed.status).toBe("rejected");
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

	it("never includes an escaped historical path in the model review prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-personal-link-review-"));
		try {
			const secretPath = join(root, "secret.md");
			const l2DataDir = join(root, "l2");
			writeText(secretPath, "TOP-SECRET-MUST-NOT-LEAVE-THE-HOST");
			writeText(join(l2DataDir, "wiki", "concepts", "target.md"), "---\ntitle: Target\n---\nVisible wiki text.");
			const graphWithCorruptedId: WikiGraph = {
				nodes: [
					{ id: "../secret.md", title: "Invalid source", type: "concept", tags: [] },
					{ id: "wiki/concepts/target.md", title: "Target", type: "concept", tags: [] },
				],
				edges: [],
				maintenance: { missing: [], orphans: [], duplicates: [], contested: [] },
				communities: { count: 0, modularity: 0, lowCohesion: [] },
			};
			const corruptedLink: PersonalLink = {
				id: "plink_corrupted",
				source: "../secret.md",
				target: "wiki/concepts/target.md",
				reason: "A manually corrupted historical record.",
				status: "proposed",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			let prompt = "";
			await reviewPersonalLink(corruptedLink, graphWithCorruptedId, { alignment: "learner_only", intermediates: [] }, l2DataDir, async (input) => {
				prompt = input;
				return "not json";
			});

			expect(prompt).not.toContain("TOP-SECRET-MUST-NOT-LEAVE-THE-HOST");
			expect(prompt).toContain("Visible wiki text.");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the model's semantic relationship when Wiki has no explicit edge", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-personal-link-model-review-"));
		try {
			const l2DataDir = join(root, "l2");
			writeText(join(l2DataDir, "wiki", "concepts", "cynicism.md"), "---\ntitle: 犬儒主义\n---\n关于犬儒主义的页面内容。");
			writeText(join(l2DataDir, "wiki", "concepts", "socrates.md"), "---\ntitle: 苏格拉底\n---\n关于苏格拉底的页面内容。");
			const reviewLink: PersonalLink = {
				id: "plink_model",
				source: "wiki/concepts/cynicism.md",
				target: "wiki/concepts/socrates.md",
				reason: "我认为二者存在思想传统上的联系。",
				status: "proposed",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			const graphWithNoEdge = graph([
				["wiki/concepts/cynicism.md", "wiki/concepts/other.md"],
			]);
			graphWithNoEdge.nodes.push({ id: "wiki/concepts/socrates.md", title: "苏格拉底", type: "concept", tags: [] });
			let prompt = "";
			const feedback = await reviewPersonalLink(
				reviewLink,
				graphWithNoEdge,
				{ alignment: "learner_only", intermediates: [] },
				l2DataDir,
				async (input) => {
					prompt = input;
					return JSON.stringify({
						verdict: "supported",
						relation_type: "historical_or_influential",
						concept_clarification: "二者需要区分为人物思想与后续传统。",
						misconception_check: "没有明显误解。",
						summary: "这是一条思想传统上的联系。",
						evidence: "页面内容与学习者理由支持进一步核查思想史关系。",
						recommended_action: "keep",
						recommended_node_ids: ["../../outside.md", "wiki/concepts/other.md"],
						recommendation: "保留虚线，并补充可靠思想史来源。",
					});
				},
			);

			expect(prompt).toContain("不能证明两个概念不存在合理联系");
			expect(feedback.generated_by).toBe("model");
			expect(feedback.relation_type).toBe("historical_or_influential");
			expect(feedback.recommended_node_ids).toEqual(["wiki/concepts/other.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
