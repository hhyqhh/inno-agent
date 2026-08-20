import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
	normalizeEvidenceTextForQuoteMatching,
	type EvidenceBlock,
} from "./evidence-index.js";

export interface EvidenceCandidate {
	source_id: string;
	block_id: string;
	quote: string;
}

export interface EvidenceSelectionInput {
	pagePath: string;
	pageBody: string;
	sourceId: string;
	blocks: readonly EvidenceBlock[];
}

export type EvidenceSelectionCode =
	| "selector-auth-unavailable"
	| "selector-provider-error"
	| "selector-error"
	| "selector-malformed-response"
	| "selector-zero-candidates";

export interface EvidenceSelectionOutcome {
	candidates: readonly EvidenceCandidate[];
	codes: readonly EvidenceSelectionCode[];
	rejected: number;
}

export interface EvidenceCandidateSelector {
	select(input: EvidenceSelectionInput): Promise<readonly EvidenceCandidate[]>;
	selectMany?(inputs: readonly EvidenceSelectionInput[]): Promise<readonly EvidenceSelectionOutcome[]>;
}

const MAX_BATCH_CHARACTERS = 24_000;
const MAX_PAGE_BATCH_CHARACTERS = 24_000;
const MAX_QUOTE_CODE_POINTS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isShortNonEmptyQuote(value: string): boolean {
	if (normalizeEvidenceTextForQuoteMatching(value).length === 0) return false;
	let codePoints = 0;
	for (const _codePoint of value) {
		codePoints += 1;
		if (codePoints > MAX_QUOTE_CODE_POINTS) return false;
	}
	return true;
}

function serializedBlockSize(block: EvidenceBlock): number {
	return JSON.stringify(block).length;
}

function batchCompleteBlocks(blocks: readonly EvidenceBlock[]): EvidenceBlock[][] {
	const batches: EvidenceBlock[][] = [];
	let current: EvidenceBlock[] = [];
	let currentCharacters = 0;

	for (const block of blocks) {
		const blockCharacters = serializedBlockSize(block);
		if (current.length > 0 && currentCharacters + blockCharacters > MAX_BATCH_CHARACTERS) {
			batches.push(current);
			current = [];
			currentCharacters = 0;
		}
		current.push(block);
		currentCharacters += blockCharacters;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function selectionPrompt(input: EvidenceSelectionInput, blocks: readonly EvidenceBlock[]): string {
	return [
		"Select short source quotes that directly support the wiki page.",
		"Return JSON only, with exactly this shape:",
		'{"candidates":[{"source_id":"...","block_id":"...","quote":"..."}]}',
		"Each candidate must contain exactly source_id, block_id, and quote.",
		"Use only the supplied source_id and block_id values.",
		"A quote must be at most 500 Unicode characters and wholly contained in one evidence block.",
		"Do not output paths, page numbers, locators, explanations, or markdown fences.",
		"",
		`PAGE PATH:\n${input.pagePath}`,
		`PAGE BODY:\n${input.pageBody}`,
		`SOURCE ID:\n${input.sourceId}`,
		`COMPLETE EVIDENCE BLOCKS (JSON):\n${JSON.stringify(blocks)}`,
	].join("\n");
}

interface IdentifiedSelectionInput extends EvidenceSelectionInput {
	pageId: string;
}

function batchSelectionPrompt(
	inputs: readonly IdentifiedSelectionInput[],
	blocks: readonly EvidenceBlock[],
): string {
	return [
		"Select short source quotes that directly support each wiki page.",
		"Return JSON only, with exactly this shape:",
		'{"pages":[{"page_id":"page-1","candidates":[{"source_id":"...","block_id":"...","quote":"..."}]}]}',
		"Return exactly one pages item for every supplied page_id, even when its candidates array is empty.",
		"Each pages item must contain exactly page_id and candidates.",
		"Each candidate must contain exactly source_id, block_id, and quote.",
		"Use only the supplied source_id and block_id values.",
		"A quote must be at most 500 Unicode characters and wholly contained in one evidence block.",
		"Do not output paths, page numbers, locators, explanations, or markdown fences.",
		"",
		`SOURCE ID:\n${inputs[0]?.sourceId ?? ""}`,
		`WIKI PAGES (JSON):\n${JSON.stringify(inputs.map((input) => ({
			page_id: input.pageId,
			page_path: input.pagePath,
			page_body: input.pageBody,
		})))}`,
		`COMPLETE EVIDENCE BLOCKS (JSON):\n${JSON.stringify(blocks)}`,
	].join("\n");
}

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
	const content = Array.isArray(response.content) ? response.content : [];
	return content
		.filter((part): part is { type: "text"; text: string } => (
			isRecord(part) && part.type === "text" && typeof part.text === "string"
		))
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function decodeCandidate(
	rawCandidate: unknown,
	sourceId: string,
	blockById: ReadonlyMap<string, EvidenceBlock>,
): EvidenceCandidate | null {
	if (!isRecord(rawCandidate) || !hasExactKeys(rawCandidate, ["block_id", "quote", "source_id"])) {
		return null;
	}
	if (
		typeof rawCandidate.source_id !== "string"
		|| typeof rawCandidate.block_id !== "string"
		|| typeof rawCandidate.quote !== "string"
		|| rawCandidate.source_id !== sourceId
		|| !isShortNonEmptyQuote(rawCandidate.quote)
	) {
		return null;
	}
	const block = blockById.get(rawCandidate.block_id);
	if (!block) return null;
	const blockView = normalizeEvidenceTextForQuoteMatching(block.text);
	const quoteView = normalizeEvidenceTextForQuoteMatching(rawCandidate.quote);
	if (!blockView.includes(quoteView)) return null;
	return {
		source_id: rawCandidate.source_id,
		block_id: rawCandidate.block_id,
		quote: rawCandidate.quote,
	};
}

/** Parse a model JSON response, tolerating markdown fences and surrounding prose. */
function parseJsonResponse(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu.exec(trimmed);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end < start) return null;
		try {
			return JSON.parse(candidate.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

function decodeBatchCandidates(
	text: string,
	input: EvidenceSelectionInput,
	blocks: readonly EvidenceBlock[],
): EvidenceCandidate[] | null {
	let decoded: unknown;
	try {
		decoded = parseJsonResponse(text);
	} catch {
		return null;
	}
	if (!isRecord(decoded) || !hasExactKeys(decoded, ["candidates"]) || !Array.isArray(decoded.candidates)) {
		return null;
	}

	const blockById = new Map(blocks.map((block) => [block.id, block]));
	const candidates: EvidenceCandidate[] = [];
	for (const rawCandidate of decoded.candidates) {
		const candidate = decodeCandidate(rawCandidate, input.sourceId, blockById);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

interface DecodedPageCandidates {
	candidates: EvidenceCandidate[];
	malformed: number;
	responded: boolean;
}

function decodePageCandidates(
	text: string,
	inputs: readonly IdentifiedSelectionInput[],
	blocks: readonly EvidenceBlock[],
): DecodedPageCandidates[] | null {
	let decoded: unknown;
	try {
		decoded = parseJsonResponse(text);
	} catch {
		return null;
	}
	if (!isRecord(decoded) || !hasExactKeys(decoded, ["pages"]) || !Array.isArray(decoded.pages)) {
		return null;
	}

	const results = inputs.map((): DecodedPageCandidates => ({
		candidates: [],
		malformed: 0,
		responded: false,
	}));
	const indexByPageId = new Map(inputs.map((input, index) => [input.pageId, index]));
	const blockById = new Map(blocks.map((block) => [block.id, block]));
	let unassignedMalformed = 0;

	for (const rawPage of decoded.pages) {
		if (!isRecord(rawPage) || typeof rawPage.page_id !== "string") {
			unassignedMalformed += 1;
			continue;
		}
		const resultIndex = indexByPageId.get(rawPage.page_id);
		if (resultIndex === undefined) {
			unassignedMalformed += 1;
			continue;
		}
		const result = results[resultIndex];
		if (result.responded) {
			result.malformed += 1;
			continue;
		}
		result.responded = true;
		if (!hasExactKeys(rawPage, ["candidates", "page_id"]) || !Array.isArray(rawPage.candidates)) {
			result.malformed += 1;
			continue;
		}
		for (const rawCandidate of rawPage.candidates) {
			const candidate = decodeCandidate(rawCandidate, inputs[resultIndex].sourceId, blockById);
			if (candidate) result.candidates.push(candidate);
			else result.malformed += 1;
		}
	}

	if (unassignedMalformed > 0) {
		for (const result of results) result.malformed += unassignedMalformed;
	}
	for (const result of results) {
		if (!result.responded) result.malformed += 1;
	}
	return results;
}

function batchPages(inputs: readonly IdentifiedSelectionInput[]): IdentifiedSelectionInput[][] {
	const batches: IdentifiedSelectionInput[][] = [];
	let current: IdentifiedSelectionInput[] = [];
	let currentCharacters = 0;
	for (const input of inputs) {
		const inputCharacters = JSON.stringify({
			page_id: input.pageId,
			page_path: input.pagePath,
			page_body: input.pageBody,
		}).length;
		if (current.length > 0 && currentCharacters + inputCharacters > MAX_PAGE_BATCH_CHARACTERS) {
			batches.push(current);
			current = [];
			currentCharacters = 0;
		}
		current.push(input);
		currentCharacters += inputCharacters;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function addCode(codes: EvidenceSelectionCode[], code: EvidenceSelectionCode): void {
	if (!codes.includes(code)) codes.push(code);
}

class ModelEvidenceSelector implements EvidenceCandidateSelector {
	constructor(
		private readonly model: Model<any>,
		private readonly modelRegistry: ModelRegistry,
	) {}

	async select(input: EvidenceSelectionInput): Promise<readonly EvidenceCandidate[]> {
		if (input.blocks.length === 0) return [];
		try {
			const auth = await this.modelRegistry.getApiKeyAndHeaders(this.model);
			if (!auth.ok || !auth.apiKey) return [];

			const selected: EvidenceCandidate[] = [];
			for (const blocks of batchCompleteBlocks(input.blocks)) {
				const response = await complete(
					this.model,
					{
						messages: [{
							role: "user" as const,
							content: [{ type: "text" as const, text: selectionPrompt(input, blocks) }],
							timestamp: Date.now(),
						}],
					},
					{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048 },
				);
				if (response.stopReason === "error") return selected;
				const decoded = decodeBatchCandidates(responseText(response), input, blocks);
				if (decoded === null) continue;
				selected.push(...decoded);
			}
			return selected;
		} catch {
			return [];
		}
	}

	async selectMany(inputs: readonly EvidenceSelectionInput[]): Promise<readonly EvidenceSelectionOutcome[]> {
		if (inputs.length === 0) return [];
		const outcomes = inputs.map(() => ({
			candidates: [] as EvidenceCandidate[],
			codes: [] as EvidenceSelectionCode[],
			rejected: 0,
		}));
		let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
		try {
			auth = await this.modelRegistry.getApiKeyAndHeaders(this.model);
		} catch {
			for (const outcome of outcomes) {
				addCode(outcome.codes, "selector-error");
				outcome.rejected += 1;
			}
			return outcomes;
		}
		if (!auth.ok || !auth.apiKey) {
			for (const outcome of outcomes) {
				addCode(outcome.codes, "selector-auth-unavailable");
				outcome.rejected += 1;
			}
			return outcomes;
		}

		const grouped = new Map<string, number[]>();
		for (const [index, input] of inputs.entries()) {
			const key = `${input.sourceId}\u0000${JSON.stringify(input.blocks)}`;
			const indices = grouped.get(key) ?? [];
			indices.push(index);
			grouped.set(key, indices);
		}

		for (const indices of grouped.values()) {
			const identified = indices.map((inputIndex) => ({
				...inputs[inputIndex],
				pageId: `page-${inputIndex + 1}`,
			}));
			const evidenceBatches = batchCompleteBlocks(identified[0].blocks);
			if (evidenceBatches.length === 0) continue;
			for (const pageBatch of batchPages(identified)) {
				for (const blocks of evidenceBatches) {
					let response: Awaited<ReturnType<typeof complete>>;
					try {
						response = await complete(
							this.model,
							{
								messages: [{
									role: "user" as const,
									content: [{ type: "text" as const, text: batchSelectionPrompt(pageBatch, blocks) }],
									timestamp: Date.now(),
								}],
							},
							{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096 },
						);
					} catch {
						for (const input of pageBatch) {
							const outcome = outcomes[Number(input.pageId.slice(5)) - 1];
							addCode(outcome.codes, "selector-error");
							outcome.rejected += 1;
						}
						continue;
					}
					if (response.stopReason === "error") {
						for (const input of pageBatch) {
							const outcome = outcomes[Number(input.pageId.slice(5)) - 1];
							addCode(outcome.codes, "selector-provider-error");
							outcome.rejected += 1;
						}
						continue;
					}
					const decoded = decodePageCandidates(responseText(response), pageBatch, blocks);
					if (decoded === null) {
						for (const input of pageBatch) {
							const outcome = outcomes[Number(input.pageId.slice(5)) - 1];
							addCode(outcome.codes, "selector-malformed-response");
							outcome.rejected += 1;
						}
						continue;
					}
					for (const [pageIndex, result] of decoded.entries()) {
						const input = pageBatch[pageIndex];
						const outcome = outcomes[Number(input.pageId.slice(5)) - 1];
						outcome.candidates.push(...result.candidates);
						outcome.rejected += result.malformed;
						if (result.malformed > 0) addCode(outcome.codes, "selector-malformed-response");
					}
				}
			}
		}

		for (const outcome of outcomes) {
			if (outcome.candidates.length === 0 && outcome.codes.length === 0) {
				addCode(outcome.codes, "selector-zero-candidates");
			}
		}
		return outcomes;
	}
}

export function createModelEvidenceSelector(
	model: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
): EvidenceCandidateSelector | null {
	return model && modelRegistry ? new ModelEvidenceSelector(model, modelRegistry) : null;
}
