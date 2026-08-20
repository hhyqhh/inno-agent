import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	type BigIntStats,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { wikiPathJoin } from "./wiki-paths.js";
import { parse as parseYaml } from "yaml";

import { fileExists } from "../../storage/file-store.js";
import {
	inspectEvidenceIndex,
	listEvidenceIndexFileNames,
	readEvidenceIndex,
	type EvidenceIndexReadResult,
} from "./evidence-index.js";
import { resolveEvidenceCandidates } from "./evidence-resolver.js";
import { decodeEvidenceRefs, type EvidenceReferenceIssue } from "./evidence-types.js";
import { resolveRawSourcePath } from "./source-path.js";
import { readSourceRevision } from "./source-revision.js";
import type { ManifestEntry, WikiPageFrontmatter, WikiPageType } from "./types.js";
import { buildAliasIndex, extractOutgoingLinks } from "./wiki-links.js";
import { bodyRevision, parseFrontmatter } from "./wiki-maintainer.js";

const PAGE_DIRS = ["sources", "entities", "concepts", "analysis"] as const;
const REQUIRED_FIELDS = ["title", "created", "type", "tags", "sources", "source_ids", "updated", "status", "confidence"] as const;
const VALID_TYPES = new Set<WikiPageType>(["source-summary", "entity", "concept", "analysis"]);
const VALID_STATUSES = new Set(["draft", "reviewed", "outdated"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

export type L2LintSeverity = "error" | "warning";
export type L2LintCode =
	| "missing_frontmatter"
	| "invalid_frontmatter"
	| "missing_required_field"
	| "invalid_field_value"
	| "missing_provenance"
	| "dangling_link"
	| "unknown_source_id"
	| "missing_source_file"
	| "manifest_page_missing"
	| "index_missing_page"
	| "index_stale_page"
	| "incomplete_archive"
	| "missing_evidence_index"
	| "corrupt_evidence_index"
	| "evidence_index_version_mismatch"
	| "stale_evidence_index"
	| "orphan_evidence_index"
	| "evidence_source_revision_mismatch"
	| "evidence_page_revision_mismatch"
	| "invalid_evidence_ref"
	| "invalid_evidence_quote"
	| "invalid_evidence_revision"
	| "invalid_evidence_locator"
	| "evidence_quote_mismatch"
	| "evidence_locator_mismatch"
	| "unsafe_manifest_path"
	| "unsafe_wiki_path"
	| "invalid_wiki_index_path";

export interface L2LintFinding {
	code: L2LintCode;
	severity: L2LintSeverity;
	path: string;
	message: string;
}

export interface L2LintReport {
	pagesChecked: number;
	sourcesChecked: number;
	errors: number;
	warnings: number;
	findings: L2LintFinding[];
}

interface PageRecord {
	path: string;
	title: string;
	body: string;
	frontmatter: WikiPageFrontmatter | null;
	rawFrontmatter: Record<string, unknown> | null;
}

interface SourceEvidenceState {
	entry: ManifestEntry;
	rawContentHash?: string;
	indexResult?: EvidenceIndexReadResult;
}

interface WikiPageInput {
	path: string;
	content: string;
}

interface WikiTreeInspection {
	pages: WikiPageInput[];
	indexContent: string;
	complete: boolean;
}

const PRECISE_SOURCE_TYPES = new Set(["pdf", "word", "markdown"]);
const FULL_LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const DISPLAYABLE_SOURCE_ID = /^l2src_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_INDEXED_WIKI_PATH = /^wiki\/(?:sources|entities|concepts|analysis)\/[^/\\]+\.md$/u;
const WINDOWS_FORBIDDEN_OR_CONTROL = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function isSafeWikiFileName(fileName: string): boolean {
	return fileName.endsWith(".md")
		&& !WINDOWS_FORBIDDEN_OR_CONTROL.test(fileName)
		&& !WINDOWS_RESERVED_NAME.test(fileName)
		&& !fileName.endsWith(".")
		&& !fileName.endsWith(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function sourceIdContext(sourceId: string): string {
	return DISPLAYABLE_SOURCE_ID.test(sourceId)
		? sourceId
		: `legacy:${sha256(sourceId).slice(0, 12)}`;
}

function evidenceIndexRelativePath(sourceId: string): string {
	return `extracted/evidence/by-id/${sha256(sourceId)}.json`;
}

function evidenceIndexCode(result: EvidenceIndexReadResult): L2LintCode | null {
	switch (result.status) {
		case "ready": return null;
		case "missing-index": return "missing_evidence_index";
		case "corrupt-index": return "corrupt_evidence_index";
		case "index-version-mismatch": return "evidence_index_version_mismatch";
		case "stale-source": return "stale_evidence_index";
	}
}

function evidenceIndexMessage(code: L2LintCode, sourceId: string, ordinal?: number): string {
	const displaySourceId = sourceIdContext(sourceId);
	const context = ordinal === undefined
		? `Source ${displaySourceId}`
		: `Evidence reference ${ordinal} for source ${displaySourceId}`;
	switch (code) {
		case "missing_evidence_index": return `${context} has no evidence index.`;
		case "corrupt_evidence_index": return `${context} uses a corrupt evidence index.`;
		case "evidence_index_version_mismatch": return `${context} uses an incompatible evidence index version.`;
		case "stale_evidence_index": return `${context} uses an index for a different raw revision.`;
		default: return `${context} has an evidence index problem.`;
	}
}

function decodeIssueCode(issue: EvidenceReferenceIssue, rawReference: unknown): L2LintCode {
	if (issue.code === "invalid-quote") return "invalid_evidence_quote";
	if (issue.code === "invalid-locator") return "invalid_evidence_locator";
	if (issue.code === "invalid-revision") {
		return isRecord(rawReference) && rawReference.index_version !== 1
			? "evidence_index_version_mismatch"
			: "invalid_evidence_revision";
	}
	return "invalid_evidence_ref";
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

function fileExistsWithin(root: string, relativePath: string): boolean {
	const absoluteRoot = resolve(root);
	const target = resolve(absoluteRoot, relativePath);
	const fromRoot = relative(absoluteRoot, target);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return false;
	return fileExists(target);
}

function finding(code: L2LintCode, severity: L2LintSeverity, path: string, message: string): L2LintFinding {
	return { code, severity, path: normalizePath(path), message };
}

function equalFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function sameFileObject(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return sameFileObject(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

type PlainDirectoryResult =
	| { status: "ready"; path: string }
	| { status: "missing" | "unsafe" };

function resolvePlainDirectory(path: string): PlainDirectoryResult {
	const absolute = resolve(path);
	try {
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return { status: "unsafe" };
		const canonical = realpathSync.native(absolute);
		return equalFilesystemPath(absolute, canonical)
			? { status: "ready", path: canonical }
			: { status: "unsafe" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "missing" }
			: { status: "unsafe" };
	}
}

type PlainFileReadResult =
	| { status: "ready"; content: string }
	| { status: "missing" | "unsafe" };

function readPlainFile(parentPath: string, expectedParentPath: string, fileName: string): PlainFileReadResult {
	const candidate = join(parentPath, fileName);
	let descriptor: number | undefined;
	let candidateObserved = false;
	try {
		const initial = lstatSync(candidate, { bigint: true });
		candidateObserved = true;
		if (initial.isSymbolicLink() || !initial.isFile()) return { status: "unsafe" };
		descriptor = openSync(candidate, "r");
		const opened = fstatSync(descriptor, { bigint: true });
		const current = lstatSync(candidate, { bigint: true });
		const parent = resolvePlainDirectory(parentPath);
		if (
			!opened.isFile()
			|| !sameFileObject(opened, initial)
			|| current.isSymbolicLink()
			|| !current.isFile()
			|| !sameFileObject(opened, current)
			|| parent.status !== "ready"
			|| !equalFilesystemPath(parent.path, expectedParentPath)
			|| !equalFilesystemPath(realpathSync.native(candidate), candidate)
		) {
			return { status: "unsafe" };
		}

		const bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor, { bigint: true });
		const finalCurrent = lstatSync(candidate, { bigint: true });
		const finalParent = resolvePlainDirectory(parentPath);
		if (
			!sameFileSnapshot(opened, after)
			|| finalCurrent.isSymbolicLink()
			|| !finalCurrent.isFile()
			|| !sameFileSnapshot(after, finalCurrent)
			|| finalParent.status !== "ready"
			|| !equalFilesystemPath(finalParent.path, expectedParentPath)
			|| !equalFilesystemPath(realpathSync.native(candidate), candidate)
		) {
			return { status: "unsafe" };
		}
		return { status: "ready", content: bytes.toString("utf8") };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" && !candidateObserved
			? { status: "missing" }
			: { status: "unsafe" };
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The containment/read result is more useful than a close failure.
			}
		}
	}
}

function inspectManifest(l2DataDir: string, findings: L2LintFinding[]): ManifestEntry[] {
	const root = resolvePlainDirectory(l2DataDir);
	if (root.status !== "ready") {
		findings.push(finding(
			"unsafe_manifest_path",
			"error",
			"manifest.jsonl",
			"Manifest path is unsafe or unreadable.",
		));
		return [];
	}

	const manifest = readPlainFile(root.path, root.path, "manifest.jsonl");
	if (manifest.status !== "ready") {
		if (manifest.status === "unsafe") {
			findings.push(finding(
				"unsafe_manifest_path",
				"error",
				"manifest.jsonl",
				"Manifest path is unsafe or unreadable.",
			));
		}
		return [];
	}

	const entries: ManifestEntry[] = [];
	for (const line of manifest.content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as ManifestEntry);
		} catch {
			// Preserve the manifest store's compatibility behavior for malformed legacy lines.
		}
	}
	return entries;
}

function inspectWikiTree(l2DataDir: string, findings: L2LintFinding[]): WikiTreeInspection {
	const pages: WikiPageInput[] = [];
	let complete = true;
	const unsafePaths = new Set<string>();
	const reportUnsafe = (path: string): void => {
		complete = false;
		if (unsafePaths.has(path)) return;
		unsafePaths.add(path);
		findings.push(finding("unsafe_wiki_path", "error", path, "Wiki path is unsafe or unreadable."));
	};

	const root = resolvePlainDirectory(l2DataDir);
	if (root.status !== "ready") {
		reportUnsafe("wiki");
		return { pages, indexContent: "", complete };
	}
	const wiki = resolvePlainDirectory(join(root.path, "wiki"));
	if (wiki.status === "missing") return { pages, indexContent: "", complete };
	if (wiki.status !== "ready") {
		reportUnsafe("wiki");
		return { pages, indexContent: "", complete };
	}

	for (const directory of PAGE_DIRS) {
		const relativeDirectory = wikiPathJoin("wiki", directory);
		const category = resolvePlainDirectory(join(wiki.path, directory));
		if (category.status === "missing") continue;
		if (category.status !== "ready") {
			reportUnsafe(relativeDirectory);
			continue;
		}
		let entries;
		try {
			entries = readdirSync(category.path, { withFileTypes: true });
		} catch {
			reportUnsafe(relativeDirectory);
			continue;
		}
		const verifiedCategory = resolvePlainDirectory(category.path);
		if (verifiedCategory.status !== "ready" || !equalFilesystemPath(verifiedCategory.path, category.path)) {
			reportUnsafe(relativeDirectory);
			continue;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.name.endsWith(".md")) continue;
			if (
				entry.isSymbolicLink()
				|| !entry.isFile()
				|| entry.name.includes("/")
				|| entry.name.includes("\\")
				|| !isSafeWikiFileName(entry.name)
			) {
				reportUnsafe(relativeDirectory);
				continue;
			}
			const page = readPlainFile(category.path, category.path, entry.name);
			if (page.status !== "ready") {
				reportUnsafe(relativeDirectory);
				continue;
			}
			pages.push({ path: wikiPathJoin("wiki", directory, entry.name), content: page.content });
		}
	}

	const index = readPlainFile(wiki.path, wiki.path, "index.md");
	if (index.status === "unsafe") reportUnsafe("wiki/index.md");
	return { pages, indexContent: index.status === "ready" ? index.content : "", complete };
}

function readPage(path: string, content: string, findings: L2LintFinding[]): PageRecord {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		findings.push(finding("missing_frontmatter", "error", path, "Page has no complete YAML frontmatter block."));
		return {
			path,
			title: basename(path, extname(path)),
			body: content,
			frontmatter: null,
			rawFrontmatter: null,
		};
	}

	let rawFrontmatter: Record<string, unknown> | null = null;
	try {
		const parsed = parseYaml(match[1]) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frontmatter must be a mapping");
		rawFrontmatter = parsed as Record<string, unknown>;
	} catch {
		findings.push(finding("invalid_frontmatter", "error", path, "YAML frontmatter cannot be parsed."));
		return {
			path,
			title: basename(path, extname(path)),
			body: match[2],
			frontmatter: null,
			rawFrontmatter: null,
		};
	}

	for (const field of REQUIRED_FIELDS) {
		if (!(field in rawFrontmatter)) {
			findings.push(finding("missing_required_field", "error", path, `Frontmatter is missing required field: ${field}.`));
		}
	}

	const { frontmatter, body } = parseFrontmatter(content);
	if (frontmatter) {
		if (!VALID_TYPES.has(frontmatter.type)) {
			findings.push(finding("invalid_field_value", "error", path, "Page has an unknown type."));
		}
		if (!VALID_STATUSES.has(frontmatter.status)) {
			findings.push(finding("invalid_field_value", "error", path, "Page has an unknown status."));
		}
		if (!VALID_CONFIDENCE.has(frontmatter.confidence)) {
			findings.push(finding("invalid_field_value", "error", path, "Page has an unknown confidence value."));
		}
		if (frontmatter.type !== "analysis" && frontmatter.source_ids.length === 0) {
			findings.push(finding("missing_provenance", "warning", path, "Knowledge page has no source_ids provenance."));
		}
	}

	return {
		path,
		title: frontmatter?.title || basename(path, extname(path)),
		body,
		frontmatter,
		rawFrontmatter,
	};
}

function indexedWikiPaths(index: string, findings: L2LintFinding[]): { paths: Set<string>; valid: boolean } {
	const paths = new Set<string>();
	let valid = true;
	const pattern = /`(wiki[\\/](?:sources|entities|concepts|analysis)[\\/][^`]+\.md)`/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(index)) !== null) {
		const path = normalizePath(match[1]);
		const fileName = path.slice(path.lastIndexOf("/") + 1);
		if (
			!SAFE_INDEXED_WIKI_PATH.test(path)
			|| !isSafeWikiFileName(fileName)
		) {
			valid = false;
			continue;
		}
		paths.add(path);
	}
	if (!valid) {
		findings.push(finding(
			"invalid_wiki_index_path",
			"error",
			"wiki/index.md",
			"Wiki index contains an invalid page path.",
		));
	}
	return { paths, valid };
}

/** Run deterministic, read-only structural checks over one L2 Wiki root. */
export function runL2Lint(l2DataDir: string): L2LintReport {
	const findings: L2LintFinding[] = [];
	const manifest = inspectManifest(l2DataDir, findings);
	const manifestIds = new Set(manifest.map((entry) => entry.id));
	const wikiTree = inspectWikiTree(l2DataDir, findings);
	const actualPagePaths = new Set(wikiTree.pages.map((page) => normalizePath(page.path)));
	const pages = wikiTree.pages.map((page) => readPage(page.path, page.content, findings));

	const alias = buildAliasIndex(pages);
	for (const page of pages) {
		for (const link of extractOutgoingLinks(page.body)) {
			if (!alias.resolve(link)) {
				findings.push(finding("dangling_link", "warning", page.path, "Page contains an unresolved wikilink."));
			}
		}
		for (const sourceId of page.frontmatter?.source_ids ?? []) {
			if (!manifestIds.has(sourceId)) {
				findings.push(finding(
					"unknown_source_id",
					"error",
					page.path,
					`source_ids references unknown manifest id: ${sourceIdContext(sourceId)}.`,
				));
			}
		}
		for (const sourcePath of page.frontmatter?.sources ?? []) {
			if (sourcePath && !fileExistsWithin(l2DataDir, sourcePath)) {
				findings.push(finding("missing_source_file", "error", page.path, "Page references a missing source file."));
			}
		}
	}

	const evidenceStates = new Map<string, SourceEvidenceState>();
	for (const entry of manifest) {
		const displaySourceId = sourceIdContext(entry.id);
		if (entry.status !== "indexed") {
			findings.push(finding("incomplete_archive", "warning", "manifest.jsonl", `Source ${displaySourceId} is not indexed.`));
		}
		const rawPaths = resolveRawSourcePath(l2DataDir, entry);
		const rawRevision = readSourceRevision(rawPaths);
		if (rawRevision.status !== "ready") {
			findings.push(finding("missing_source_file", "error", "manifest.jsonl", `Source ${displaySourceId} is missing a safe raw file.`));
		}
		if (entry.extractedPath && !fileExistsWithin(l2DataDir, entry.extractedPath)) {
			findings.push(finding("missing_source_file", "error", "manifest.jsonl", `Source ${displaySourceId} is missing an extracted file.`));
		}
		for (const pagePath of entry.wikiPages) {
			if (wikiTree.complete && !actualPagePaths.has(normalizePath(pagePath))) {
				findings.push(finding("manifest_page_missing", "error", "manifest.jsonl", `Source ${displaySourceId} references a missing Wiki page.`));
			}
		}

		const rawContentHash = rawRevision.status === "ready" ? rawRevision.rawContentHash : undefined;
		if (rawContentHash && entry.rawContentHash && rawContentHash !== entry.rawContentHash) {
			findings.push(finding(
				"evidence_source_revision_mismatch",
				"error",
				"manifest.jsonl",
				`Source ${displaySourceId} raw revision differs from its manifest revision.`,
			));
		}
		let indexResult: EvidenceIndexReadResult | undefined;
		if (PRECISE_SOURCE_TYPES.has(entry.sourceType)) {
			const expectedHash = rawContentHash
				?? (entry.rawContentHash && FULL_LOWERCASE_SHA256.test(entry.rawContentHash) ? entry.rawContentHash : undefined);
			if (expectedHash) {
				indexResult = readEvidenceIndex(l2DataDir, entry.id, expectedHash);
			} else {
				indexResult = inspectEvidenceIndex(l2DataDir, entry.id);
			}
			if (entry.status === "indexed") {
				const code = indexResult ? evidenceIndexCode(indexResult) : null;
				if (code) {
					findings.push(finding(
						code,
						"error",
						evidenceIndexRelativePath(entry.id),
						evidenceIndexMessage(code, entry.id),
					));
				}
			}
		}
		evidenceStates.set(entry.id, { entry, rawContentHash, indexResult });
	}

	const expectedEvidenceIndexes = new Set(
		manifest
			.filter((entry) => PRECISE_SOURCE_TYPES.has(entry.sourceType))
			.map((entry) => `${sha256(entry.id)}.json`),
	);
	const evidenceFiles = listEvidenceIndexFileNames(l2DataDir);
	if (evidenceFiles.status === "unsafe") {
		findings.push(finding(
			"corrupt_evidence_index",
			"error",
			"extracted/evidence/by-id",
			"Evidence index directory is unsafe or unreadable.",
		));
	} else if (evidenceFiles.status === "ready") {
		for (const file of evidenceFiles.fileNames) {
			if (!expectedEvidenceIndexes.has(file)) {
				findings.push(finding(
					"orphan_evidence_index",
					"warning",
					"extracted/evidence/by-id",
					"Evidence index has no precise manifest source.",
				));
			}
		}
	}

	for (const page of pages) {
		if (!page.frontmatter) continue;
		const persistedEvidenceRefs = page.rawFrontmatter?.evidence_refs;
		const rawReferences = persistedEvidenceRefs === undefined
			? []
			: Array.isArray(persistedEvidenceRefs)
				? persistedEvidenceRefs
				: [persistedEvidenceRefs];
		const currentPageRevision = bodyRevision(page.body);
		const seenPageMarkers = new Set<number>();
		for (const [ordinal, rawReference] of rawReferences.entries()) {
			const decoded = decodeEvidenceRefs([rawReference], page.frontmatter.source_ids);
			const issue = decoded.issues[0];
			if (issue) {
				const code = decodeIssueCode(issue, rawReference);
				const sourceContext = issue.sourceId ? ` for source ${sourceIdContext(issue.sourceId)}` : "";
				findings.push(finding(
					code,
					"error",
					page.path,
					`Evidence reference ${ordinal}${sourceContext} is invalid (${issue.code}).`,
				));
				continue;
			}

			const reference = decoded.valid[0];
			if (!reference) continue;
			if (reference.marker !== undefined) {
				if (seenPageMarkers.has(reference.marker)) {
					findings.push(finding(
						"invalid_evidence_ref",
						"error",
						page.path,
						`Evidence reference ${ordinal} reuses inline marker ${reference.marker}.`,
					));
					continue;
				}
				seenPageMarkers.add(reference.marker);
			}
			const state = evidenceStates.get(reference.source_id);
			if (!state) continue;
			if (!PRECISE_SOURCE_TYPES.has(state.entry.sourceType)) {
				findings.push(finding(
					"invalid_evidence_ref",
					"error",
					page.path,
					`Evidence reference ${ordinal} uses non-precise source ${sourceIdContext(reference.source_id)}.`,
				));
				continue;
			}
			if (state.rawContentHash && reference.source_revision !== `sha256:${state.rawContentHash}`) {
				findings.push(finding(
					"evidence_source_revision_mismatch",
					"error",
					page.path,
					`Evidence reference ${ordinal} for source ${sourceIdContext(reference.source_id)} has a stale source revision.`,
				));
			}
			if (reference.page_revision !== currentPageRevision) {
				findings.push(finding(
					"evidence_page_revision_mismatch",
					"warning",
					page.path,
					`Evidence reference ${ordinal} for source ${sourceIdContext(reference.source_id)} has a stale page revision.`,
				));
			}
			if (!state.rawContentHash || !state.indexResult) continue;
			const indexCode = evidenceIndexCode(state.indexResult);
			if (indexCode) {
				findings.push(finding(
					indexCode,
					"error",
					page.path,
					evidenceIndexMessage(indexCode, reference.source_id, ordinal),
				));
				continue;
			}
			if (state.indexResult.status !== "ready") continue;

			const resolution = resolveEvidenceCandidates([{
				source_id: reference.source_id,
				block_id: reference.locator.block_id,
				quote: reference.quote,
			}], {
				sourceId: reference.source_id,
				sourceRevision: `sha256:${state.rawContentHash}`,
				pageRevision: currentPageRevision,
				index: state.indexResult.index,
			});
			const rejection = resolution.rejected[0];
			if (rejection) {
				const quoteFailure = rejection.code === "invalid-quote"
					|| rejection.code === "quote-not-found"
					|| rejection.code === "quote-not-unique";
				const code: L2LintCode = quoteFailure ? "evidence_quote_mismatch" : "evidence_locator_mismatch";
				findings.push(finding(
					code,
					"error",
					page.path,
					`Evidence reference ${ordinal} for source ${sourceIdContext(reference.source_id)} failed ${quoteFailure ? "quote" : "locator"} validation.`,
				));
				continue;
			}
			const authoritative = resolution.accepted[0];
			if (!authoritative || JSON.stringify(authoritative.locator) !== JSON.stringify(reference.locator)) {
				findings.push(finding(
					"evidence_locator_mismatch",
					"error",
					page.path,
					`Evidence reference ${ordinal} for source ${sourceIdContext(reference.source_id)} has a non-authoritative locator.`,
				));
			}
		}
	}

	if (wikiTree.complete) {
		const indexed = indexedWikiPaths(wikiTree.indexContent, findings);
		if (indexed.valid) for (const pagePath of actualPagePaths) {
			if (!indexed.paths.has(pagePath)) {
				findings.push(finding("index_missing_page", "warning", "wiki/index.md", `Wiki page is absent from index: ${pagePath}.`));
			}
		}
		if (indexed.valid) for (const pagePath of indexed.paths) {
			if (!actualPagePaths.has(pagePath)) {
				findings.push(finding("index_stale_page", "warning", "wiki/index.md", `Index references missing page: ${pagePath}.`));
			}
		}
	}

	findings.sort((a, b) =>
		a.severity.localeCompare(b.severity) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
	);
	return {
		pagesChecked: pages.length,
		sourcesChecked: manifest.length,
		errors: findings.filter((item) => item.severity === "error").length,
		warnings: findings.filter((item) => item.severity === "warning").length,
		findings,
	};
}

export function formatL2LintReport(report: L2LintReport): string {
	const heading = `L2 Lint：检查 ${report.pagesChecked} 个页面、${report.sourcesChecked} 个来源；${report.errors} 个错误、${report.warnings} 个警告。`;
	if (report.findings.length === 0) return `${heading}\n\n未发现结构问题。`;
	return [
		heading,
		"",
		...report.findings.map((item) => `- [${item.severity}] ${item.code} · \`${item.path}\` — ${item.message}`),
	].join("\n");
}
