import { describe, expect, it } from "vitest";

import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";

describe("normalizeMarkdownForMilkdown", () => {
	it("unwraps a whole-document Markdown fence and normalizes line endings", () => {
		expect(normalizeMarkdownForMilkdown("```markdown\r\n# Title\r\n\r\nBody\r\n```"))
			.toBe("# Title\n\nBody\n");
	});

	it("removes raw HTML wrappers and separates block elements", () => {
		expect(normalizeMarkdownForMilkdown("<p>Intro<br>next</p>\n- item\n\n\n<!-- hidden -->"))
			.toBe("Intro\nnext\n\n- item\n");
	});
});
