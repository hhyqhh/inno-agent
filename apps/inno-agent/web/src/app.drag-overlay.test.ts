import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace drag overlay", () => {
	it("shows a borderless translucent plate only when the preview crosses into chat", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const resizingRules = [...css.matchAll(/([^{}]*\.workspace-resizing[^{}]*)\{([^{}]*)\}/g)];
		const plate = css.match(/(?<![\w -])\.inno-window-chrome-drag-plate\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(plate).toContain("display: none");
		expect(plate).toContain("pointer-events: none");
		expect(plate).toContain("color-mix");
		expect(plate).toContain("80%, transparent");
		expect(plate).toContain("backdrop-filter: blur(");
		expect(plate).toContain("border: 0");
		expect(plate).toContain("box-shadow: none");
		expect(plate).toContain("z-index: 2");
		const visibility = resizingRules.filter(([, selector]) => selector.includes(".inno-window-chrome-drag-plate"));
		expect(visibility).toHaveLength(1);
		expect(visibility[0][1]).toContain(".app-layout[data-workspace-resize-overlay]");
		expect(visibility[0][2]).toContain("display: block");
		// The overlay must not change the tab track's width/right inset: that
		// previously put the plus and start-page tab under the window buttons.
		for (const [, selector, declarations] of resizingRules) {
			if (selector.trim().endsWith(".inno-window-chrome-preview-tabs")) {
				expect(declarations).not.toMatch(/(?:background|padding|margin|(?:max-)?width|right):/);
			}
		}
		expect(resizingRules.some(([, selector]) => selector.includes(".inno-window-chrome::after"))).toBe(false);
		for (const [, selector, declarations] of resizingRules) {
			if (!selector.includes("::")) expect(declarations).not.toMatch(/opacity:\s*0\./);
		}
		expect(css).not.toMatch(/\.workspace-resizing[^{}]*\.inno-window-chrome-preview-tabs::before\s*\{/);
	});

	it("keeps every toolbar control above the plate", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const raise = css.match(/\.workspace-resizing [^{]*\{([^}]*)\}/g) ?? [];
		const topLayer = raise.find((block) => block.includes("z-index: 3")) ?? "";
		// Any control left below the plate (the maximize and workspace-toggle
		// buttons sit at z-index: 1) disappears under it.
		for (const control of [
			".inno-window-chrome-preview-tabs",
			".inno-window-chrome-preview-terminal",
			".inno-window-chrome-preview-fullscreen",
			".inno-window-chrome-workspace-button",
			".inno-conversation-header-actions",
		]) {
			expect(topLayer).toContain(control);
		}
		// The shared conversation header carries z-index: 5 for the browser
		// layout; during a drag that level floats the title text above the
		// plate and every control. It must drop to tree order (no stacking
		// context, so the trailing z-index: 3 actions still escape it).
		// Both portal ancestors need to beat the desktop base selectors. Merely
		// finding a z-index:auto declaration missed the overridden host rule.
		for (const selector of [
			".workspace-resizing .app-layout--desktop.app-layout--chat .inno-window-chrome-chat-header",
			".workspace-resizing .app-layout--desktop.app-layout--chat .inno-window-chrome-chat-header > .inno-conversation-header",
		]) {
			expect(raise.find((block) => block.startsWith(selector + " {"))).toContain("z-index: auto");
		}
	});
});
