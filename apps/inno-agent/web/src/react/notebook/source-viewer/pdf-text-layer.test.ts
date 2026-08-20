// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	highlightPdfText,
	findUniquePdfTextItemMatch,
	normalizePdfText,
} from "./pdf-text-layer.js";

describe("pdf text-layer matching", () => {
	it("normalizes NFC and collapses whitespace across PDF text items", () => {
		expect(normalizePdfText(["Cafe\u0301", "\r\n", "net", "   force"])).toBe("Café net force");
		expect(findUniquePdfTextItemMatch(["Cafe\u0301", "\r\n", "net", "   force"], "Café net force")).toMatchObject({
			status: "unique",
		});
	});

	it("returns the item and offset range for one unique quote", () => {
		expect(findUniquePdfTextItemMatch(["Before ", "net ", "force", " after"], "net force")).toEqual({
			status: "unique",
			startItem: 1,
			startOffset: 0,
			endItem: 2,
			endOffset: 5,
		});
	});

	it("never chooses a first occurrence when a quote is ambiguous or absent", () => {
		expect(findUniquePdfTextItemMatch(["net force", " and ", "net force"], "net force")).toMatchObject({
			status: "ambiguous",
			count: 2,
		});
		expect(findUniquePdfTextItemMatch(["acceleration"], "net force")).toEqual({ status: "none" });
	});

	it("keeps UTF-16 offsets coherent for supplementary characters", () => {
		expect(findUniquePdfTextItemMatch(["Rocket 🚀 ", "net force"], "net force")).toMatchObject({
			status: "unique",
			startItem: 1,
			startOffset: 0,
		});
	});

	it("highlights the requested occurrence in the rendered text layer", () => {
		const root = document.createElement("div");
		root.textContent = "net force appears; net force repeats";
		document.body.append(root);

		const match = highlightPdfText(root, "net force", 2);

		expect(match.status).toBe("unique");
		expect(root.querySelectorAll("mark[data-pdf-evidence-highlight]")).toHaveLength(1);
		expect(root.querySelector("mark")?.textContent).toBe("net force");
	});
});
