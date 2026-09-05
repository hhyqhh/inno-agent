import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "../../storage/file-store.js";
import type { WikiGraph } from "../l2/wiki-graph.js";

const PERSONAL_LINKS_FILE = "personal-links.json";
const MAX_REASON_LENGTH = 2_000;

export type PersonalLinkStatus = "proposed" | "accepted" | "rejected";
export type PersonalLinkAlignment = "aligned" | "system_indirect" | "learner_only";
export type PersonalLinkVerdict = "supported" | "needs_bridge" | "explore";
export type PersonalLinkRecommendedAction = "keep" | "add_bridge" | "replace" | "remove";

/** Feedback is an assessment of the learner's reasoning, never a fact claim. */
export interface PersonalLinkFeedback {
	verdict: PersonalLinkVerdict;
	/** A concise correction of the concepts before judging their relationship. */
	concept_clarification: string;
	/** Pinpoints a likely conflation in the learner's stated reason, if any. */
	misconception_check: string;
	summary: string;
	evidence: string;
	bridge_node_ids: string[];
	recommended_action: PersonalLinkRecommendedAction;
	/** Existing Wiki nodes that make the correction actionable. */
	recommended_node_ids: string[];
	recommendation: string;
	generated_by: "rules" | "model";
	reviewed_at: string;
}

/**
 * A learner's explanation of how two existing wiki concepts relate.
 *
 * It stays separate from the wiki graph until a later review step explicitly
 * accepts it, so a learner's useful hypothesis is never silently promoted to
 * a system fact.
 */
export interface PersonalLink {
	id: string;
	/** Links created before one "finish this round" action share a batch. */
	batch_id?: string;
	source: string;
	target: string;
	reason: string;
	status: PersonalLinkStatus;
	feedback?: PersonalLinkFeedback;
	created_at: string;
	updated_at: string;
}

export interface CreatePersonalLinkInput {
	source: string;
	target: string;
	reason: string;
	batch_id?: string;
}

export interface PersonalLinkComparison {
	alignment: PersonalLinkAlignment;
	/** Existing one-hop system links that explain an indirect relationship. */
	intermediates: string[];
}

function personalLinksPath(dataDir: string): string {
	return join(dataDir, PERSONAL_LINKS_FILE);
}

function canonicalEndpoints(source: string, target: string): [string, string] {
	return source.localeCompare(target, "en") <= 0 ? [source, target] : [target, source];
}

function normalizedInput(input: CreatePersonalLinkInput): CreatePersonalLinkInput {
	const source = input.source.trim();
	const target = input.target.trim();
	const reason = input.reason.trim();
	if (!source || !target) throw new Error("请选择两个知识节点。");
	if (source === target) throw new Error("一条个人连接必须连接两个不同的知识节点。");
	if (!reason) throw new Error("请说明你认为这两个节点相关的原因。");
	if (reason.length > MAX_REASON_LENGTH) throw new Error(`连接理由不能超过 ${MAX_REASON_LENGTH} 个字符。`);
	return { source, target, reason, batch_id: input.batch_id?.trim() || undefined };
}

function isPersonalLink(value: unknown): value is PersonalLink {
	if (!value || typeof value !== "object") return false;
	const link = value as Record<string, unknown>;
	return typeof link.id === "string"
		&& typeof link.source === "string"
		&& typeof link.target === "string"
		&& typeof link.reason === "string"
		&& (link.batch_id === undefined || typeof link.batch_id === "string")
		&& (link.status === "proposed" || link.status === "accepted" || link.status === "rejected")
		&& typeof link.created_at === "string"
		&& typeof link.updated_at === "string";
}

/** Load only valid saved records so a malformed manual edit cannot stop learning. */
export function loadPersonalLinks(dataDir: string): PersonalLink[] {
	return readJson<unknown[]>(personalLinksPath(dataDir), []).filter(isPersonalLink);
}

function savePersonalLinks(dataDir: string, links: PersonalLink[]): void {
	writeJson(personalLinksPath(dataDir), links);
}

/**
 * Create a proposed learner link. Endpoints are treated as undirected for
 * deduplication: A -> B and B -> A represent the same personal connection.
 */
export function createPersonalLink(dataDir: string, input: CreatePersonalLinkInput): PersonalLink {
	const normalized = normalizedInput(input);
	const [source, target] = canonicalEndpoints(normalized.source, normalized.target);
	const links = loadPersonalLinks(dataDir);
	if (links.some((link) => {
		const [existingSource, existingTarget] = canonicalEndpoints(link.source, link.target);
		return existingSource === source && existingTarget === target;
	})) {
		throw new Error("这两个节点之间已经有一条个人连接。");
	}

	const now = new Date().toISOString();
	const link: PersonalLink = {
		id: `plink_${randomUUID()}`,
		batch_id: normalized.batch_id?.trim() || undefined,
		source,
		target,
		reason: normalized.reason,
		status: "proposed",
		created_at: now,
		updated_at: now,
	};
	savePersonalLinks(dataDir, [...links, link]);
	return link;
}

/** Change review state without changing the learner's original explanation. */
export function setPersonalLinkStatus(dataDir: string, id: string, status: PersonalLinkStatus): PersonalLink {
	const links = loadPersonalLinks(dataDir);
	const index = links.findIndex((link) => link.id === id);
	if (index === -1) throw new Error("未找到这条个人连接。");
	const updated: PersonalLink = { ...links[index]!, status, updated_at: new Date().toISOString() };
	links[index] = updated;
	savePersonalLinks(dataDir, links);
	return updated;
}

/** Save a review without changing the learner's original connection or reason. */
export function setPersonalLinkFeedback(dataDir: string, id: string, feedback: PersonalLinkFeedback): PersonalLink {
	const links = loadPersonalLinks(dataDir);
	const index = links.findIndex((link) => link.id === id);
	if (index === -1) throw new Error("未找到这条个人连接。");
	const updated: PersonalLink = {
		...links[index]!,
		feedback,
		// Only a supported connection is promoted to an accepted learner model.
		// Exploration and missing-bridge cases remain hypotheses for discussion.
		status: feedback.verdict === "supported" ? "accepted" : "proposed",
		updated_at: new Date().toISOString(),
	};
	links[index] = updated;
	savePersonalLinks(dataDir, links);
	return updated;
}

/** Remove a learner connection from the private learner record. */
export function deletePersonalLink(dataDir: string, id: string): boolean {
	const links = loadPersonalLinks(dataDir);
	const remaining = links.filter((link) => link.id !== id);
	if (remaining.length === links.length) return false;
	savePersonalLinks(dataDir, remaining);
	return true;
}

/**
 * Compare an undirected personal connection against explicit system Wiki links.
 * A two-hop relation is informative but deliberately remains distinct from a
 * direct system assertion.
 */
export function comparePersonalLinkToWiki(link: Pick<PersonalLink, "source" | "target">, graph: WikiGraph): PersonalLinkComparison {
	const neighbors = new Map<string, Set<string>>();
	for (const node of graph.nodes) neighbors.set(node.id, new Set());
	for (const edge of graph.edges) {
		if (edge.type !== "link") continue;
		neighbors.get(edge.source)?.add(edge.target);
		neighbors.get(edge.target)?.add(edge.source);
	}

	const sourceNeighbors = neighbors.get(link.source) ?? new Set<string>();
	const targetNeighbors = neighbors.get(link.target) ?? new Set<string>();
	if (sourceNeighbors.has(link.target)) return { alignment: "aligned", intermediates: [] };

	const intermediates = [...sourceNeighbors]
		.filter((node) => targetNeighbors.has(node))
		.sort((a, b) => a.localeCompare(b, "zh-CN"));
	return intermediates.length > 0
		? { alignment: "system_indirect", intermediates }
		: { alignment: "learner_only", intermediates: [] };
}
