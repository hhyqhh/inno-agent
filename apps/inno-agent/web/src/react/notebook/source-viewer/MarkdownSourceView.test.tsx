import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/index.js";
import type { EvidenceSliceResponse } from "../../../types/wiki.js";
import { evidenceBlocksInDocumentOrder, MarkdownSourceView } from "./MarkdownSourceView.js";

const REVISION = `sha256:${"a".repeat(64)}`;
const TARGET = "The **net force** determines acceleration.";
const FULL_DOCUMENT = [
	"# Dynamics",
	"Context before the cited paragraph.",
	TARGET,
	"Context after the cited paragraph.",
	"[outside](https://outside.example/) ![tracking pixel](https://outside.example/pixel.png)",
	"<script>globalThis.markdownExecuted = true</script>",
].join("\n\n");

function evidence(): EvidenceSliceResponse {
	return {
		sourceId: "l2src_mechanics",
		sourceRevision: REVISION,
		indexVersion: 1,
		target: {
			id: "md:b0003:target",
			kind: "markdown",
			text: TARGET,
			heading: "Dynamics",
			paragraph: 3,
		},
		neighbors: [{
			id: "md:b0002:neighbor",
			kind: "markdown",
			text: "Context before the cited paragraph.",
			heading: "Dynamics",
			paragraph: 2,
		}],
	};
}

function slicedEvidenceWithAfterNeighbor(): EvidenceSliceResponse {
	return {
		sourceId: "l2src_mechanics",
		sourceRevision: REVISION,
		indexVersion: 1,
		target: {
			id: "md:b0003:target",
			kind: "markdown",
			text: TARGET,
			heading: "Dynamics",
			paragraph: 3,
		},
		neighbors: [
			{
				id: "md:b0002:before",
				kind: "markdown",
				text: "Context before the cited paragraph.",
				heading: "Dynamics",
				paragraph: 2,
			},
			{
				id: "md:b0004:after",
				kind: "markdown",
				text: "Context after the cited paragraph.",
				heading: "Dynamics",
				paragraph: 4,
			},
		],
		precedingNeighborCount: 1,
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).markdownExecuted;
});

describe("MarkdownSourceView", () => {
	it("inserts the target between preceding and following neighbors in extracted fallback", () => {
		const sliced = slicedEvidenceWithAfterNeighbor();
		expect(evidenceBlocksInDocumentOrder(sliced).map((block) => block.id)).toEqual([
			"md:b0002:before",
			"md:b0003:target",
			"md:b0004:after",
		]);

		const { container } = render(<MarkdownSourceView evidence={sliced} />);
		expect([...container.querySelectorAll("article")].map((article) => article.dataset.blockId)).toEqual([
			"md:b0002:before",
			"md:b0003:target",
			"md:b0004:after",
		]);
	});

	it("renders the complete safe document and highlights the uniquely mapped formatted quote", async () => {
		const { container } = render(
			<MarkdownSourceView content={FULL_DOCUMENT} evidence={evidence()} quote="**net force**" />,
		);

		expect(screen.getByText("Context before the cited paragraph.")).toBeTruthy();
		expect(screen.getByText("Context after the cited paragraph.")).toBeTruthy();
		expect(container.querySelector("[data-markdown-document-block][aria-current='location']")).toBeTruthy();
		await waitFor(() => {
			const highlighted = Array.from(container.querySelectorAll("mark[data-evidence-highlight]"))
				.map((mark) => mark.textContent)
				.join("");
			expect(highlighted).toBe("net force");
		});
		expect(container.querySelector("strong")).toBeTruthy();
		expect(container.textContent).toContain("outside");
		expect(container.textContent).toContain("tracking pixel");
		expect(container.querySelector("a, img, script")).toBeNull();
		expect((globalThis as Record<string, unknown>).markdownExecuted).toBeUndefined();
	});

	it("keeps the complete document readable when evidence is unavailable", () => {
		const { container } = render(<MarkdownSourceView content={FULL_DOCUMENT} />);

		expect(screen.getByText("Context before the cited paragraph.")).toBeTruthy();
		expect(screen.getByText("Context after the cited paragraph.")).toBeTruthy();
		expect(container.querySelector("mark, [aria-current='location']")).toBeNull();
	});

	it("fails closed when the indexed target maps to more than one raw Markdown block", async () => {
		const duplicateDocument = `${FULL_DOCUMENT}\n\n${TARGET}`;
		const { container } = render(
			<MarkdownSourceView content={duplicateDocument} evidence={evidence()} quote="net force" />,
		);

		expect((await screen.findByRole("alert")).textContent).toContain("more than one block");
		expect(container.querySelector("mark, [aria-current='location']")).toBeNull();
		expect(screen.getAllByText(/determines acceleration/)).toHaveLength(2);
	});

	it("labels an evidence-only fallback as extracted and incomplete", async () => {
		const { container } = render(<MarkdownSourceView evidence={evidence()} quote="net force" />);

		expect((await screen.findByRole("alert")).textContent).toContain("not the complete Markdown document");
		expect(screen.getByText(/determines acceleration/)).toBeTruthy();
		expect(container.textContent).not.toContain("Context after the cited paragraph.");
		await waitFor(() => expect(container.querySelector("mark")?.textContent).toBe("net force"));
	});
});
