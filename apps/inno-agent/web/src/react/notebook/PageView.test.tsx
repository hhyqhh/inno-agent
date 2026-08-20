import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import i18n from "../../i18n/index.js";
import * as wikiApi from "../../api/wiki.js";
import { notebookStore } from "../../stores/notebook-store.js";
import type { SourceProvenanceGroup, SourceViewerTarget, WikiPageDetail } from "../../types/wiki.js";
import { buildMarkerTargets, injectCitationLinks, PageView } from "./PageView.js";

vi.mock("@earendil-works/pi-web-ui", () => ({}));
vi.mock("../LazyMarkdownEditor.js", () => ({
	LazyMarkdownEditor: () => <div data-testid="markdown-editor" />,
}));
vi.mock("./source-viewer/SourceViewer.js", () => ({
	SourceViewer: ({ target, onBack }: { target: SourceViewerTarget; onBack(): void }) => (
		<div
			data-testid="source-viewer"
			data-target-mode={target.mode}
			data-target-quote={target.mode === "exact" ? target.quote : undefined}
			onKeyDown={(event) => { if (event.key === "Escape") onBack(); }}
		>
			<h2 tabIndex={-1}>Source viewer: {target.title}</h2>
			<button type="button" onClick={onBack}>Back to knowledge page</button>
		</div>
	),
}));

class TestMarkdownArtifact extends HTMLElement {
	private renderedContent = "";

	get content(): string {
		return this.renderedContent;
	}

	set content(value: string) {
		this.renderedContent = value;
		const block = document.createElement("markdown-block") as HTMLElement & { content: string };
		block.content = value;
		this.replaceChildren(block);
	}
}

if (!customElements.get("markdown-artifact")) {
	customElements.define("markdown-artifact", TestMarkdownArtifact);
}

const PAGE_CONTENT = `---
title: Newton's second law
created: 2026-08-14
type: concept
tags: [physics]
sources:
  - raw/uploads/physics.md
source_ids:
  - l2src_physics
updated: 2026-08-14
status: reviewed
confidence: high
---

# Newton's second law`;

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const READY_PROVENANCE: SourceProvenanceGroup = {
	availability: "ready",
	sourceId: "l2src_physics",
	title: "Physics source.md",
	sourceType: "markdown",
	origin: "user_upload",
	rawKind: "uploaded-original",
	rawRelativePath: "raw/uploads/physics.md",
	sourceRevision: SOURCE_REVISION,
	references: [{
		quote: "Newton's second law",
		locator: { kind: "markdown-block", block_id: "md-1", paragraph: 1 },
		selectedBy: "model",
		positionStatus: "verified",
		reasonCodes: [],
	}],
};

function detailWithProvenance(path = "wiki/concepts/newton-second-law.md"): WikiPageDetail {
	return {
		path,
		content: PAGE_CONTENT,
		pageRevision: SOURCE_REVISION,
		fileRevision: `sha256:${"b".repeat(64)}`,
		provenance: {
			sourceGroups: [{
				...READY_PROVENANCE,
				references: READY_PROVENANCE.references.map((reference) => ({
					...reference,
					locator: { ...reference.locator },
					reasonCodes: [...reference.reasonCodes],
				})),
			}],
			legacyPaths: [],
			referenceIssues: [],
		},
	};
}

const SUMMARY_PATH = "wiki/sources/physics-l2src_physics.md";
const SUMMARY_CONTENT = `---
title: Physics source summary
created: 2026-08-14
type: source-summary
tags: [physics]
sources:
  - raw/uploads/physics.md
source_ids:
  - l2src_physics
updated: 2026-08-14
status: reviewed
confidence: high
---

# Physics source summary

Newton's second law is supported by the source [1].`;

function summaryDetail(path = SUMMARY_PATH): WikiPageDetail {
	return {
		...detailWithProvenance(path),
		content: SUMMARY_CONTENT,
		provenance: {
			sourceGroups: [{
				...READY_PROVENANCE,
				references: [{ ...READY_PROVENANCE.references[0], marker: 1 }],
			}],
			legacyPaths: [],
			referenceIssues: [],
		},
	};
}

function conceptDetailWithSummary(paths: readonly string[] = [SUMMARY_PATH]): WikiPageDetail {
	return {
		...detailWithProvenance(),
		content: PAGE_CONTENT.replace(
			"  - raw/uploads/physics.md",
			paths.map((path) => `  - ${path}`).join("\n"),
		),
	};
}

function fileLevelDetail(path = "wiki/concepts/newton-second-law.md"): WikiPageDetail {
	const detail = detailWithProvenance(path);
	const group = detail.provenance!.sourceGroups[0];
	if (group.availability !== "ready") throw new Error("fixture must be ready");
	group.references[0] = {
		...group.references[0],
		positionStatus: "stale-source",
		reasonCodes: ["stale-source"],
	};
	return detail;
}

function emitStoreChange(): void {
	(notebookStore as unknown as { emit(event: "change", value: undefined): void }).emit("change", undefined);
}

function showPage(page: WikiPageDetail): void {
	notebookStore.currentPage = page;
	notebookStore.editBuffer = page.content;
	notebookStore.pageLoadError = null;
	emitStoreChange();
}

function mockPageSelection(pages: readonly WikiPageDetail[]) {
	const byPath = new Map(pages.map((page) => [page.path, page]));
	return vi.spyOn(notebookStore, "selectPage").mockImplementation(async (
		path: string,
		_options?: { switchView?: boolean; preserveCurrentOnError?: boolean },
	): Promise<WikiPageDetail | undefined> => {
		const page = byPath.get(path);
		if (!page) return undefined;
		showPage(page);
		return page;
	});
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
	notebookStore.currentPage = {
		path: "wiki/concepts/newton-second-law.md",
		content: PAGE_CONTENT,
	};
	notebookStore.isLoadingPage = false;
	notebookStore.pageLoadError = null;
	notebookStore.isEditing = false;
	notebookStore.editBuffer = PAGE_CONTENT;
	notebookStore.saveError = null;
	notebookStore.mutationError = null;
	notebookStore.isRefreshingEvidence = false;
	notebookStore.isRemovingStaleEvidence = false;
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	notebookStore.currentPage = null;
	notebookStore.isLoadingPage = false;
	notebookStore.pageLoadError = null;
	notebookStore.isEditing = false;
	notebookStore.editBuffer = "";
	notebookStore.saveError = null;
	notebookStore.mutationError = null;
	notebookStore.isRefreshingEvidence = false;
	notebookStore.isRemovingStaleEvidence = false;
});

describe("PageView provenance integration", () => {
	it("shows the same provenance section in reading and editing states", () => {
		render(<PageView />);

		expect(screen.getByText("来源与证据")).toBeTruthy();
		expect(screen.getByText("raw/uploads/physics.md")).toBeTruthy();
		expect(screen.getByText("l2src_physics")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));

		expect(screen.getByTestId("markdown-editor")).toBeTruthy();
		expect(screen.getByText("来源与证据")).toBeTruthy();
		expect(screen.getByText("raw/uploads/physics.md")).toBeTruthy();
		expect(screen.getByText("l2src_physics")).toBeTruthy();
		fireEvent.click(screen.getByText("来源与证据"));
		expect(screen.queryByRole("button", { name: "刷新引用" })).toBeNull();
	});

	it("keeps provenance visible but disables evidence mutations while editing", () => {
		notebookStore.currentPage = detailWithProvenance();
		notebookStore.editBuffer = PAGE_CONTENT;
		render(<PageView />);

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByText("来源与证据"));
		expect((screen.getByRole("button", { name: "刷新引用" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "移除失效引用" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("opens a source viewer and returns focus to the source action", () => {
		notebookStore.currentPage = fileLevelDetail();
		notebookStore.editBuffer = PAGE_CONTENT;
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		const details = screen.getByText("来源与证据").closest("details");
		expect(details?.hasAttribute("open")).toBe(true);
		const open = screen.getByRole("button", { name: /打开来源/ });
		fireEvent.click(open);

		expect(screen.getByTestId("source-viewer")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Source viewer: Physics source.md" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Back to knowledge page" }));
		expect(screen.queryByTestId("source-viewer")).toBeNull();
		const returned = screen.getByRole("button", { name: /打开来源/ });
		expect(returned).toBeTruthy();
		expect(document.activeElement).toBe(returned);
		expect(screen.getByText("来源与证据").closest("details")?.hasAttribute("open")).toBe(true);
	});

	it("shows the page warning when stale-page is a secondary resolver reason", () => {
		const stale = detailWithProvenance();
		const group = stale.provenance!.sourceGroups[0];
		if (group.availability !== "ready") throw new Error("fixture must be ready");
		group.references[0] = {
			...group.references[0],
			positionStatus: "stale-source",
			reasonCodes: ["stale-source", "stale-page"],
		};
		notebookStore.currentPage = stale;
		render(<PageView />);

		expect(screen.getByText(/页面已修改|page changed/i)).toBeTruthy();
	});

	it("closes a source viewer when the selected knowledge-page path changes", async () => {
		notebookStore.currentPage = fileLevelDetail();
		notebookStore.editBuffer = PAGE_CONTENT;
		render(<PageView />);
		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /打开来源/ }));
		expect(screen.getByTestId("source-viewer")).toBeTruthy();

		notebookStore.currentPage = fileLevelDetail("wiki/concepts/another.md");
		emitStoreChange();

		await waitFor(() => expect(screen.queryByTestId("source-viewer")).toBeNull());
	});

	it("shows evidence mutation errors and asks before model-backed refresh", async () => {
		notebookStore.currentPage = detailWithProvenance();
		notebookStore.editBuffer = PAGE_CONTENT;
		const refresh = vi.spyOn(notebookStore, "refreshEvidence").mockResolvedValue(undefined);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<PageView />);
		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: "刷新引用" }));
		expect(confirm).toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();

		notebookStore.mutationError = "Model unavailable";
		(notebookStore as unknown as { emit(event: "change", value: undefined): void }).emit("change", undefined);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Model unavailable"));
	});
});

describe("citation navigation", () => {
	it("does not rewrite citation-looking text inside code or existing links", () => {
		const target = {
			mode: "file",
			sourceId: "l2src_physics",
			title: "Physics",
			sourceType: "markdown",
			sourceRevision: SOURCE_REVISION,
		} satisfies SourceViewerTarget;
		const body = "Claim [1]. `literal [1]`\n\n```text\n[1]\n```\n\n[1](https://example.com)";
		expect(injectCitationLinks(body, new Map([[1, target]]))).toBe(
			"Claim [&#91;1&#93;](#evidence-1). `literal [1]`\n\n```text\n[1]\n```\n\n[1](https://example.com)",
		);
	});

	it("does not rewrite image labels, footnotes, or reference-link labels", () => {
		const target = {
			mode: "file",
			sourceId: "l2src_physics",
			title: "Physics",
			sourceType: "markdown",
			sourceRevision: SOURCE_REVISION,
		} satisfies SourceViewerTarget;
		const body = "Claim [1]. ![1](image.png)\n\n[^1] note\n\n[1][ref]\n\n[1]: https://example.com\n\n[ref]: https://example.com";
		expect(injectCitationLinks(body, new Map([[1, target]]))).toBe(
			"Claim [&#91;1&#93;](#evidence-1). ![1](image.png)\n\n[^1] note\n\n[1][ref]\n\n[1]: https://example.com\n\n[ref]: https://example.com",
		);
	});

	it("fails closed when two references claim the same marker", () => {
		const duplicate = detailWithProvenance();
		const group = duplicate.provenance!.sourceGroups[0];
		if (group.availability !== "ready") throw new Error("fixture must be ready");
		group.references = [
			{ ...group.references[0], marker: 1 },
			{ ...group.references[0], marker: 1, quote: "another quote" },
		];
		expect(buildMarkerTargets(duplicate).has(1)).toBe(false);
	});

	it("keeps the source-summary header button as ordinary navigation", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		notebookStore.currentPage = concept;
		const selectPage = mockPageSelection([summary]);
		render(<PageView />);

		const summaryButton = screen.getByRole("button", { name: "physics-l2src_physics.md" });
		fireEvent.click(summaryButton);
		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Physics source summary"));
		expect(screen.queryByRole("button", { name: "返回知识页" })).toBeNull();
		const artifact = document.querySelector("markdown-artifact") as (HTMLElement & { content?: string }) | null;
		expect(artifact).toBeTruthy();
		expect(artifact?.content).toContain("[&#91;1&#93;](#evidence-1)");

		const marker = screen.getByRole("link", { name: "[1]" });
		fireEvent.click(marker);
		await waitFor(() => expect(screen.getByTestId("source-viewer")).toBeTruthy());
		expect(screen.getByTestId("source-viewer").getAttribute("data-target-quote")).toBe("Newton's second law");

		fireEvent.click(screen.getByRole("button", { name: "Back to knowledge page" }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "[1]" })));
		expect(selectPage).toHaveBeenCalledOnce();
	});

	it("traverses the exact provenance action through the highlighted summary and restores both focus points", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(summary);
		const selectPage = mockPageSelection([concept, summary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		const originAction = screen.getByRole("button", { name: /查看原文并定位/ });
		fireEvent.click(originAction);
		await waitFor(() => expect(selectPage).toHaveBeenCalledWith(SUMMARY_PATH, expect.anything()));
		expect(screen.queryByTestId("source-viewer")).toBeNull();
		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Physics source summary"));
		const marker = await screen.findByRole("link", { name: "[1]" });
		await waitFor(() => {
			const highlights = [...document.querySelectorAll("mark[data-summary-citation-highlight]")];
			expect(highlights.map((mark) => mark.textContent).join("")).toBe(
				"Newton's second law is supported by the source [1].",
			);
		});
		expect(document.activeElement).toBe(marker);

		fireEvent.click(marker);
		await waitFor(() => expect(screen.getByTestId("source-viewer")).toBeTruthy());
		expect(screen.getByTestId("source-viewer").getAttribute("data-target-quote")).toBe("Newton's second law");

		fireEvent.click(screen.getByRole("button", { name: "Back to knowledge page" }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "[1]" })));
		expect(document.querySelectorAll("mark[data-summary-citation-highlight]").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("button", { name: "返回知识页" }));
		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Newton's second law"));
		const restoredAction = screen.getByRole("button", { name: /查看原文并定位/ });
		await waitFor(() => expect(document.activeElement).toBe(restoredAction));
		expect(screen.getByText("来源与证据").closest("details")?.hasAttribute("open")).toBe(true);
		expect(selectPage).toHaveBeenCalledTimes(2);
	});

	it("revalidates the citation against the summary page returned by navigation", async () => {
		const concept = conceptDetailWithSummary();
		const initialSummary = summaryDetail();
		const changedSummary = summaryDetail();
		const changedGroup = changedSummary.provenance!.sourceGroups[0];
		if (changedGroup.availability !== "ready") throw new Error("fixture must be ready");
		changedGroup.references[0] = {
			...changedGroup.references[0],
			quote: "The summary was regenerated with a different supporting passage.",
		};
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(initialSummary);
		const selectPage = vi.spyOn(notebookStore, "selectPage").mockImplementation(async (path) => {
			if (path !== SUMMARY_PATH) return undefined;
			showPage(changedSummary);
			return changedSummary;
		});
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));

		await waitFor(() => expect(selectPage).toHaveBeenCalledWith(SUMMARY_PATH, expect.anything()));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("未能定位这条摘要引用"));
		expect(document.querySelectorAll("mark[data-summary-citation-highlight]")).toHaveLength(0);
	});

	it("returns to the origin when the selected summary no longer matches the source", async () => {
		const concept = conceptDetailWithSummary();
		const initialSummary = summaryDetail();
		const changedSummary = summaryDetail();
		const changedGroup = changedSummary.provenance!.sourceGroups[0];
		if (changedGroup.availability !== "ready") throw new Error("fixture must be ready");
		changedGroup.sourceId = "l2src_other";
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(initialSummary);
		const selectPage = mockPageSelection([concept, changedSummary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));

		await waitFor(() => expect(selectPage).toHaveBeenNthCalledWith(1, SUMMARY_PATH, expect.anything()));
		await waitFor(() => expect(selectPage).toHaveBeenNthCalledWith(2, concept.path, expect.anything()));
		await waitFor(() => expect(notebookStore.currentPage?.path).toBe(concept.path));
		expect(screen.getByRole("alert").textContent).toContain("没有找到可验证的来源摘要");
		const restoredAction = screen.getByRole("button", { name: /查看原文并定位/ });
		await waitFor(() => expect(document.activeElement).toBe(restoredAction));
		expect(screen.getByText("来源与证据").closest("details")?.hasAttribute("open")).toBe(true);
	});

	it("returns from an intent-opened summary on Escape and restores the provenance action", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(summary);
		mockPageSelection([concept, summary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));
		await screen.findByRole("button", { name: "返回知识页" });
		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Newton's second law"));
		const restoredAction = screen.getByRole("button", { name: /查看原文并定位/ });
		await waitFor(() => expect(document.activeElement).toBe(restoredAction));
		expect(screen.getByText("来源与证据").closest("details")?.hasAttribute("open")).toBe(true);
	});

	it("stays on the origin with an alert when no summary matches", async () => {
		const concept = conceptDetailWithSummary();
		const wrongSummary = summaryDetail();
		const group = wrongSummary.provenance!.sourceGroups[0];
		if (group.availability !== "ready") throw new Error("fixture must be ready");
		group.sourceId = "l2src_other";
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(wrongSummary);
		const selectPage = vi.spyOn(notebookStore, "selectPage");
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		const originAction = screen.getByRole("button", { name: /查看原文并定位/ });
		fireEvent.click(originAction);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("没有找到可验证的来源摘要"));
		expect(notebookStore.currentPage?.path).toBe(concept.path);
		expect(screen.queryByTestId("source-viewer")).toBeNull();
		expect(document.activeElement).toBe(originAction);
		expect(selectPage).not.toHaveBeenCalled();
	});

	it("stays on the origin with an alert when multiple summaries match", async () => {
		const otherPath = "wiki/sources/physics-copy.md";
		const concept = conceptDetailWithSummary([SUMMARY_PATH, otherPath]);
		const summaries = new Map([
			[SUMMARY_PATH, summaryDetail()],
			[otherPath, summaryDetail(otherPath)],
		]);
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockImplementation(async (path) => summaries.get(path)!);
		const selectPage = vi.spyOn(notebookStore, "selectPage");
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("找到多个可能的来源摘要"));
		expect(notebookStore.currentPage?.path).toBe(concept.path);
		expect(selectPage).not.toHaveBeenCalled();
	});

	it("uses a valid summary when another candidate fails to load", async () => {
		const missingPath = "wiki/sources/missing.md";
		const concept = conceptDetailWithSummary([missingPath, SUMMARY_PATH]);
		const summary = summaryDetail();
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockImplementation(async (path) => {
			if (path === missingPath) throw new Error("summary not found");
			return summary;
		});
		const selectPage = mockPageSelection([summary]);
		render(<PageView />);

		const originAction = document.querySelector<HTMLButtonElement>("[data-provenance-action-id]");
		expect(originAction).not.toBeNull();
		fireEvent.click(originAction!);

		await waitFor(() => expect(selectPage).toHaveBeenCalledWith(SUMMARY_PATH, expect.anything()));
		expect(notebookStore.currentPage?.path).toBe(SUMMARY_PATH);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("enters the unique summary with an alert when its marker is missing", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		const group = summary.provenance!.sourceGroups[0];
		if (group.availability !== "ready") throw new Error("fixture must be ready");
		group.references[0] = { ...group.references[0], marker: undefined };
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(summary);
		mockPageSelection([summary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("未能定位这条摘要引用"));
		expect(notebookStore.currentPage?.path).toBe(SUMMARY_PATH);
		expect(screen.queryByTestId("source-viewer")).toBeNull();
	});

	it("enters the unique summary with an alert when multiple markers match", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		const group = summary.provenance!.sourceGroups[0];
		if (group.availability !== "ready") throw new Error("fixture must be ready");
		group.references = [
			{ ...group.references[0], marker: 1 },
			{ ...group.references[0], marker: 2 },
		];
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(summary);
		mockPageSelection([summary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("对应多个位置"));
		expect(notebookStore.currentPage?.path).toBe(SUMMARY_PATH);
		expect(screen.queryByTestId("source-viewer")).toBeNull();
	});

	it("ignores a stale summary response after ordinary navigation", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		const other = detailWithProvenance("wiki/concepts/another.md");
		const pendingSummary = deferred<WikiPageDetail>();
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockReturnValue(pendingSummary.promise);
		const selectPage = vi.spyOn(notebookStore, "selectPage");
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));
		showPage(other);
		pendingSummary.resolve(summary);

		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Newton's second law"));
		expect(notebookStore.currentPage?.path).toBe(other.path);
		expect(screen.queryByRole("button", { name: "返回知识页" })).toBeNull();
		expect(selectPage).not.toHaveBeenCalled();
	});

	it("clears the temporary intent on ordinary page navigation", async () => {
		const concept = conceptDetailWithSummary();
		const summary = summaryDetail();
		const other = detailWithProvenance("wiki/concepts/another.md");
		notebookStore.currentPage = concept;
		vi.spyOn(wikiApi, "getWikiPage").mockResolvedValue(summary);
		mockPageSelection([summary]);
		render(<PageView />);

		fireEvent.click(screen.getByText("来源与证据"));
		fireEvent.click(screen.getByRole("button", { name: /查看原文并定位/ }));
		await screen.findByRole("button", { name: "返回知识页" });
		showPage(other);
		await waitFor(() => expect(screen.queryByRole("button", { name: "返回知识页" })).toBeNull());

		showPage(summary);
		await waitFor(() => expect(document.querySelector("h3")?.textContent).toBe("Physics source summary"));
		expect(screen.queryByRole("button", { name: "返回知识页" })).toBeNull();
		expect(document.querySelector("mark[data-summary-citation-highlight]")).toBeNull();
	});

	it("marks the source-summary navigation busy while the page request is pending", () => {
		notebookStore.currentPage = conceptDetailWithSummary();
		notebookStore.isLoadingPage = true;
		notebookStore.editBuffer = conceptDetailWithSummary().content;

		render(<PageView />);

		const summaryButton = screen.getByRole("button", { name: "physics-l2src_physics.md" }) as HTMLButtonElement;
		expect(summaryButton.disabled).toBe(true);
		expect(summaryButton.getAttribute("aria-busy")).toBe("true");
	});

	it("shows a visible error when a source-summary page cannot be loaded", () => {
		notebookStore.currentPage = null;
		notebookStore.isLoadingPage = false;
		Object.assign(notebookStore, { pageLoadError: "Summary page unavailable" });

		render(<PageView />);

		expect(screen.getByRole("alert").textContent).toContain("Summary page unavailable");
	});
});
