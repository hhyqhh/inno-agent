import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { transform } from "lightningcss";

describe("workspace drag overlay", () => {
	it("keeps foreground controls opaque and gives the backdrop its own layer", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const overlayRules = [...css.matchAll(/([^{}]*\[data-workspace-resize-overlay\][^{}]*)\{([^{}]*)\}/g)];
		const backdrop = overlayRules.find(([_, selector]) => selector.includes(".inno-window-chrome::after"))?.[2] ?? "";
		expect(backdrop).toContain("position: absolute");
		expect(backdrop).toContain("transparent)");
		expect(backdrop).toContain("backdrop-filter: blur(");
		expect(backdrop).toContain("pointer-events: none");
		// Container opacity composites the foreground and its backdrop together,
		// letting the title read through the moving labels a second time.
		for (const [, selector, declarations] of overlayRules) {
			if (!selector.includes("::")) expect(declarations).not.toMatch(/opacity:\s*0\./);
		}
		expect(css).not.toMatch(/\[data-workspace-resize-overlay\][^{}]*\.inno-window-chrome-preview-tabs::before\s*\{/);
	});

	it("preserves the standard backdrop filter through production CSS optimization", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const backdrop = css.match(/\[data-workspace-resize-overlay\] \.inno-window-chrome::after\s*\{([^}]*)\}/)?.[1] ?? "";
		const optimized = transform({ filename: "drag-overlay.css", code: Buffer.from(`.overlay {${backdrop}}`), minify: true }).code.toString();
		// WebKit declared last made Lightning CSS discard the standard property;
		// Chromium then painted an unblurred title beneath the translucent layer.
		expect(optimized).toMatch(/(?<!-)backdrop-filter:blur\(/);
	});
});
