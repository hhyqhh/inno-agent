import { readText } from "../../storage/file-store.js";
import { safeJoinReal } from "../../server/file-helpers.js";
import { parseFrontmatter } from "../l2/wiki-maintainer.js";
import type { WikiGraph } from "../l2/wiki-graph.js";
import type { PersonalLink, PersonalLinkComparison, PersonalLinkFeedback, PersonalLinkRecommendedAction, PersonalLinkRelationType } from "./personal-links.js";

export type PersonalLinkCompletion = (prompt: string, maxTokens?: number, timeoutMs?: number) => Promise<string>;

interface ModelReview {
	verdict?: "supported" | "needs_bridge" | "explore";
	relation_type?: PersonalLinkRelationType;
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
	relation_type: PersonalLinkRelationType;
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
	const pagePath = safeJoinReal(l2DataDir, path);
	if (!pagePath) return "";
	const { body } = parseFrontmatter(readText(pagePath));
	return body.replace(/\s+/g, " ").slice(0, 1_600);
}

function unavailableFeedback(): PersonalLinkFeedback {
	return {
		verdict: "explore",
		relation_type: "insufficient_evidence",
		concept_clarification: "",
		misconception_check: "",
		summary: "模型评议不可用",
		evidence: "",
		bridge_node_ids: [],
		recommended_action: "keep",
		recommended_node_ids: [],
		recommendation: "请稍后重新发起评议。",
		generated_by: "unavailable",
		reviewed_at: new Date().toISOString(),
	};
}

function parseModelReview(raw: string): ValidModelReview | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
	const candidate = fenced.match(/\{[\s\S]*\}/)?.[0];
	if (!candidate) return null;
	try {
		const parsed = JSON.parse(candidate) as ModelReview;
		if (parsed.verdict !== "supported" && parsed.verdict !== "needs_bridge" && parsed.verdict !== "explore") return null;
		if (!parsed.relation_type || !["historical_or_influential", "conceptual_similarity", "shared_problem", "analogical", "learner_hypothesis", "misconception", "insufficient_evidence"].includes(parsed.relation_type)) return null;
		if (parsed.recommended_action !== "keep" && parsed.recommended_action !== "add_bridge" && parsed.recommended_action !== "replace" && parsed.recommended_action !== "remove") return null;
		if (!parsed.concept_clarification || !parsed.misconception_check || !parsed.summary || !parsed.evidence || !parsed.recommendation) return null;
		return {
			verdict: parsed.verdict,
			relation_type: parsed.relation_type,
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
	const unavailable = unavailableFeedback();
	const source = nodeTitle(graph, link.source);
	const target = nodeTitle(graph, link.target);
	const bridgeTitles = comparison.intermediates.map((id) => nodeTitle(graph, id));
	const graphNodes = graph.nodes.map((node) => `${node.id} | ${node.title}`).join("\n");
	const structureEvidence = comparison.alignment === "aligned"
		? "当前 Wiki 存在直接显式连接。"
		: comparison.alignment === "system_indirect"
			? `当前 Wiki 存在经由 ${bridgeTitles.join("、")} 的间接路径。`
			: "当前 Wiki 没有记录这两个节点之间的显式连接。此信息只表示当前知识库记录情况，不能证明两个概念不存在合理联系。";
	const prompt = `你是以概念澄清为先的哲学教师。评估学习者建立的一条知识连接。先分别解释 A、B，再分析学习者理由。你的判断必须来自页面内容、来源线索、现有图谱结构和学习者理由的综合分析。\n\n重要边界：当前 Wiki 没有显式连接，只表示知识库尚未记录该关系，不代表关系不存在；不要把“learner_only”当成结论。你可以判断思想史/影响关系、概念相似、共同问题、结构类比、学习者假设或概念误解。若材料不足，明确指出缺少哪类材料。不要只说“缺少证据”，也不要反问学习者；必须给出当前最合理的判断和下一步。\n\n可用关系类型：historical_or_influential=思想史、传承或影响；conceptual_similarity=概念结构相似；shared_problem=共同回应某个问题；analogical=有启发性的结构类比；learner_hypothesis=目前主要是学习者提出的假设；misconception=理由建立在概念误解上；insufficient_evidence=材料不足以区分以上关系。\n\n推荐动作：keep=保留原线；add_bridge=保留联想但通过已有节点拆成两段；replace=改为与已有节点连接；remove=删除且不建立替代线。recommended_node_ids 只能使用下方可用节点的完整路径。\n\n请只输出 JSON：{"verdict":"supported|needs_bridge|explore","relation_type":"historical_or_influential|conceptual_similarity|shared_problem|analogical|learner_hypothesis|misconception|insufficient_evidence","concept_clarification":"分别解释 A/B 的关键定义，不超过180字","misconception_check":"指出理由中成立部分与可能误解；无明显误解写无，不超过180字","summary":"关系判断，不超过100字","evidence":"页面、来源或图谱依据，并说明不确定性","recommended_action":"keep|add_bridge|replace|remove","recommended_node_ids":["仅可填完整现有路径"],"recommendation":"可直接执行的保留、补桥、替换或删除建议，不超过220字"}\n\n节点 A：${source} (${link.source})\n节点 B：${target} (${link.target})\n学习者理由：${link.reason}\n当前 Wiki 结构证据：${structureEvidence}\n\nA 页面摘录：${pageExcerpt(l2DataDir, link.source)}\n\nB 页面摘录：${pageExcerpt(l2DataDir, link.target)}\n\n可用节点：\n${graphNodes}`;
	let raw = "";
	try {
		raw = await complete(prompt, 700, 15_000);
	} catch {
		return unavailable;
	}
	const reviewed = parseModelReview(raw);
	if (!reviewed) return unavailable;
	return {
		verdict: reviewed.verdict,
		relation_type: reviewed.relation_type,
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
