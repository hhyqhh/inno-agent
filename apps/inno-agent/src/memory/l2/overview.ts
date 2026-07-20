/**
 * L2 knowledge-base overview generator.
 *
 * Regenerates `wiki/analysis/overview.md` — a durable `analysis`-type page that
 * summarizes the whole knowledge base. The deterministic core (per-type counts
 * + most-connected entities/concepts) always runs; an optional LLM narrative is
 * prepended when a model is available. Idempotent (single file), and wrapped by
 * callers so a failure never breaks an archive.
 */

import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, writeText } from "../../storage/file-store.js";
import { serializeFrontmatter, rebuildIndex } from "./wiki-maintainer.js";
import { readManifest } from "./manifest-store.js";
import { buildWikiGraph, computeWikiGraphStats, OVERVIEW_PATH, type WikiGraphStats } from "./wiki-graph.js";
import { logger } from "../../logger.js";

const OVERVIEW_TITLE = "知识库总览";

const TYPE_LABELS: Record<string, string> = {
	"source-summary": "资料摘要",
	entity: "实体",
	concept: "概念",
	analysis: "分析",
};

function basename(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

function renderDeterministic(stats: WikiGraphStats): string {
	const lines: string[] = ["## 概况", "", `- 页面总数：${stats.totalPages}`];
	for (const [type, count] of Object.entries(stats.typeCounts).sort((a, b) => b[1] - a[1])) {
		lines.push(`- ${TYPE_LABELS[type] ?? type}：${count}`);
	}

	const { communities } = stats;
	lines.push(
		"",
		"## 主题社区",
		"",
		`- 社区数：${communities.count}（模块度 ${communities.modularity}）`,
	);
	if (communities.lowCohesion.length > 0) {
		lines.push(`- ⚠️ 低内聚社区 ${communities.lowCohesion.length} 个（内聚度 < 0.15，建议拆分或补充连接）`);
	}

	lines.push("", "## 核心节点（按关联度）", "");
	const top = stats.topByDegree.filter((t) => t.type === "entity" || t.type === "concept");
	if (top.length === 0) {
		lines.push("<!-- 暂无足够的双链关联 -->");
	} else {
		for (const t of top) {
			lines.push(`- [[${t.title}]] — ${TYPE_LABELS[t.type] ?? t.type}，关联 ${t.degree}`);
		}
	}

	const { maintenance } = stats;
	const hasMaintenance =
		maintenance.orphans.length + maintenance.missing.length + maintenance.duplicates.length + maintenance.contested.length >
		0;
	if (hasMaintenance) {
		lines.push("", "## 维护建议", "");
		if (maintenance.duplicates.length > 0) {
			lines.push(`- 疑似重复页 ${maintenance.duplicates.length} 组（标题高度相近，建议合并）：`);
			for (const group of maintenance.duplicates.slice(0, 5)) {
				lines.push(`  - ${group.map((p) => `\`${basename(p)}\``).join(" ↔ ")}`);
			}
		}
		if (maintenance.missing.length > 0) {
			const links = [...new Set(maintenance.missing.map((m) => m.link))];
			lines.push(`- 断链 ${links.length} 处（引用了不存在的页面，建议建页或修链接）：${links.slice(0, 8).map((l) => `[[${l}]]`).join("、")}`);
		}
		if (maintenance.orphans.length > 0) {
			lines.push(`- 孤立页 ${maintenance.orphans.length} 个（无任何双链，建议补充关联）：${maintenance.orphans.slice(0, 8).map((p) => `[[${basename(p)}]]`).join("、")}`);
		}
		if (maintenance.contested.length > 0) {
			lines.push(`- 存在争议的页面 ${maintenance.contested.length} 个：${maintenance.contested.slice(0, 8).map((p) => `[[${basename(p)}]]`).join("、")}`);
		}
	}

	return lines.join("\n");
}

const NARRATIVE_PROMPT = `你是学习 Wiki 知识库的总览撰写助手。根据下面的统计信息，用一到两段简洁中文，概述这个知识库当前覆盖了哪些主题、核心线索是什么。只写概述段落，不要列表、不要标题、不要代码块。

统计信息：
{stats}`;

async function generateNarrative(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	statsText: string,
): Promise<string> {
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return "";
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: NARRATIVE_PROMPT.replace("{stats}", statsText) }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1024 },
		);
		if (response.stopReason === "error") return "";
		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	} catch (err) {
		logger.warn({ err }, "[L2 overview] narrative generation failed");
		return "";
	}
}

/**
 * (Re)generate the overview page. Returns its wiki-relative path, or null when
 * the knowledge base is empty or generation fails. Rebuilds `wiki/index.md` so
 * the overview is listed under 分析.
 */
export async function regenerateOverview(
	l2DataDir: string,
	model?: Model<any>,
	modelRegistry?: ModelRegistry,
): Promise<string | null> {
	try {
		const stats = computeWikiGraphStats(buildWikiGraph(l2DataDir));
		if (stats.totalPages === 0) return null;

		const deterministic = renderDeterministic(stats);
		let narrative = "";
		if (model && modelRegistry) {
			narrative = await generateNarrative(model, modelRegistry, deterministic);
		}

		const today = new Date().toISOString().slice(0, 10);
		const fm = serializeFrontmatter({
			title: OVERVIEW_TITLE,
			created: today,
			type: "analysis",
			tags: ["analysis", "overview"],
			sources: [],
			source_ids: [],
			updated: today,
			status: "draft",
			confidence: "medium",
		});
		const body = `\n# ${OVERVIEW_TITLE}\n\n${narrative ? `${narrative}\n\n` : ""}${deterministic}\n`;
		ensureDir(join(l2DataDir, "wiki", "analysis"));
		writeText(join(l2DataDir, OVERVIEW_PATH), fm + body);
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		return OVERVIEW_PATH;
	} catch (err) {
		logger.warn({ err }, `[L2 overview] regeneration failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

export { OVERVIEW_PATH };
