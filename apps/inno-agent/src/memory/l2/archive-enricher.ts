import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { readText } from "../../storage/file-store.js";
import { summarizeContent } from "./summarizer.js";
import type { ManifestEntry } from "./types.js";
import { createSourcePage, updateSourcePage } from "./wiki-maintainer.js";
import { maintainLinkedWikiPages, type WikiLinkMaintenanceResult } from "./wiki-linker.js";

export interface ArchiveModelContext {
	model: Model<any>;
	modelRegistry: ModelRegistry;
}

export interface EnrichedSourcePagesResult {
	wikiPagePath: string;
	summaryBody: string;
	linkMaintenance: WikiLinkMaintenanceResult;
}

/** Create source summary page with optional LLM summary and linked concept/entity pages. */
export async function createEnrichedSourcePages(
	l2DataDir: string,
	entry: ManifestEntry,
	title: string,
	extractedPath: string,
	fallbackSummary: string,
	ctx?: ArchiveModelContext,
): Promise<EnrichedSourcePagesResult> {
	const extractedContent = readText(join(l2DataDir, extractedPath));
	let summaryBody = fallbackSummary || `## 摘要\n\n${extractedContent}`;
	if (ctx) {
		const summary = await summarizeContent(ctx.model, ctx.modelRegistry, title, extractedContent);
		if (summary) summaryBody = summary;
	}
	const wikiPagePath = createSourcePage(l2DataDir, entry, summaryBody, extractedPath);
	const linkMaintenance = await maintainLinkedWikiPages(
		l2DataDir,
		entry,
		wikiPagePath,
		summaryBody,
		ctx?.model,
		ctx?.modelRegistry,
	);
	return { wikiPagePath, summaryBody, linkMaintenance };
}

/** Refresh an existing source page (e.g. after note attachments are merged in). */
export async function updateEnrichedSourcePages(
	l2DataDir: string,
	entry: ManifestEntry,
	title: string,
	extractedPath: string,
	fallbackSummary: string,
	ctx?: ArchiveModelContext,
	extraRawPaths: string[] = [],
): Promise<EnrichedSourcePagesResult> {
	const extractedContent = readText(join(l2DataDir, extractedPath));
	let summaryBody = fallbackSummary || `## 摘要\n\n${extractedContent}`;
	if (ctx) {
		const summary = await summarizeContent(ctx.model, ctx.modelRegistry, title, extractedContent);
		if (summary) summaryBody = summary;
	}
	const existingPage = entry.wikiPages.find((page) => page.includes("wiki/sources/"));
	const wikiPagePath = existingPage ?? createSourcePage(l2DataDir, entry, summaryBody, extractedPath);
	if (existingPage) {
		updateSourcePage(l2DataDir, entry, existingPage, summaryBody, extractedPath, extraRawPaths);
	}
	const linkMaintenance = await maintainLinkedWikiPages(
		l2DataDir,
		entry,
		wikiPagePath,
		summaryBody,
		ctx?.model,
		ctx?.modelRegistry,
	);
	return { wikiPagePath, summaryBody, linkMaintenance };
}
