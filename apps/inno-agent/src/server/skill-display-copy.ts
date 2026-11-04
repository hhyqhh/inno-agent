import { readJson, writeJson } from "../storage/file-store.js";
import { logger } from "../logger.js";

export interface SkillDisplayInput {
	name: string;
	description: string;
}

export interface LocalizedSkillText {
	zh: string;
	en: string;
}

export interface SkillDisplayCopy {
	displayName: LocalizedSkillText;
	description: LocalizedSkillText;
}

export type SkillDisplayCopies = Record<string, SkillDisplayCopy>;

type Completion = (prompt: string, maxTokens?: number, timeoutMs?: number) => Promise<string>;

interface CacheFile {
	version: 1;
	entries: SkillDisplayCopies;
}

const MAX_SOURCE_DESCRIPTION = 6_000;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 320;

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function validCopy(value: unknown): SkillDisplayCopy | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const displayName = candidate.displayName as Record<string, unknown> | undefined;
	const description = candidate.description as Record<string, unknown> | undefined;
	const copy: SkillDisplayCopy = {
		displayName: {
			zh: cleanText(displayName?.zh, MAX_DISPLAY_NAME),
			en: cleanText(displayName?.en, MAX_DISPLAY_NAME),
		},
		description: {
			zh: cleanText(description?.zh, MAX_DESCRIPTION),
			en: cleanText(description?.en, MAX_DESCRIPTION),
		},
	};
	return Object.values(copy.displayName).every(Boolean) && Object.values(copy.description).every(Boolean) ? copy : null;
}

/** Parse the model's JSON array while tolerating a Markdown code fence. */
function parseGeneratedCopies(raw: string, inputs: SkillDisplayInput[]): SkillDisplayCopies {
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start < 0 || end <= start) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return {};
	}
	if (!Array.isArray(parsed)) return {};
	const inputNames = new Set(inputs.map((item) => item.name));
	const copies: SkillDisplayCopies = {};
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "string" || !inputNames.has(record.id)) continue;
		const copy = validCopy(record);
		if (copy) copies[record.id] = copy;
	}
	return copies;
}

function buildPrompt(inputs: SkillDisplayInput[]): string {
	const source = inputs.map((item) => ({
		id: item.name,
		name: item.name,
		description: item.description.slice(0, MAX_SOURCE_DESCRIPTION),
	}));
	return [
		"Polish skill metadata for the management UI of a personal learning agent.",
		"For every input item, provide a natural display name and one plain, helpful sentence describing what the skill lets the user do.",
		"Write both Simplified Chinese (zh) and English (en). Preserve product names and useful technical terms, but remove trigger-word lists, routing instructions, and implementation trivia.",
		"Keep display names concise. Do not invent capabilities. Return only a JSON array with this exact shape:",
		'[{"id":"original id","displayName":{"zh":"...","en":"..."},"description":{"zh":"...","en":"..."}}]',
		"Input:",
		JSON.stringify(source),
	].join("\n\n");
}

/**
 * Persistent, name-keyed AI display-copy cache. Existing entries are retained
 * even when upstream descriptions change; only never-seen skills are sent to
 * the model. Concurrent batches are serialized and re-check the cache so they
 * cannot generate the same new skill twice.
 */
export class SkillDisplayCopyService {
	private cache: CacheFile | null = null;
	private generationQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly complete: Completion,
	) {}

	private readCache(): CacheFile {
		if (!this.cache) {
			const stored = readJson<Partial<CacheFile>>(this.filePath, { version: 1, entries: {} });
			this.cache = { version: 1, entries: stored.entries && typeof stored.entries === "object" ? stored.entries : {} };
		}
		return this.cache;
	}

	private select(inputs: SkillDisplayInput[]): SkillDisplayCopies {
		const entries = this.readCache().entries;
		const selected: SkillDisplayCopies = {};
		for (const input of inputs) {
			const copy = validCopy(entries[input.name]);
			if (copy) selected[input.name] = copy;
		}
		return selected;
	}

	private async generateMissing(inputs: SkillDisplayInput[]): Promise<void> {
		const entries = this.readCache().entries;
		const missing = inputs.filter((item) => !validCopy(entries[item.name]));
		if (!missing.length) return;
		try {
			const response = await this.complete(buildPrompt(missing), 6_000, 90_000);
			const generated = parseGeneratedCopies(response, missing);
			if (!Object.keys(generated).length) return;
			Object.assign(entries, generated);
			writeJson(this.filePath, this.readCache());
		} catch (err) {
			// Display metadata is best-effort and must never break skill management.
			logger.warn({ err }, "failed to generate skill display copy");
		}
	}

	async getCopies(inputs: SkillDisplayInput[]): Promise<SkillDisplayCopies> {
		const missing = inputs.filter((item) => !validCopy(this.readCache().entries[item.name]));
		if (missing.length) {
			const run = this.generationQueue.then(() => this.generateMissing(missing));
			this.generationQueue = run;
			await run;
		}
		return this.select(inputs);
	}
}
