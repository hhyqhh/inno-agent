import { join } from "node:path";
import { readText } from "../../storage/file-store.js";
import { parseFrontmatter } from "../l2/wiki-maintainer.js";
import type { WikiGraph } from "../l2/wiki-graph.js";
import type { PersonalLink, PersonalLinkComparison, PersonalLinkFeedback, PersonalLinkRecommendedAction } from "./personal-links.js";

export type PersonalLinkCompletion = (prompt: string, maxTokens?: number, timeoutMs?: number) => Promise<string>;

interface ModelReview {
	verdict?: "supported" | "needs_bridge" | "explore";
	concept_clarification?: string;
	misconception_check?: string;
	summary?: string;
	evidence?: string;
	recommended_action?: PersonalLinkRecommendedAction;
	recommended_node_ids?: string[];
	recommendation?: string;
}

interface ValidModelReview {
	verdict: "supported" | "needs_bridge" | "explore";
	concept_clarification: string;
	misconception_check: string;
	summary: string;
	evidence: string;
	recommended_action: PersonalLinkRecommendedAction;
	recommended_node_ids: string[];
	recommendation: string;
}

function nodeTitle(graph: WikiGraph, id: string): string {
	return graph.nodes.find((node) => node.id === id)?.title ?? id;
}

function pageExcerpt(l2DataDir: string, path: string): string {
	const { body } = parseFrontmatter(readText(join(l2DataDir, path)));
	return body.replace(/\s+/g, " ").slice(0, 1_600);
}

function conciseDefinition(l2DataDir: string, path: string, title: string): string {
	const excerpt = pageExcerpt(l2DataDir, path)
		.replace(/^#+\s+.*$/gm, "")
		.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (!excerpt) return `${title} 的当前 Wiki 页面没有可用于澄清的正文。`;
	const sentence = excerpt.match(/^(.{40,340}?[。！？])/u)?.[1] ?? excerpt.slice(0, 340);
	return `${title}：${sentence}`;
}

function ruleFeedback(link: PersonalLink, graph: WikiGraph, comparison: PersonalLinkComparison, l2DataDir: string): PersonalLinkFeedback {
	const source = nodeTitle(graph, link.source);
	const target = nodeTitle(graph, link.target);
	const clarification = `${conciseDefinition(l2DataDir, link.source, source)} ${conciseDefinition(l2DataDir, link.target, target)}`;
	const now = new Date().toISOString();
	if (comparison.alignment === "aligned") {
		return {
			verdict: "supported",
			concept_clarification: clarification,
			misconception_check: "现有图谱无法仅凭连线判断你的定义是否完全准确；请以页面中的核心定义校准措辞。",
			summary: `这条联系有系统 Wiki 的直接支持：${source} 与 ${target} 已存在明确关联。`,
			evidence: "系统图谱中存在直接的 Wiki 链接。",
			bridge_node_ids: [],
			recommended_action: "keep",
			recommended_node_ids: [],
			recommendation: "保留这条连接；将你的理由改写为页面中能够直接支持的关系表述。",
			generated_by: "rules",
			reviewed_at: now,
		};
	}
	if (comparison.alignment === "system_indirect") {
		const bridges = comparison.intermediates.map((id) => nodeTitle(graph, id)).join("、");
		return {
			verdict: "needs_bridge",
			concept_clarification: clarification,
			misconception_check: "你的联想可能把“共享的问题或目标”直接当成“彼此推导”的关系；两者需要通过中间概念连接。",
			summary: `你的方向有依据，但目前更像一条需要补桥的推理链。`,
			evidence: `系统图谱通过 ${bridges} 把 ${source} 与 ${target} 连接起来。`,
			bridge_node_ids: comparison.intermediates,
			recommended_action: "add_bridge",
			recommended_node_ids: comparison.intermediates,
			recommendation: `保留你的原始联想作为假设，但把单条虚线拆成经由 ${bridges} 的两条连接，并在每一段写出具体机制。`,
			generated_by: "rules",
			reviewed_at: now,
		};
	}
	return {
		verdict: "explore",
		concept_clarification: clarification,
		misconception_check: "你的理由可能把相似的学习态度、价值取向或生活感受，当成两个概念之间已建立的理论关系。",
		summary: "这是一个值得保留的个人联想，但系统知识库目前没有足够证据把它当作已验证关系。",
		evidence: "系统图谱中没有直接边或一跳中间节点支持这条关系。",
		bridge_node_ids: [],
		recommended_action: "keep",
		recommended_node_ids: [],
		recommendation: "暂时保留为探索性虚线，不把它当作理论上的直接关系；先根据两个页面的定义修订你的理由。",
		generated_by: "rules",
		reviewed_at: now,
	};
}

function parseModelReview(raw: string): ValidModelReview | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
	const candidate = fenced.match(/\{[\s\S]*\}/)?.[0];
	if (!candidate) return null;
	try {
		const parsed = JSON.parse(candidate) as ModelReview;
		if (parsed.verdict !== "supported" && parsed.verdict !== "needs_bridge" && parsed.verdict !== "explore") return null;
		if (parsed.recommended_action !== "keep" && parsed.recommended_action !== "add_bridge" && parsed.recommended_action !== "replace" && parsed.recommended_action !== "remove") return null;
		if (!parsed.concept_clarification || !parsed.misconception_check || !parsed.summary || !parsed.evidence || !parsed.recommendation) return null;
		return {
			verdict: parsed.verdict,
			concept_clarification: parsed.concept_clarification,
			misconception_check: parsed.misconception_check,
			summary: parsed.summary,
			evidence: parsed.evidence,
			recommended_action: parsed.recommended_action,
			recommended_node_ids: Array.isArray(parsed.recommended_node_ids)
				? parsed.recommended_node_ids.filter((id): id is string => typeof id === "string")
				: [],
			recommendation: parsed.recommendation,
		};
	} catch {
		return null;
	}
}

/**
 * Review a learner-created connection. The deterministic graph review is
 * always available; a model may refine the explanation from both wiki pages.
 */
export async function reviewPersonalLink(
	link: PersonalLink,
	graph: WikiGraph,
	comparison: PersonalLinkComparison,
	l2DataDir: string,
	complete: PersonalLinkCompletion,
): Promise<PersonalLinkFeedback> {
	const fallback = ruleFeedback(link, graph, comparison, l2DataDir);
	const source = nodeTitle(graph, link.source);
	const target = nodeTitle(graph, link.target);
	const bridgeTitles = comparison.intermediates.map((id) => nodeTitle(graph, id));
	const graphNodes = graph.nodes.map((node) => `${node.id} | ${node.title}`).join("\n");
	const prompt = `你是以概念澄清为先的哲学教师。评估学习者建立的一条知识连接。先检查学习者是否误解了节点 A 或 B 的定义，再判断连接本身。不要只说“缺少证据”或反问学习者；你必须给出具体的修正或连线方案。\n\n规则：\n- 只能以两个页面摘录和系统图谱为依据；不确定时明确说“当前材料不足”。\n- 尤其要识别常见误读：不要把某主义的生活策略、共同问题或相似情绪，误写成另一概念的定义或因果来源。\n- 推荐动作：keep=保留原线；add_bridge=保留联想但通过已有节点拆成两段；replace=建议删除原线、改为与已有节点连接；remove=删除这条线且不建立替代线。\n- recommended_node_ids 只能使用下方“可用节点”中的完整路径；若没有合适现有节点则返回 [] 并说明缺少什么概念。\n- recommendation 必须是可以直接执行的建议，不能用“你再想想”“你能否解释”等问题句。\n\n请只输出 JSON：{"verdict":"supported|needs_bridge|explore","concept_clarification":"先解释并校正 A/B 的关键定义，不超过150字","misconception_check":"明确指出学习者理由中正确部分与可能误解；若无明显误解写无，不超过150字","summary":"对这条关系的判断，不超过80字","evidence":"页面/图谱依据","recommended_action":"keep|add_bridge|replace|remove","recommended_node_ids":["仅可填完整现有路径"],"recommendation":"明确说明保留、删除、替换或拆线后的具体做法，不超过180字"}\n\n节点 A：${source} (${link.source})\n节点 B：${target} (${link.target})\n学习者理由：${link.reason}\n系统结构结论：${comparison.alignment}${bridgeTitles.length ? `；现有中间节点：${bridgeTitles.join("、")}` : ""}\n\nA 页面摘录：${pageExcerpt(l2DataDir, link.source)}\n\nB 页面摘录：${pageExcerpt(l2DataDir, link.target)}\n\n可用节点：\n${graphNodes}`;
	const reviewed = parseModelReview(await complete(prompt, 700, 15_000));
	if (!reviewed) return fallback;
	return {
		verdict: reviewed.verdict,
		concept_clarification: reviewed.concept_clarification.trim(),
		misconception_check: reviewed.misconception_check.trim(),
		summary: reviewed.summary.trim(),
		evidence: reviewed.evidence.trim(),
		bridge_node_ids: reviewed.recommended_action === "add_bridge" ? reviewed.recommended_node_ids : [],
		recommended_action: reviewed.recommended_action,
		recommended_node_ids: reviewed.recommended_node_ids.filter((id) => graph.nodes.some((node) => node.id === id)),
		recommendation: reviewed.recommendation.trim(),
		generated_by: "model",
		reviewed_at: new Date().toISOString(),
	};
}
