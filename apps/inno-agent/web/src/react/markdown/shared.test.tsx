// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { MarkdownFullscreenDialog } from "./shared.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete document.documentElement.dataset.theme;
});

describe("shared fullscreen viewer", () => {
	it.each(["light", "dark"])("reserves macOS titlebar space above all tools in %s mode", (theme) => {
		document.documentElement.dataset.theme = theme;
		vi.stubGlobal("innoDesktop", {});
		vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		const onClose = vi.fn();
		const { unmount } = render(<MarkdownFullscreenDialog open title="Preview" closeLabel="Exit" onClose={onClose} actions={<button>Copy</button>}><div>Content</div></MarkdownFullscreenDialog>);
		const dialog = screen.getByRole("dialog");
		expect(dialog.children[0].className).toBe("inno-markdown-fullscreen-titlebar");
		expect(dialog.children[1].className).toBe("inno-markdown-fullscreen-header");
		expect(dialog.children[1].textContent).toContain("Copy");
		expect(dialog.querySelector(".inno-markdown-fullscreen-titlebar")?.textContent).toBe("");
		expect(document.body.style.overflow).toBe("hidden");
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		unmount();
		expect(document.body.style.overflow).toBe("");
	});

	it.each([
		{ platform: "MacIntel", desktop: undefined },
		{ platform: "Win32", desktop: {} },
	])("does not add a second titlebar for $platform desktop=$desktop", ({ platform, desktop }) => {
		vi.stubGlobal("innoDesktop", desktop);
		vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
		render(<MarkdownFullscreenDialog open title="Preview" closeLabel="Exit" onClose={vi.fn()}>Content</MarkdownFullscreenDialog>);
		expect(screen.getByRole("dialog").querySelector(".inno-markdown-fullscreen-titlebar")).toBeNull();
	});
});
