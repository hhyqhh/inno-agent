import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import i18n from "../../../i18n/index.js";
import type {
	EvidenceLocator,
	EvidenceSliceResponse,
	SourceViewerTarget,
} from "../../../types/wiki.js";
import { SourceViewer } from "./SourceViewer.js";
import { DocxSourceView } from "./DocxSourceView.js";
import { evidenceBlocksInDocumentOrder, MarkdownSourceView } from "./MarkdownSourceView.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

const apiMocks = vi.hoisted(() => ({
	getSourceEvidence: vi.fn(),
	locateSourceQuote: vi.fn(),
	getSourceContent: vi.fn(),
	sourceContentUrl: vi.fn((sourceId: string) => `/api/l2/sources/${encodeURIComponent(sourceId)}/content`),
}));

const docxMocks = vi.hoisted(() => ({
	renderAsync: vi.fn(),
}));

const pdfViewMocks = vi.hoisted(() => ({
	render: vi.fn(),
}));

vi.mock("../../../api/wiki.js", () => apiMocks);
vi.mock("docx-preview", () => ({ renderAsync: docxMocks.renderAsync }));
vi.mock("./PdfSourceView.js", () => ({
	PdfSourceView: (props: Record<string, unknown>) => {
		pdfViewMocks.render(props);
		return <div data-testid="pdf-source-view" />;
	},
}));

const REVISION = `sha256:${"a".repeat(64)}`;

function markdownTarget(overrides: Partial<Extract<SourceViewerTarget, { mode: "exact" }>> = {}): Extract<SourceViewerTarget, { mode: "exact" }> {
	return {
		mode: "exact",
		sourceId: "l2src_mechanics",
		title: "Mechanics notes.md",
		sourceType: "markdown",
		rawKind: "uploaded-original",
		sourceRevision: REVISION,
		quote: "net force",
		locator: {
			kind: "markdown-block",
			block_id: "md:b0002:target",
			heading: "Dynamics",
			paragraph: 2,
		},
		positionStatus: "verified",
		indexVersion: 1,
		...overrides,
	};
}

function markdownSlice(blockId = "md:b0002:target"): EvidenceSliceResponse {
	return {
		sourceId: "l2src_mechanics",
		sourceRevision: REVISION,
		indexVersion: 1,
		target: {
			id: blockId,
			kind: "markdown",
			text: "The net\n   force determines acceleration.",
			heading: "Dynamics",
			paragraph: 2,
		},
		neighbors: [{
			id: "md:b0001:unsafe",
			kind: "markdown",
			text: "<img src=x onerror=globalThis.pwned=true> [outside](javascript:alert(1))",
			heading: "Dynamics",
			paragraph: 1,
		}],
	};
}

function wordTarget(): Extract<SourceViewerTarget, { mode: "exact" }> {
	return {
		mode: "exact",
		sourceId: "l2src_lesson",
		title: "Lesson notes.docx",
		sourceType: "word",
		rawKind: "uploaded-original",
		sourceRevision: REVISION,
		quote: "Momentum is conserved",
		locator: {
			kind: "docx-paragraph",
			block_id: "docx:p0003:target",
			paragraph: 3,
		},
		positionStatus: "verified",
		indexVersion: 1,
	};
}

function wordSlice(): EvidenceSliceResponse {
	return {
		sourceId: "l2src_lesson",
		sourceRevision: REVISION,
		indexVersion: 1,
		target: {
			id: "docx:p0003:target",
			kind: "docx",
			text: "Momentum is conserved in a closed system.",
			paragraph: 3,
		},
		neighbors: [],
	};
}

function pdfTarget(overrides: Partial<Extract<SourceViewerTarget, { mode: "exact" }>> = {}): Extract<SourceViewerTarget, { mode: "exact" }> {
	return {
		mode: "exact",
		sourceId: "l2src_paper",
		title: "Paper.pdf",
		sourceType: "pdf",
		rawKind: "uploaded-original",
		sourceRevision: REVISION,
		quote: "net force",
		locator: { kind: "pdf-page", block_id: "pdf:p0002:b0001", page: 2 },
		positionStatus: "quote-mismatch",
		indexVersion: 1,
		...overrides,
	};
}

function sourceResponse(body = "source bytes", contentType = "application/octet-stream"): Response {
	return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

function markdownDocument(targetText = markdownSlice().target.text): string {
	return [
		"# Dynamics",
		markdownSlice().neighbors[0].text,
		targetText,
		"Context after the cited paragraph.",
	].join("\n\n");
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	apiMocks.getSourceEvidence.mockReset().mockResolvedValue(markdownSlice());
	apiMocks.locateSourceQuote.mockReset().mockResolvedValue({ matches: [] });
	apiMocks.getSourceContent.mockReset().mockImplementation(() => Promise.resolve(sourceResponse(markdownDocument(), "text/markdown")));
	apiMocks.sourceContentUrl.mockClear();
	docxMocks.renderAsync.mockReset().mockResolvedValue(undefined);
	pdfViewMocks.render.mockReset();
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: vi.fn(() => "blob:source-download"),
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: vi.fn(),
	});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SourceViewer", () => {
	it("keeps evidence blocks in the source order supplied by the index", () => {
		const evidence: EvidenceSliceResponse = {
			sourceId: "l2src_mechanics",
			sourceRevision: REVISION,
			indexVersion: 1,
			target: {
				id: "md:b00010:target",
				kind: "markdown",
				text: "tenth block",
				paragraph: 10,
			},
			neighbors: [
				{ id: "md:b0002:neighbor", kind: "markdown", text: "second block", paragraph: 2 },
				{ id: "md:b0009:neighbor", kind: "markdown", text: "ninth block", paragraph: 9 },
			],
		};

		expect(evidenceBlocksInDocumentOrder(evidence).map((block) => block.id)).toEqual([
			"md:b0002:neighbor",
			"md:b0009:neighbor",
			"md:b00010:target",
		]);
	});

	it("keeps the quote visible but forces PDF extracted fallback after an unsafe resolution", async () => {
		const fallbackLocator: EvidenceLocator = { kind: "pdf-page", block_id: "pdf:p0001:b0001", page: 1 };
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [], fallbackLocator });
		apiMocks.getSourceEvidence.mockResolvedValue({
			sourceId: "l2src_paper",
			sourceRevision: REVISION,
			indexVersion: 1,
			target: { id: fallbackLocator.block_id, kind: "pdf", page: 1, text: "Nearby context without the citation." },
			neighbors: [],
		});

		render(<SourceViewer target={pdfTarget()} onBack={vi.fn()} />);
		expect(await screen.findByTestId("pdf-source-view")).toBeTruthy();
		expect(pdfViewMocks.render).toHaveBeenCalledWith(expect.objectContaining({
			page: 1,
			quote: "net force",
			forceExtractedFallback: true,
		}));
	});

	it("renders a secure complete Markdown document with header actions and an exact highlight", async () => {
		apiMocks.getSourceContent.mockImplementation(() => Promise.resolve(sourceResponse([
			"# Dynamics",
			"<img src=x onerror=globalThis.pwned=true> [outside](javascript:alert(1))",
			"The net\n   force determines acceleration.",
			"Context after the cited paragraph.",
		].join("\n\n"), "text/markdown")));
		const onBack = vi.fn();
		const { container } = render(<SourceViewer target={markdownTarget()} onBack={onBack} />);

		const heading = screen.getByRole("heading", { name: "Mechanics notes.md" });
		expect(heading).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(screen.getAllByText("Dynamics · paragraph 2")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Back to knowledge page" }));
		expect(onBack).toHaveBeenCalledOnce();
		fireEvent.keyDown(screen.getByRole("region", { name: "Source viewer" }), { key: "Escape" });
		expect(onBack).toHaveBeenCalledTimes(2);

		const mark = await waitFor(() => {
			const element = container.querySelector("mark");
			expect(element).toBeTruthy();
			return element as HTMLElement;
		});
		expect(mark.textContent).toBe("net\n   force");
		expect(container.textContent).toContain("<img src=x onerror=globalThis.pwned=true>");
		expect(container.querySelector("img, script, a")).toBeNull();
		expect(screen.getByText("Context after the cited paragraph.")).toBeTruthy();
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Download original" }));
		await waitFor(() => expect(apiMocks.getSourceContent).toHaveBeenCalledWith(
			"l2src_mechanics",
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		));
		await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled());
	});

	it("keeps complete Markdown readable when evidence loading fails", async () => {
		apiMocks.getSourceEvidence.mockRejectedValue(new Error("evidence unavailable"));
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse([
			"# Dynamics",
			"Context before the cited paragraph.",
			"The net force determines acceleration.",
			"Context after the cited paragraph.",
		].join("\n\n"), "text/markdown"));
		const { container } = render(<SourceViewer target={markdownTarget()} onBack={vi.fn()} />);

		expect(await screen.findByText("Context before the cited paragraph.")).toBeTruthy();
		expect(screen.getByText("Context after the cited paragraph.")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain("evidence unavailable");
		expect(container.querySelector("mark, [aria-current='location']")).toBeNull();
	});

	it("shows an explicit extracted Markdown fallback when complete content loading fails", async () => {
		apiMocks.getSourceContent.mockRejectedValue(new Error("content unavailable"));
		const { container } = render(<SourceViewer target={markdownTarget()} onBack={vi.fn()} />);

		expect(await screen.findByText("content unavailable")).toBeTruthy();
		expect(screen.getByText(/determines acceleration/)).toBeTruthy();
		expect(screen.getByText(/not the complete Markdown document/)).toBeTruthy();
		await waitFor(() => expect(container.querySelector("mark")?.textContent).toBe("net\n   force"));
	});

	it("renders formatted Markdown without remote images and highlights a raw formatted quote", async () => {
		const evidence: EvidenceSliceResponse = {
			sourceId: "l2src_mechanics",
			sourceRevision: REVISION,
			indexVersion: 1,
			target: {
				id: "md:formatted-target",
				kind: "markdown",
				text: "The **net force** determines acceleration.",
				heading: "Dynamics",
				paragraph: 2,
			},
			neighbors: [{
				id: "md:image-neighbor",
				kind: "markdown",
				text: "![remote tracking pixel](https://tracking.example/pixel.png)",
				heading: "Dynamics",
				paragraph: 1,
			}],
		};
		const { container } = render(<MarkdownSourceView evidence={evidence} quote="**net force**" />);

		await waitFor(() => expect(container.querySelector("mark")?.textContent).toBe("net force"));
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("remote tracking pixel");
		expect(container.querySelector("strong")).toBeTruthy();
	});

	it("shows a stale-page warning without blocking the trusted source", async () => {
		render(<SourceViewer target={markdownTarget({ positionStatus: "stale-page" })} onBack={vi.fn()} />);

		expect((await screen.findByRole("status")).textContent).toContain("Page changed; confirm this citation again");
		expect(apiMocks.getSourceEvidence).toHaveBeenCalledWith(
			"l2src_mechanics",
			"md:b0002:target",
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(await screen.findByText(/determines acceleration/)).toBeTruthy();
	});

	it("relocates when stale-page hides an invalid original block", async () => {
		const relocated: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0008:stale-relocated",
			heading: "Dynamics",
			paragraph: 8,
		};
		apiMocks.getSourceEvidence
			.mockRejectedValueOnce(new ApiError(422, "Evidence block is invalid", { code: "invalid_block_id" }))
			.mockResolvedValueOnce(markdownSlice(relocated.block_id));
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [{ locator: relocated }] });

		render(<SourceViewer target={markdownTarget({ positionStatus: "stale-page" })} onBack={vi.fn()} />);

		expect(await screen.findByText("Page changed; confirm this citation again.")).toBeTruthy();
		expect(await screen.findByText("The evidence location has drifted")).toBeTruthy();
		expect(apiMocks.locateSourceQuote).toHaveBeenCalledOnce();
	});

	it("relocates an invalid locator only when quote matching is unique", async () => {
		const relocated: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0007:relocated",
			heading: "Dynamics",
			paragraph: 7,
		};
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [{ locator: relocated }] });
		apiMocks.getSourceEvidence.mockResolvedValue(markdownSlice(relocated.block_id));

		render(<SourceViewer target={markdownTarget({ positionStatus: "locator-invalid" })} onBack={vi.fn()} />);

		expect(await screen.findByText("The evidence location has drifted")).toBeTruthy();
		expect(apiMocks.locateSourceQuote).toHaveBeenCalledWith("l2src_mechanics", {
			quote: "net force",
			sourceRevision: REVISION,
			indexVersion: 1,
		}, REVISION, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(apiMocks.getSourceEvidence).toHaveBeenCalledWith(
			"l2src_mechanics",
			"md:b0007:relocated",
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("lists ambiguous locator candidates and waits for the user to choose", async () => {
		const first: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0004:first",
			heading: "Examples",
			paragraph: 1,
		};
		const second: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0009:second",
			heading: "Exercises",
			paragraph: 2,
		};
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [{ locator: first }, { locator: second }] });
		apiMocks.getSourceEvidence.mockResolvedValue(markdownSlice(second.block_id));

		render(<SourceViewer target={markdownTarget({ positionStatus: "quote-mismatch" })} onBack={vi.fn()} />);

		expect(await screen.findByText("The quote appears in multiple locations")).toBeTruthy();
		expect(apiMocks.getSourceEvidence).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Candidate 2: Exercises · paragraph 2" }));
		await waitFor(() => expect(apiMocks.getSourceEvidence).toHaveBeenCalledWith(
			"l2src_mechanics",
			second.block_id,
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		));
	});

	it("labels and highlights a selected occurrence when one block contains repeated quotes", async () => {
		const locator: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0002:repeated",
			heading: "Dynamics",
			paragraph: 2,
		};
		apiMocks.locateSourceQuote.mockResolvedValue({
			matches: [
				{ locator, occurrence: 1, occurrenceCount: 2 },
				{ locator, occurrence: 2, occurrenceCount: 2 },
			],
		});
		apiMocks.getSourceEvidence.mockResolvedValue({
			...markdownSlice(locator.block_id),
			target: {
				...markdownSlice(locator.block_id).target,
				text: "The net force appears first; the net force repeats.",
			},
		});
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse(
			markdownDocument("The net force appears first; the net force repeats."),
			"text/markdown",
		));

		const { container } = render(<SourceViewer target={markdownTarget({ positionStatus: "quote-mismatch" })} onBack={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: /Candidate 2:.*\(2\/2\)/ }));
		await waitFor(() => expect(apiMocks.getSourceEvidence).toHaveBeenCalledWith(
			"l2src_mechanics",
			locator.block_id,
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		));
		await waitFor(() => expect(container.querySelector("mark")?.textContent).toBe("net force"));
		expect(screen.queryByText("The quote appears in multiple locations")).toBeNull();
	});

	it("aborts an earlier candidate choice when a newer candidate is selected", async () => {
		const first: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0004:first",
			heading: "Examples",
			paragraph: 1,
		};
		const second: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0009:second",
			heading: "Exercises",
			paragraph: 2,
		};
		let finishFirst!: (value: EvidenceSliceResponse) => void;
		let firstSignal: AbortSignal | undefined;
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [{ locator: first }, { locator: second }] });
		apiMocks.getSourceEvidence.mockImplementation((_id: string, blockId: string, _revision: string, options: { signal: AbortSignal }) => {
			if (blockId === first.block_id) {
				firstSignal = options.signal;
				return new Promise<EvidenceSliceResponse>((resolve) => { finishFirst = resolve; });
			}
			return Promise.resolve(markdownSlice(second.block_id));
		});

		render(<SourceViewer target={markdownTarget({ positionStatus: "quote-mismatch" })} onBack={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Candidate 1: Examples · paragraph 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Candidate 2: Exercises · paragraph 2" }));

		expect(firstSignal?.aborted).toBe(true);
		expect(await screen.findByText(/determines acceleration/)).toBeTruthy();
		finishFirst(markdownSlice(first.block_id));
		await Promise.resolve();
		expect(screen.getByText("Context after the cited paragraph.")).toBeTruthy();
	});

	it("makes a zero-match fallback explicit and does not invent a highlight", async () => {
		const fallback: EvidenceLocator = {
			kind: "markdown-block",
			block_id: "md:b0001:fallback",
			heading: "Dynamics",
			paragraph: 1,
		};
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [], fallbackLocator: fallback });
		apiMocks.getSourceEvidence.mockResolvedValue({
			...markdownSlice(),
			target: { ...markdownSlice().target, id: fallback.block_id, text: "Nearby context without the citation." },
		});
		const { container } = render(
			<SourceViewer target={markdownTarget({ positionStatus: "quote-mismatch" })} onBack={vi.fn()} />,
		);

		expect(await screen.findByText("The original quote was not found")).toBeTruthy();
		expect(await screen.findByText("Context after the cited paragraph.")).toBeTruthy();
		expect(container.querySelector("mark")).toBeNull();
		expect(apiMocks.getSourceEvidence).toHaveBeenCalledWith(
			"l2src_mechanics",
			fallback.block_id,
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("does not treat two quote occurrences inside one evidence block as unique", async () => {
		apiMocks.getSourceEvidence.mockResolvedValue({
			...markdownSlice(),
			target: { ...markdownSlice().target, text: "net force, then another net force" },
		});
		const { container } = render(<SourceViewer target={markdownTarget()} onBack={vi.fn()} />);

		expect(await screen.findByText("The quote occurs more than once in this evidence block")).toBeTruthy();
		expect(container.querySelector("mark")).toBeNull();
	});

	it("renders DOCX first, disables external links, and highlights one DOM match", async () => {
		apiMocks.getSourceEvidence.mockResolvedValue(wordSlice());
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			const paragraph = document.createElement("p");
			paragraph.textContent = "Momentum is conserved in a closed system.";
			const link = document.createElement("a");
			link.href = "https://outside.example/";
			link.target = "_blank";
			link.textContent = "outside";
			container.append(paragraph, link);
		});
		const { container } = render(<SourceViewer target={wordTarget()} onBack={vi.fn()} />);

		await waitFor(() => expect(docxMocks.renderAsync).toHaveBeenCalledOnce());
		const highlight = await waitFor(() => container.querySelector("mark[data-evidence-highlight]"));
		expect(highlight?.textContent).toBe("Momentum is conserved");
		const link = screen.getByText("outside").closest("a");
		expect(link?.hasAttribute("href")).toBe(false);
		expect(link?.hasAttribute("target")).toBe(false);
		expect(link?.getAttribute("rel")).toContain("noopener");
		expect(link?.getAttribute("aria-disabled")).toBe("true");
		expect(apiMocks.getSourceContent).toHaveBeenCalledWith(
			"l2src_lesson",
			REVISION,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(docxMocks.renderAsync.mock.calls[0][2]).toBeInstanceOf(HTMLElement);
		expect(docxMocks.renderAsync.mock.calls[0][1]).not.toBe(docxMocks.renderAsync.mock.calls[0][2]);
	});

	it("falls back to extracted evidence when DOCX DOM matching is ambiguous", async () => {
		apiMocks.getSourceEvidence.mockResolvedValue(wordSlice());
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			container.append(
				document.createTextNode("Momentum is conserved. "),
				document.createTextNode("Momentum is conserved."),
			);
		});
		const { container } = render(<SourceViewer target={wordTarget()} onBack={vi.fn()} />);

		expect((await screen.findByRole("alert")).textContent).toContain("multiple times");
		expect(container.querySelector("[data-evidence-text-view]")?.textContent).toContain("Momentum is conserved in a closed system.");
		expect(container.querySelector("[data-evidence-text-view] mark")?.textContent).toBe("Momentum is conserved");
	});

	it("highlights the selected repeated DOCX occurrence", async () => {
		const locator = wordTarget().locator;
		apiMocks.locateSourceQuote.mockResolvedValue({
			matches: [
				{ locator, occurrence: 1, occurrenceCount: 2 },
				{ locator, occurrence: 2, occurrenceCount: 2 },
			],
		});
		apiMocks.getSourceEvidence.mockResolvedValue({
			...wordSlice(),
			target: { ...wordSlice().target, text: "Momentum is conserved once; Momentum is conserved twice." },
		});
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			container.append(
				document.createTextNode("Momentum is conserved once; "),
				document.createTextNode("Momentum is conserved twice."),
			);
		});

		const { container } = render(<SourceViewer target={{ ...wordTarget(), positionStatus: "quote-mismatch" }} onBack={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: /Candidate 2:.*\(2\/2\)/ }));
		await waitFor(() => expect(container.querySelectorAll("mark[data-evidence-highlight]")).toHaveLength(1));
		expect(container.querySelector("mark[data-evidence-highlight]")?.textContent).toBe("Momentum is conserved");
	});

	it("scopes a DOCX occurrence to the target evidence paragraph", async () => {
		const locator: EvidenceLocator = {
			kind: "docx-paragraph",
			block_id: "docx:p0002:target",
			paragraph: 2,
		};
		const target = { ...wordTarget(), locator, positionStatus: "quote-mismatch" as const };
		const slice = {
			...wordSlice(),
			target: {
				...wordSlice().target,
				id: locator.block_id,
				paragraph: 2,
				text: "Momentum is conserved in the target paragraph.",
			},
		};
		apiMocks.locateSourceQuote.mockResolvedValue({
			matches: [{ locator, occurrence: 1, occurrenceCount: 1 }],
		});
		apiMocks.getSourceEvidence.mockResolvedValue(slice);
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx bytes"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			const unrelated = document.createElement("p");
			unrelated.textContent = "Momentum is conserved in an unrelated paragraph.";
			const targetParagraph = document.createElement("p");
			targetParagraph.textContent = "Momentum is conserved in the target paragraph.";
			container.append(unrelated, targetParagraph);
		});

		const { container } = render(<SourceViewer target={target} onBack={vi.fn()} />);

		const highlight = await waitFor(() => {
			const mark = container.querySelector("mark[data-evidence-highlight]");
			expect(mark).toBeTruthy();
			return mark;
		});
		expect(highlight?.parentElement?.textContent).toBe("Momentum is conserved in the target paragraph.");
	});

	it("moves a DOCX highlight when the evidence target changes", async () => {
		const content = new Uint8Array([1, 2, 3]).buffer;
		const firstEvidence: EvidenceSliceResponse = {
			...wordSlice(),
			target: {
				...wordSlice().target,
				id: "docx:p0001:first",
				paragraph: 1,
				text: "Momentum is conserved in the first paragraph.",
			},
		};
		const secondEvidence: EvidenceSliceResponse = {
			...wordSlice(),
			target: {
				...wordSlice().target,
				id: "docx:p0002:second",
				paragraph: 2,
				text: "Momentum is conserved in the second paragraph.",
			},
		};
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			const first = document.createElement("p");
			first.textContent = "Momentum is conserved in the first paragraph.";
			const second = document.createElement("p");
			second.textContent = "Momentum is conserved in the second paragraph.";
			container.append(first, second);
		});

		const { container, rerender } = render(
			<DocxSourceView content={content} evidence={firstEvidence} quote="Momentum is conserved" />,
		);
		await waitFor(() => expect(container.querySelector("mark[data-evidence-highlight]")?.parentElement?.textContent)
			.toBe("Momentum is conserved in the first paragraph."));

		rerender(<DocxSourceView content={content} evidence={secondEvidence} quote="Momentum is conserved" />);

		await waitFor(() => expect(docxMocks.renderAsync).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(container.querySelector("mark[data-evidence-highlight]")?.parentElement?.textContent)
			.toBe("Momentum is conserved in the second paragraph."));
	});

	it("does not create a DOCX match by joining separate paragraphs", async () => {
		apiMocks.getSourceEvidence.mockResolvedValue(wordSlice());
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			const first = document.createElement("p");
			first.textContent = "Momentum is ";
			const second = document.createElement("p");
			second.textContent = "conserved in another paragraph.";
			container.append(first, second);
		});

		render(<SourceViewer target={wordTarget()} onBack={vi.fn()} />);

		expect((await screen.findByRole("alert")).textContent).toContain("could not map the quote");
	});

	it("shows extracted DOCX evidence when quote relocation cannot find a safe match", async () => {
		const fallbackLocator = wordTarget().locator;
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [], fallbackLocator });
		apiMocks.getSourceEvidence.mockResolvedValue(wordSlice());
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			container.textContent = "Unrelated content at the start of the Word document.";
		});
		const { container } = render(
			<SourceViewer target={{ ...wordTarget(), positionStatus: "quote-mismatch" }} onBack={vi.fn()} />,
		);

		expect(await screen.findByText("The original quote was not found")).toBeTruthy();
		await waitFor(() => expect(container.querySelector("[data-evidence-text-view]")?.textContent)
			.toContain("Momentum is conserved in a closed system."));
		expect(container.querySelector("[data-evidence-text-view] mark")).toBeNull();
		expect(docxMocks.renderAsync).not.toHaveBeenCalled();
	});

	it("does not render the full DOCX when unsafe relocation has no fallback block", async () => {
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [] });
		apiMocks.getSourceEvidence.mockRejectedValue(new Error("no evidence block"));
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx bytes"));
		docxMocks.renderAsync.mockImplementation(async (_buffer: ArrayBuffer, container: HTMLElement) => {
			container.textContent = "Untrusted full Word document";
		});

		render(<SourceViewer target={{ ...wordTarget(), positionStatus: "quote-mismatch" }} onBack={vi.fn()} />);

		expect(await screen.findByText("The original quote was not found")).toBeTruthy();
		expect(docxMocks.renderAsync).not.toHaveBeenCalled();
		expect(screen.queryByText("Untrusted full Word document")).toBeNull();
	});

	it("localizes source viewer chrome and Markdown locations in zh-CN", async () => {
		await i18n.changeLanguage("zh-CN");
		render(<SourceViewer target={markdownTarget()} onBack={vi.fn()} />);

		expect(screen.getByRole("region", { name: "来源查看器" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "返回知识页" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "下载原文" })).toBeTruthy();
		expect(await screen.findByText("Dynamics · 第 2 段")).toBeTruthy();
	});

	it("localizes an unsafe DOCX relocation fallback in zh-CN", async () => {
		await i18n.changeLanguage("zh-CN");
		apiMocks.locateSourceQuote.mockResolvedValue({ matches: [], fallbackLocator: wordTarget().locator });
		apiMocks.getSourceEvidence.mockResolvedValue(wordSlice());
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		render(<SourceViewer target={{ ...wordTarget(), positionStatus: "quote-mismatch" }} onBack={vi.fn()} />);

		expect(await screen.findByText("未找到原引用")).toBeTruthy();
		expect(screen.getByText("无法安全定位引用，已改为显示抽取的证据。")).toBeTruthy();
		expect(screen.getAllByText("第 3 段").length).toBeGreaterThan(0);
	});

	it("ignores a delayed result after switching to a new target", async () => {
		let finishOld!: (value: EvidenceSliceResponse) => void;
		let oldSignal: AbortSignal | undefined;
		apiMocks.getSourceEvidence
			.mockImplementationOnce((_sourceId: string, _blockId: string, _revision: string, options: { signal: AbortSignal }) => {
				oldSignal = options.signal;
				return new Promise<EvidenceSliceResponse>((resolve) => { finishOld = resolve; });
			})
			.mockResolvedValueOnce({
				...markdownSlice(),
				sourceId: "l2src_current",
				target: { ...markdownSlice().target, text: "Current net force evidence." },
			});
		apiMocks.getSourceContent.mockImplementation((sourceId: string) => Promise.resolve(sourceResponse(
			sourceId === "l2src_current" ? markdownDocument("Current net force evidence.") : markdownDocument(),
			"text/markdown",
		)));
		const { rerender } = render(<SourceViewer target={markdownTarget({ title: "Old source.md" })} onBack={vi.fn()} />);

		rerender(<SourceViewer target={markdownTarget({ sourceId: "l2src_current", title: "Current source.md" })} onBack={vi.fn()} />);
		expect(oldSignal?.aborted).toBe(true);
		expect(await screen.findByText(/Current.*evidence/)).toBeTruthy();
		finishOld({ ...markdownSlice(), target: { ...markdownSlice().target, text: "Old net force evidence." } });
		await Promise.resolve();
		expect(screen.queryByText(/Old net force evidence/)).toBeNull();
		expect(screen.getByRole("heading", { name: "Current source.md" })).toBeTruthy();
	});

	it("aborts and clears the previous target's DOM, highlight, and error on switch", async () => {
		const abortSpy = vi.spyOn(AbortController.prototype, "abort");
		apiMocks.getSourceEvidence.mockImplementation((sourceId: string) => (
			sourceId === "l2src_lesson" ? Promise.resolve(wordSlice()) : Promise.resolve(markdownSlice())
		));
		apiMocks.getSourceContent.mockResolvedValue(sourceResponse("docx"));
		docxMocks.renderAsync.mockRejectedValue(new Error("broken docx"));
		const { container, rerender } = render(<SourceViewer target={wordTarget()} onBack={vi.fn()} />);
		expect((await screen.findByRole("alert")).textContent).toContain("broken docx");

		rerender(<SourceViewer target={markdownTarget()} onBack={vi.fn()} />);

		expect(await screen.findByText(/determines acceleration/)).toBeTruthy();
		expect(screen.queryByText("broken docx")).toBeNull();
		expect(container.textContent).not.toContain("Lesson notes.docx");
		expect(container.querySelectorAll("mark")).toHaveLength(1);
		expect(abortSpy).toHaveBeenCalled();
	});
});
