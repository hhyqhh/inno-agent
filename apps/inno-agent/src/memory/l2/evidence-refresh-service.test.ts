import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
	buildEvidenceIndex,
	type EvidenceBlock,
	writeEvidenceIndexAtomic,
} from "./evidence-index.js";
import type { EvidenceCandidate } from "./evidence-selector.js";
import type { EvidenceRef } from "./evidence-types.js";
import { upsertManifest } from "./manifest-store.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import {
	bodyRevision,
	fileRevision,
	parseFrontmatter,
	serializeFrontmatter,
} from "./wiki-maintainer.js";
import {
	EvidenceRefreshService,
	type EvidenceRefreshError,
} from "./evidence-refresh-service.js";
import { WikiPageWriteQueue } from "./wiki-page-write-queue.js";

const roots: string[] = [];

function hash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-refresh-service-"));
	for (const category of ["sources", "entities", "concepts", "analysis"]) {
		mkdirSync(join(root, "wiki", category), { recursive: true });
	}
	roots.push(root);
	return root;
}

function makePage(
	root: string,
	refs: unknown[] | undefined,
	body = "# Page\n\nClaim about Alpha.\n",
	): { path: string; content: string } {
	const path = "wiki/concepts/page.md";
	const fm: WikiPageFrontmatter = {
		title: "Page",
		created: "2026-08-16",
		type: "concept",
		tags: ["learning-content"],
		sources: ["raw/uploads/source.md"],
		source_ids: ["l2src_refresh"],
		updated: "2026-08-16",
		status: "draft",
		confidence: "medium",
		...(refs === undefined ? {} : { evidence_refs: refs }),
	};
	const content = `${serializeFrontmatter(fm)}\n${body}`;
	writeFileSync(join(root, path), content, "utf8");
	return { path, content };
}

function makeSource(
	root: string,
	id = "l2src_refresh",
	fileName = id === "l2src_refresh" ? "source.md" : `${id}.md`,
	text = "# Source\n\nAlpha evidence from the source.\n",
): { entry: ManifestEntry; block: EvidenceBlock } {
	const rawPath = `raw/uploads/${fileName}`;
	const absolute = join(root, rawPath);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	writeFileSync(absolute, text, "utf8");
	const rawContentHash = hash(text);
	const stats = statSync(absolute);
	const entry: ManifestEntry = {
		id,
		title: "Refresh source",
		sourceType: "markdown",
		rawPath,
		wikiPages: ["wiki/concepts/page.md"],
		tags: [],
		contentHash: "legacy",
		rawContentHash,
		rawSize: stats.size,
		rawMtimeMs: stats.mtimeMs,
		rawKind: "uploaded-original",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
	};
	upsertManifest(root, entry);
	const index = buildEvidenceIndex({
		sourceId: entry.id,
		sourceType: "markdown",
		rawContentHash,
		parsed: { text, pageCount: 1, pages: [{ pageNumber: 1, text }] },
	});
	writeEvidenceIndexAtomic(root, index);
	const block = index.blocks.find((candidate) => candidate.text.includes("evidence"));
	if (!block) throw new Error("missing evidence block");
	return { entry, block };
}

function ref(
	entry: ManifestEntry,
	block: EvidenceBlock,
	body: string,
	selectedBy: "model" | "user" = "model",
	page = bodyRevision(body),
): EvidenceRef {
	return {
		source_id: entry.id,
		quote: block.text,
		source_revision: `sha256:${entry.rawContentHash}`,
		page_revision: page,
		index_version: 1,
		selected_by: selectedBy,
		locator: {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph!,
		},
	};
}

function candidate(entry: ManifestEntry, block: EvidenceBlock): EvidenceCandidate {
	return { source_id: entry.id, block_id: block.id, quote: "Alpha evidence" };
}

function service(
	root: string,
	selector: ((input: unknown) => Promise<readonly EvidenceCandidate[]>) | null,
): EvidenceRefreshService {
	return new EvidenceRefreshService({
		l2DataDir: root,
		selector: selector === null ? null : { select: selector },
		writePage: (resolved, content) => {
			writeFileSync(resolved.absolutePath, content, "utf8");
		},
		indexPage: async () => undefined,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("EvidenceRefreshService", () => {
	it("queues filesystem-equivalent Wiki path aliases together", async () => {
		const queue = new WikiPageWriteQueue();
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		let firstStarted = false;
		let secondStarted = false;
		const first = queue.run("wiki\\concepts\\Page.md", async () => {
			firstStarted = true;
			await waiting;
		});
		while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 0));
		const second = queue.run("wiki/concepts/page.md", () => { secondStarted = true; });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondStarted).toBe(process.platform !== "win32");
		release();
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
	});

	it("returns model_unavailable without changing the page", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const before = readFileSync(join(root, old.path));
		const detail = {
			path: old.path,
			content: old.content,
			pageRevision: bodyRevision(body),
			fileRevision: fileRevision(before),
		};

		await expect(service(root, null).refresh({
			path: old.path,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		})).rejects.toMatchObject({ code: "model_unavailable" } satisfies Partial<EvidenceRefreshError>);
		expect(readFileSync(join(root, old.path))).toEqual(before);
	});

	it("keeps old refs when the selector yields no valid candidates", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const bytes = readFileSync(join(root, old.path));
		const detail = {
			pageRevision: bodyRevision(body),
			fileRevision: fileRevision(bytes),
		};

		await expect(service(root, async () => []).refresh({
			path: old.path,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		})).rejects.toMatchObject({ code: "no_valid_candidates" } satisfies Partial<EvidenceRefreshError>);
		expect(readFileSync(join(root, old.path))).toEqual(bytes);
	});

	it("replaces current model refs while preserving user refs", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const other = makeSource(
			root,
			"l2src_other",
			"other.md",
			"# Other\n\nOther evidence from another source.\n",
		);
		const body = "# Page\n\nClaim about Alpha.\n";
		const oldModel = ref(entry, block, "Old body\n");
		const user = ref(entry, block, body, "user");
		const otherModel = ref(other.entry, other.block, body);
		const old = makePage(root, [oldModel, user, otherModel], body);
		const parsedOld = parseFrontmatter(old.content);
		if (!parsedOld.frontmatter) throw new Error("expected frontmatter");
		const content = `${serializeFrontmatter({
			...parsedOld.frontmatter,
			sources: [entry.rawPath, other.entry.rawPath],
			source_ids: [entry.id, other.entry.id],
		})}\n${parsedOld.body}`;
		writeFileSync(join(root, old.path), content, "utf8");
		const bytes = readFileSync(join(root, old.path));
		const detail = {
			pageRevision: bodyRevision(body),
			fileRevision: fileRevision(bytes),
		};

		const updated = await service(root, async () => [candidate(entry, block)]).refresh({
			path: old.path,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});

		expect(updated.provenance.sourceGroups[0]?.references).toHaveLength(2);
		expect(updated.provenance.sourceGroups[0]?.references.every((item) => item.positionStatus === "verified")).toBe(true);
		const parsed = parseFrontmatter(readFileSync(join(root, old.path), "utf8"));
		expect(parsed.frontmatter?.evidence_refs).toHaveLength(3);
		expect((parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>>).some((item) => item.selected_by === "user")).toBe(true);
		expect((parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>>).some((item) => item.source_id === other.entry.id)).toBe(true);
	});

	it("preserves an inline marker when refreshing the same verified model ref", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const marked = { ...ref(entry, block, body), marker: 1 } satisfies EvidenceRef;
		const old = makePage(root, [marked], body);
		const bytes = readFileSync(join(root, old.path));

		const updated = await service(root, async () => [candidate(entry, block)]).refresh({
			path: old.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(bytes),
		});

		const parsed = parseFrontmatter(updated.content);
		const refs = parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>> | undefined;
		expect(refs).toHaveLength(1);
		expect(refs?.[0]?.marker).toBe(1);
	});

	it("does not duplicate a preserved marker when selection repeats one block", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const marked = { ...ref(entry, block, body), marker: 1 } satisfies EvidenceRef;
		const repeated = { source_id: entry.id, block_id: block.id, quote: block.text } satisfies EvidenceCandidate;
		const old = makePage(root, [marked], body);
		const bytes = readFileSync(join(root, old.path));

		const updated = await service(root, async () => [repeated, repeated]).refresh({
			path: old.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(bytes),
		});

		const parsed = parseFrontmatter(updated.content);
		const refs = parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>> | undefined;
		expect(refs).toHaveLength(2);
		expect(refs?.map((item) => item.marker)).toEqual([1, undefined]);
	});

	it("keeps an existing marker ref when refresh selects a different quote in the same block", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha [1].\n";
		const marked = {
			...ref(entry, block, body),
			quote: "Alpha evidence",
			marker: 1,
		} satisfies EvidenceRef;
		const replacement = {
			source_id: entry.id,
			block_id: block.id,
			quote: "from the source",
		} satisfies EvidenceCandidate;
		const old = makePage(root, [marked], body);
		const bytes = readFileSync(join(root, old.path));

		const updated = await service(root, async () => [replacement]).refresh({
			path: old.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(bytes),
		});

		const parsed = parseFrontmatter(updated.content);
		const refs = parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>> | undefined;
		expect(refs).toHaveLength(2);
		expect(refs).toContainEqual(expect.objectContaining({ quote: "Alpha evidence", marker: 1 }));
		expect(refs).toContainEqual(expect.objectContaining({ quote: "from the source" }));
		expect(refs?.filter((item) => item.marker === 1)).toHaveLength(1);
	});

	it("removes stale refs offline but keeps verified refs and source metadata", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const verified = ref(entry, block, body, "user");
		const stale = { ...ref(entry, block, "Old body\n", "user") };
		const old = makePage(root, [verified, stale], body);
		const bytes = readFileSync(join(root, old.path));
		const detail = {
			pageRevision: bodyRevision(body),
			fileRevision: fileRevision(bytes),
		};

		const updated = await service(root, null).removeStale({
			path: old.path,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});
		const parsed = parseFrontmatter(updated.content);
		expect(parsed.frontmatter?.source_ids).toEqual([entry.id]);
		expect(parsed.frontmatter?.sources).toEqual([entry.rawPath]);
		expect(parsed.frontmatter?.evidence_refs).toHaveLength(1);
		expect((parsed.frontmatter?.evidence_refs as Array<Record<string, unknown>>)[0]?.selected_by).toBe("user");
	});

	it("rejects a refresh when the page changes while the selector is running", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const bytes = readFileSync(join(root, old.path));
		const detail = { pageRevision: bodyRevision(body), fileRevision: fileRevision(bytes) };
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const pending = service(root, async () => {
			await waiting;
			return [candidate(entry, block)];
		}).refresh({
			path: old.path,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});

		const newer = `${serializeFrontmatter({
			title: "Page",
			created: "2026-08-16",
			type: "concept",
			tags: ["learning-content"],
			sources: [entry.rawPath],
			source_ids: [entry.id],
			updated: "2026-08-17",
			status: "draft",
			confidence: "medium",
		})}\n${body}`;
		writeFileSync(join(root, old.path), newer, "utf8");
		release();
		await expect(pending).rejects.toMatchObject({ code: "page_changed" } satisfies Partial<EvidenceRefreshError>);
		expect(readFileSync(join(root, old.path), "utf8")).toBe(newer);
	});

	it("allows only one of two refreshes with the same expected revisions to publish", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const bytes = readFileSync(join(root, old.path));
		const expected = { pageRevision: bodyRevision(body), fileRevision: fileRevision(bytes) };
		let calls = 0;
		const releases: Array<() => void> = [];
		const selector = async () => {
			calls += 1;
			await new Promise<void>((resolve) => { releases.push(resolve); });
			return [candidate(entry, block)];
		};
		const action = () => service(root, selector).refresh({
			path: old.path,
			expectedPageRevision: expected.pageRevision,
			expectedFileRevision: expected.fileRevision,
		});
		const first = action();
		const second = action();
		while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 0));
		releases[0]();
		releases[1]();
		const results = await Promise.allSettled([first, second]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected" && (result.reason as EvidenceRefreshError).code === "page_changed")).toHaveLength(1);
	});

	it("serializes refresh and remove-stale against the same expected file revision", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const stale = ref(entry, block, "Old body\n", "model");
		const old = makePage(root, [stale], body);
		const bytes = readFileSync(join(root, old.path));
		const expected = { pageRevision: bodyRevision(body), fileRevision: fileRevision(bytes) };
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const refresh = service(root, async () => {
			await waiting;
			return [candidate(entry, block)];
		}).refresh({
			path: old.path,
			expectedPageRevision: expected.pageRevision,
			expectedFileRevision: expected.fileRevision,
		});
		const remove = service(root, null).removeStale({
			path: old.path,
			expectedPageRevision: expected.pageRevision,
			expectedFileRevision: expected.fileRevision,
		});
		const removed = await remove;
		release();
		await expect(refresh).rejects.toMatchObject({ code: "page_changed" } satisfies Partial<EvidenceRefreshError>);
		expect(parseFrontmatter(removed.content).frontmatter?.evidence_refs).toBeUndefined();
	});

	it("treats a frontmatter-only edit as a page change", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const bytes = readFileSync(join(root, old.path));
		const expected = { pageRevision: bodyRevision(body), fileRevision: fileRevision(bytes) };
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const refresh = service(root, async () => {
			await waiting;
			return [candidate(entry, block)];
		}).refresh({
			path: old.path,
			expectedPageRevision: expected.pageRevision,
			expectedFileRevision: expected.fileRevision,
		});
		const parsed = parseFrontmatter(old.content);
		if (!parsed.frontmatter) throw new Error("expected frontmatter");
		const changed = `${serializeFrontmatter({ ...parsed.frontmatter, updated: "2026-08-17" })}\n${parsed.body}`;
		writeFileSync(join(root, old.path), changed, "utf8");
		release();
		await expect(refresh).rejects.toMatchObject({ code: "page_changed" } satisfies Partial<EvidenceRefreshError>);
		expect(readFileSync(join(root, old.path), "utf8")).toBe(changed);
	});

	it("discards candidates when the source changes during selection", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const old = makePage(root, [ref(entry, block, body)], body);
		const pageBytes = readFileSync(join(root, old.path));
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const refresh = service(root, async () => {
			await waiting;
			return [candidate(entry, block)];
		}).refresh({
			path: old.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(pageBytes),
		});
		const changedSource = "# Source\n\nAlpha evidence changed after selection began.\n";
		writeFileSync(join(root, entry.rawPath), changedSource, "utf8");
		writeEvidenceIndexAtomic(root, buildEvidenceIndex({
			sourceId: entry.id,
			sourceType: "markdown",
			rawContentHash: hash(changedSource),
			parsed: {
				text: changedSource,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: changedSource }],
			},
		}));
		release();

		await expect(refresh).rejects.toMatchObject({ code: "no_valid_candidates" } satisfies Partial<EvidenceRefreshError>);
		expect(readFileSync(join(root, old.path))).toEqual(pageBytes);
	});

	it("refreshes CRLF pages without dropping unrelated nested frontmatter", async () => {
		const root = makeRoot();
		const { entry, block } = makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const oldRef = ref(entry, block, "Old body\n");
		const base = makePage(root, [oldRef], body);
		const withCustom = base.content
			.replace("\n---\n# Page", "\ncustom:\n  nested:\n    keep: true\n---\n# Page")
			.replace(/\n/gu, "\r\n");
		writeFileSync(join(root, base.path), withCustom, "utf8");
		const bytes = readFileSync(join(root, base.path));

		const updated = await service(root, async () => [candidate(entry, block)]).refresh({
			path: base.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(bytes),
		});
		const match = updated.content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
		if (!match) throw new Error("expected frontmatter");
		const raw = parseYaml(match[1]) as Record<string, unknown>;
		expect(raw.custom).toEqual({ nested: { keep: true } });
		expect(raw.sources).toEqual([entry.rawPath]);
		expect(raw.source_ids).toEqual([entry.id]);
	});

	it("remove-stale deletes a malformed scalar evidence_refs field", async () => {
		const root = makeRoot();
		makeSource(root);
		const body = "# Page\n\nClaim about Alpha.\n";
		const page = makePage(root, undefined, body);
		const malformed = page.content.replace("\n---\n# Page", "\nevidence_refs: broken\ncustom:\n  keep: value\n---\n# Page");
		writeFileSync(join(root, page.path), malformed, "utf8");
		const bytes = readFileSync(join(root, page.path));

		const updated = await service(root, null).removeStale({
			path: page.path,
			expectedPageRevision: bodyRevision(body),
			expectedFileRevision: fileRevision(bytes),
		});
		const match = updated.content.match(/^---\n([\s\S]*?)\n---/u);
		if (!match) throw new Error("expected frontmatter");
		const raw = parseYaml(match[1]) as Record<string, unknown>;
		expect(raw).not.toHaveProperty("evidence_refs");
		expect(raw.custom).toEqual({ keep: "value" });
	});
});
