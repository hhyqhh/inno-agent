import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fullscreen preview toolbar layout", () => {
	it("keeps macOS preview tabs outside the title safe area", async () => {
		const appCss = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const fullModeLayout = appCss.match(/\.app-layout--desktop:not\(\.app-layout--windows\)\.app-layout--workspace-full \.inno-window-chrome\s*\{([^}]*)\}/)?.[1] ?? "";
		const safeTabs = appCss.match(/\.app-layout--desktop:not\(\.app-layout--windows\)\.app-layout--workspace-full \.inno-window-chrome-preview-tabs\s*\{([^}]*)\}/)?.[1] ?? "";
		const fullChatHeader = appCss.match(/\.app-layout--desktop:not\(\.app-layout--windows\)\.app-layout--chat\.app-layout--workspace-full \.inno-window-chrome-chat-header > \.inno-conversation-header\s*\{([^}]*)\}/)?.[1] ?? "";
		const fullTabs = appCss.match(/\.app-layout--desktop\.app-layout--chat\.app-layout--workspace-full \.inno-window-chrome:has\(> \.inno-window-chrome-chat-header\[data-active-conversation="true"\]\) \.inno-window-chrome-preview-tabs\s*\{([^}]*)\}/)?.[1] ?? "";
		const fullHeaderActions = appCss.match(/\.app-layout--desktop\.app-layout--chat\.app-layout--workspace-full \.inno-conversation-header-actions\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(fullModeLayout).not.toContain("--inno-workspace-full-header-slot");
		expect(appCss).not.toContain("--inno-workspace-full-header-slot: 240px");
		expect(fullModeLayout).toContain("var(--inno-window-chrome-navigation-count)");
		expect(safeTabs).toContain("left: var(--inno-workspace-full-tabs-left)");
		expect(fullChatHeader).toContain("padding-right: 0");
		expect(fullChatHeader).not.toContain("padding-right: calc(");
		expect(fullTabs).toContain("right: calc(16px + (var(--inno-window-chrome-control-size) + var(--inno-window-chrome-action-gap)) * 3)");
		// Actions and title clearance now consume the same placement token.
		expect(fullHeaderActions).toContain("right: var(--inno-chat-action-right)");
		const fullActionPlacement = appCss.match(/\.app-layout--desktop\.app-layout--chat\.app-layout--workspace-full \.inno-window-chrome\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(fullActionPlacement).toContain("--inno-chat-action-right: calc(16px + (var(--inno-window-chrome-control-size) + var(--inno-window-chrome-action-gap)) * 2)");
		expect(fullHeaderActions).toContain("top: var(--inno-window-chrome-control-top)");
		const questionButton = appCss.match(/\.app-layout--desktop\.app-layout--chat\.app-layout--workspace-full \.inno-conversation-btw-control\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(questionButton).toContain("width: var(--inno-window-chrome-control-size)");
		expect(questionButton).toContain("height: var(--inno-window-chrome-control-size)");
	});

	it("fades only the full-height panel boundary in fullscreen and retains the toolbar separator", async () => {
		const appCss = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const panel = appCss.match(/(?<![\w -])\.inno-desktop-workbench > \.workspace-panel--merged\s*\{([^}]*)\}/)?.[1] ?? "";
		const fullPanel = appCss.match(/\.app-layout--workspace-full \.inno-desktop-workbench > \.workspace-panel--merged\s*\{([^}]*)\}/)?.[1] ?? "";
		const toolbarDivider = appCss.match(/\.app-layout--desktop:not\(\.app-layout--windows\)\.app-layout--workspace-full \.inno-window-chrome-preview-divider\s*\{([^}]*)\}/)?.[1] ?? "";
		// The full-view override must beat the active-title selector (five class /
		// attribute selectors), otherwise both nearby separators remain visible.
		const titleDivider = appCss.match(/\.app-layout--desktop\.app-layout--chat\.app-layout--workspace-full \.inno-window-chrome\.has-conversation-tabs > \.inno-window-chrome-divider\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(panel).toContain("border-left: 1px solid var(--inno-border)");
		// The border fades on the sidebar grid's curve: its edge travels with the
		// chat shell's grid track during sidebar toggles in the full view.
		expect(panel).toContain("border-left-color 220ms cubic-bezier(0.4, 0, 0.2, 1)");
		expect(fullPanel).toContain("width: 100%");
		expect(fullPanel).toContain("border-left-color: transparent");
		expect(fullPanel).not.toMatch(/(?:opacity: 0|visibility: hidden|border-left: 0)/);
		expect(toolbarDivider).toContain("opacity: 1");
		expect(toolbarDivider).toContain("visibility: visible");
		expect(titleDivider).toContain("opacity: 0");
		expect(titleDivider).toContain("visibility: hidden");
	});

	it("anchors the fullscreen separator to the expanded sidebar boundary", async () => {
		const appCss = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const alignedDivider = appCss.match(/\.app-layout--desktop:not\(\.app-layout--windows\)\.app-layout--workspace-full\.app-layout--sidebar-expanded \.inno-window-chrome-preview-divider\s*\{([^}]*)\}/)?.[1] ?? "";
		// Track origin + divider offset = sidebar boundary at every sidebar width.
		expect(alignedDivider).toContain("left: calc(var(--sidebar-w) - var(--inno-workspace-full-tabs-left))");
	});

	it("moves only the shared track and keeps the plus next to short tab lists", async () => {
		const appCss = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const divider = appCss.match(/\.inno-window-chrome-preview-divider\s*\{([^}]*)\}/)?.[1] ?? "";
		const strip = appCss.match(/\.inno-workspace-tabs-strip\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(divider).toContain("left: -11px");
		expect(divider).not.toMatch(/transition: (left|right)/);
		expect(strip).toContain("flex: 0 1 auto");
		expect(strip).toContain("overflow-x: auto");
	});

	it("tracks the split edge at pointer rate during a live drag", async () => {
		const appCss = await readFile(new URL("./app.css", import.meta.url), "utf8");
		// The rendered panel border must consume the pointer-driven width while
		// the layout can apply it; deferred native expansion can advance the
		// live body separately from the requested preview width.
		const liveLayout = appCss.match(/\.workspace-resizing \.app-layout\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(liveLayout).toContain("--workspace-w: var(--inno-workspace-live-width");
		// The chat boundary is sized inline by React through a px var; during a
		// drag it must read the same pointer-rate width or its edge trails the
		// strip and drag line by a frame.
		const chatContent = appCss.match(/\.workspace-resizing \.app-layout--desktop\.app-layout--chat \.inno-desktop-workbench > \.inno-desktop-chat-content\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(chatContent).toContain("width: max(0px, calc(100% - var(--workspace-w) + 3px))");
	});

	it("removes toolbar CSS interpolation while dragging a column", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const rule = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).find(([, selectors, body]) =>
			selectors.includes(".inno-ui-resizing-columns .inno-desktop-sidebar-panel") && body.includes("transition: none"));
		expect(rule?.[1]).toContain(".inno-ui-resizing-columns .inno-window-chrome-preview-tabs");
	});

	it("keeps toolbar and body geometry synchronous throughout native window resizing", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const rule = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find(([, selectors, body]) =>
			selectors.includes("[data-window-layout-resizing]") && body.includes("transition: none"));
		expect(rule).toBeDefined();
		expect(rule![1]).toContain(":is([data-window-resizing], [data-window-layout-resizing]) .app-layout--desktop:not(.app-layout--workspace-collapsed) :is(");
		for (const target of [
			".inno-desktop-workbench > .workspace-panel--merged",
			".inno-desktop-chat-content",
			".inno-window-chrome-preview-divider",
			".inno-window-chrome-preview-terminal",
			".inno-window-chrome-preview-tabs",
			".inno-conversation-header-actions",
			".inno-desktop-chat-shell",
			".inno-window-chrome-chat-header > .inno-conversation-header",
		]) {
			expect(rule![1].split(":is([data-window-resizing]")[1]).toContain(target);
		}
		// Normal preview opening/closing retains the existing transitions.
		expect(css.match(/\.inno-desktop-workbench > \.workspace-panel--merged\s*\{([^}]*)\}/)?.[1]).toContain("transition: width");
		expect(css.match(/(?<![\w -])\.inno-window-chrome-preview-tabs\s*\{([^}]*)\}/)?.[1]).toContain("transition: left");
	});

	it("lands the full-view panel edge and toolbar travelers on the sidebar timeline", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const layoutCurve = "220ms cubic-bezier(0.4, 0, 0.2, 1)";
		const rulesFor = (selector: string) => [...css.matchAll(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "gm"))].map((match) => match[1]).join("\n");
		// Desktop full view: the merged preview's width and the chat content's
		// clip follow the chat shell's grid track, so all three must share the
		// sidebar grid's curve; the modal curve let the shared edge drift apart
		// mid-toggle while the tab track traveled on its own timeline.
		expect(rulesFor(".app-layout--desktop.app-layout--chat > .inno-desktop-chat-shell")).toContain(`transition: grid-template-columns ${layoutCurve}`);
		expect(rulesFor(".inno-desktop-workbench > .workspace-panel--merged")).toContain(`transition: width ${layoutCurve}`);
		expect(rulesFor(".inno-desktop-chat-content")).toContain(`transition:\n\t\twidth ${layoutCurve}`);
		expect(rulesFor(".inno-window-chrome-preview-tabs")).toContain(`transition: left ${layoutCurve}, right ${layoutCurve}`);
		expect(rulesFor(".inno-window-chrome-preview-terminal")).toContain(`transition: right ${layoutCurve}`);
		expect(rulesFor(".app-layout--desktop.app-layout--chat .inno-conversation-header-actions")).toContain(`transition: right ${layoutCurve}`);
		expect(rulesFor(".app-layout--desktop.app-layout--chat .inno-window-chrome-chat-header > .inno-conversation-header")).toContain(`padding-right ${layoutCurve}`);
	});

	it("keeps the document visible until its owner has slid closed", async () => {
		const css = await readFile(new URL("./app.css", import.meta.url), "utf8");
		const content = css.match(/\.workspace-panel > \.inno-ui-tab-panel\s*\{([^}]*)\}/)?.[1] ?? "";
		const closed = css.match(/\.workspace-panel\[data-state="closed"\] > \.inno-ui-tab-panel\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(content).toContain("visibility: visible");
		expect(content).toContain("transition: visibility 0s");
		expect(closed).toContain("visibility: hidden");
		expect(closed).toContain("transition-delay: var(--inno-dur-modal)");
	});
});
