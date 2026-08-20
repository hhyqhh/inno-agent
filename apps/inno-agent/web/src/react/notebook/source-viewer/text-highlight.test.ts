// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearTextHighlights,
	findTextOffsetsAtOccurrence,
	findTextRangeAtOccurrence,
	findUniqueTextOffsets,
	findUniqueTextRange,
	highlightTextRange,
	preferredScrollBehavior,
} from "./text-highlight.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("findUniqueTextRange", () => {
	it("maps NFC, newlines, and collapsed whitespace back to one DOM range", () => {
		const root = document.createElement("div");
		root.append(document.createTextNode("Cafe"));
		const emphasis = document.createElement("em");
		emphasis.append(document.createTextNode("\u0301\r\n  net"));
		root.append(emphasis, document.createTextNode("\tforce applies"));

		const result = findUniqueTextRange(root, "Caf\u00e9 net force");

		expect(result.status).toBe("unique");
		if (result.status !== "unique") throw new Error("Expected a unique range");
		expect(result.range.toString()).toBe("Cafe\u0301\r\n  net\tforce");
		expect(result.range.startContainer).toBe(root.firstChild);
		expect(result.range.endContainer).toBe(root.lastChild);
	});

	it("distinguishes no match from multiple matches without selecting the first", () => {
		const root = document.createElement("div");
		root.textContent = "alpha\tbeta / alpha  beta";

		expect(findUniqueTextRange(root, "missing text")).toEqual({ status: "none" });
		expect(findUniqueTextRange(root, "alpha beta")).toEqual({
			status: "ambiguous",
			count: 2,
		});
	});

	it("ignores executable and hidden document nodes", () => {
		const root = document.createElement("div");
		root.append(document.createTextNode("visible quote"));
		const script = document.createElement("script");
		script.textContent = "visible quote";
		root.append(script);

		const result = findUniqueTextRange(root, "visible quote");

		expect(result.status).toBe("unique");
	});

	it("treats a BR as normalized whitespace while preserving a DOM range", () => {
		const root = document.createElement("div");
		const left = document.createElement("span");
		left.textContent = "net";
		const breakNode = document.createElement("br");
		const right = document.createElement("span");
		right.textContent = "force";
		root.append(left, breakNode, right);

		const result = findUniqueTextRange(root, "net force");

		expect(result.status).toBe("unique");
		if (result.status !== "unique") throw new Error("Expected a unique range");
		expect(result.range.startContainer).toBe(left.firstChild);
		expect(result.range.endContainer).toBe(right.firstChild);
	});
});

describe("text highlight helpers", () => {
	it("uses instant scrolling when the user prefers reduced motion", () => {
		vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

		expect(preferredScrollBehavior()).toBe("auto");
	});

	it("returns source offsets for a normalized unique string match", () => {
		const text = "Before\nnet   force\tafter";
		expect(findUniqueTextOffsets(text, "net force")).toEqual({
			status: "unique",
			start: 7,
			end: 18,
		});
	});

	it("selects a requested occurrence without treating it as the first by default", () => {
		const text = "net force appears; net force repeats";
		expect(findTextOffsetsAtOccurrence(text, "net force", 2)).toEqual({
			status: "unique",
			start: 19,
			end: 28,
		});
		const root = document.createElement("div");
		root.textContent = text;
		const range = findTextRangeAtOccurrence(root, "net force", 2);
		expect(range.status).toBe("unique");
		if (range.status === "unique") expect(range.range.toString()).toBe("net force");
	});

	it("marks a cross-node range and can restore the original text DOM", () => {
		const root = document.createElement("div");
		root.append(document.createTextNode("net "));
		const strong = document.createElement("strong");
		strong.textContent = "force";
		root.append(strong);
		const match = findUniqueTextRange(root, "net force");
		if (match.status !== "unique") throw new Error("Expected a unique range");

		const marks = highlightTextRange(match.range);

		expect(marks).toHaveLength(2);
		expect(root.querySelectorAll("mark[data-evidence-highlight]")).toHaveLength(2);
		clearTextHighlights(root);
		expect(root.querySelector("mark")).toBeNull();
		expect(root.textContent).toBe("net force");
	});
});
