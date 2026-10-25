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
		expect(fullHeaderActions).toContain("right: calc(16px + (var(--inno-window-chrome-control-size) + var(--inno-window-chrome-action-gap)) * 2)");
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
		expect(panel).toContain("border-left-color var(--inno-dur-modal)");
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
});
