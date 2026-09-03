import { describe, expect, it } from "vitest";
import { normalizeMarkdownMath, normalizeMarkdownMathForStreamdown } from "./markdown-math.js";

describe("normalizeMarkdownMath (mini-lit path)", () => {
	it("preserves LaTeX delimiters so mini-lit keeps inline vs display semantics", () => {
		expect(normalizeMarkdownMath("求 \\(x^2=4\\) 的解")).toBe("求 \\(x^2=4\\) 的解");
		expect(normalizeMarkdownMath("\\[ E = mc^2 \\]")).toBe("\\[ E = mc^2 \\]");
	});

	it("escapes raw < inside math spans for KaTeX", () => {
		expect(normalizeMarkdownMath("$a < b$")).toBe("$a \\lt  b$");
	});

	it("leaves fenced code untouched", () => {
		const source = "```\n\\(not math\\) <\n```";
		expect(normalizeMarkdownMath(source)).toBe(source);
	});
});

describe("normalizeMarkdownMathForStreamdown", () => {
	it("translates inline \\(...\\) to single-line $$ so it parses as inline math", () => {
		expect(normalizeMarkdownMathForStreamdown("求 \\(x^2=4\\) 的解")).toBe("求 $$x^2=4$$ 的解");
	});

	it("translates display \\[...\\] to a $$ block so it keeps display semantics", () => {
		expect(normalizeMarkdownMathForStreamdown("\\[ E = mc^2 \\]")).toBe("$$\nE = mc^2\n$$");
	});

	it("collapses blank lines inside display math that would split the paragraph", () => {
		const out = normalizeMarkdownMathForStreamdown("\\[\n\\begin{aligned} a \\\\ \n\n b \\end{aligned}\n\\]");
		expect(out).not.toMatch(/\n[ \t]*\n/);
		expect(out.startsWith("$$\n")).toBe(true);
		expect(out.endsWith("\n$$")).toBe(true);
	});

	it("leaves $...$ spans untouched when single-dollar math is disabled", () => {
		expect(normalizeMarkdownMathForStreamdown("如果 $a < $b 则递增", { singleDollar: false }))
			.toBe("如果 $a < $b 则递增");
		expect(normalizeMarkdownMathForStreamdown("价格是 $99", { singleDollar: false }))
			.toBe("价格是 $99");
	});

	it("normalizes $...$ spans when single-dollar math is enabled", () => {
		expect(normalizeMarkdownMathForStreamdown("$a < b$", { singleDollar: true }))
			.toBe("$a \\lt  b$");
	});

	it("still normalizes $$...$$ spans when single-dollar math is disabled", () => {
		expect(normalizeMarkdownMathForStreamdown("$$a < b$$", { singleDollar: false }))
			.toBe("$$a \\lt  b$$");
	});
});
