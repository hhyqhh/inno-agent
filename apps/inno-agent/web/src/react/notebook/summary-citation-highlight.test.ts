// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSummaryCitationHighlight,
	findCitationSentence,
	highlightCitationSentence,
} from "./summary-citation-highlight.js";

const scrollIntoView = vi.fn();

function rootWith(tag: "p" | "li" | "td" | "th", html: string): HTMLElement {
	const root = document.createElement("div");
	if (tag === "td" || tag === "th") {
		root.innerHTML = `<table><tbody><tr><${tag}>${html}</${tag}></tr></tbody></table>`;
	} else {
		root.innerHTML = `<${tag}>${html}</${tag}>`;
	}
	document.body.append(root);
	return root;
}

beforeEach(() => {
	scrollIntoView.mockReset();
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: scrollIntoView,
	});
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("findCitationSentence", () => {
	it.each(["p", "li", "td", "th"] as const)("finds the unique marker inside a %s block", (tag) => {
		const root = rootWith(tag, `前句。目标句<a href="#evidence-2">[2]</a>。后句。`);

		const result = findCitationSentence(root, 2);

		expect(result.status).toBe("located");
		if (result.status !== "located") throw new Error("Expected a located citation sentence");
		expect(result.block.tagName).toBe(tag.toUpperCase());
		expect(result.range.toString()).toBe("目标句[2]。");
	});

	it("uses English punctuation to bound the cited sentence", () => {
		const root = rootWith("p", `First sentence. Cited <strong>claim</strong> <a href="#evidence-7">[7]</a>! Last sentence?`);

		const result = findCitationSentence(root, 7);

		expect(result.status).toBe("located");
		if (result.status === "located") expect(result.range.toString()).toBe("Cited claim [7]!");
	});

	it("includes the preceding sentence when its citation follows terminal punctuation", () => {
		const root = rootWith("p", `Earlier. Cited claim. <a href="#evidence-8">[8]</a> Later.`);

		const result = findCitationSentence(root, 8);

		expect(result.status).toBe("located");
		if (result.status === "located") expect(result.range.toString()).toBe("Cited claim. [8]");
	});

	it("falls back to the whole semantic block when it has no sentence boundary", () => {
		const root = rootWith("li", `完整条目 <a href="#evidence-4">[4]</a> 没有句末标点`);

		const result = findCitationSentence(root, 4);

		expect(result.status).toBe("located");
		if (result.status === "located") expect(result.range.toString()).toBe("完整条目 [4] 没有句末标点");
	});

	it("fails closed when the scoped root contains duplicate marker anchors", () => {
		const root = rootWith("p", `<a href="#evidence-1">[1]</a> 第一处。<a href="#evidence-1">[1]</a> 第二处。`);

		expect(findCitationSentence(root, 1)).toEqual({ status: "ambiguous" });
	});

	it("does not search outside the supplied root", () => {
		rootWith("p", `<a href="#evidence-5">[5]</a> 外部引用。`);
		const scoped = rootWith("p", "当前摘要没有引用。");

		expect(findCitationSentence(scoped, 5)).toEqual({ status: "not-found" });
	});
});

describe("summary citation highlighting", () => {
	it("marks the complete sentence while preserving and focusing its link", () => {
		const root = rootWith("p", `前句。目标<strong>摘要</strong><a href="#evidence-3">[3]</a>；后句。`);
		const result = findCitationSentence(root, 3);
		if (result.status !== "located") throw new Error("Expected a located citation sentence");

		const marks = highlightCitationSentence(result);
		const anchor = root.querySelector<HTMLAnchorElement>('a[href="#evidence-3"]');

		expect(marks).not.toHaveLength(0);
		expect(root.querySelectorAll("mark[data-summary-citation-highlight]").length).toBe(marks.length);
		expect(marks.map((mark) => mark.textContent).join("")).toBe("目标摘要[3]；");
		expect(anchor).not.toBeNull();
		expect(document.activeElement).toBe(anchor);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
	});

	it("cleans prior marks idempotently and restores the original text", () => {
		const root = rootWith("p", `前句。目标句<a href="#evidence-9">[9]</a>。后句。`);
		const first = findCitationSentence(root, 9);
		if (first.status !== "located") throw new Error("Expected a located citation sentence");
		highlightCitationSentence(first);

		clearSummaryCitationHighlight(root);
		clearSummaryCitationHighlight(root);

		expect(root.querySelector("mark[data-summary-citation-highlight]")).toBeNull();
		expect(root.textContent).toBe("前句。目标句[9]。后句。");
		expect(root.querySelector('a[href="#evidence-9"]')).not.toBeNull();
		const second = findCitationSentence(root, 9);
		expect(second.status).toBe("located");
		if (second.status === "located") {
			highlightCitationSentence(second);
			expect(root.querySelectorAll("mark[data-summary-citation-highlight]").length).toBeGreaterThan(0);
			expect(root.querySelector("mark mark")).toBeNull();
		}
	});
});
