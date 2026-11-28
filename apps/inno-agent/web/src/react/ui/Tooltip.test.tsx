import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { Tooltip, focusWithoutTooltip } from "./Tooltip.js";

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; });

describe("Tooltip focus restoration", () => {
	it.each(["light", "dark"])("restores focus silently and retains ordinary focus hints in %s", async (theme) => {
		document.documentElement.dataset.theme = theme;
		render(<><button>Other</button><Tooltip label="Expand workspace"><button>Workspace</button></Tooltip></>);
		const target = screen.getByRole("button", { name: "Workspace" });
		act(() => focusWithoutTooltip(target));
		expect(document.activeElement).toBe(target);
		expect(screen.queryByRole("tooltip")).toBeNull();
		act(() => screen.getByRole("button", { name: "Other" }).focus());
		// A later keyboard focus is independent of the silent restoration.
		fireEvent.keyDown(document, { key: "Tab" });
		act(() => target.focus());
		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(document.body);
	});
});

describe("Tooltip portal", () => {
	it.each(["light", "dark"])("renders at the dialog root in %s", (theme) => {
		document.documentElement.dataset.theme = theme;
		render(<dialog open aria-label="Workspace settings">
			<div style={{ overflow: "auto" }}>
				<Tooltip label="Skill description" open><button>Import skill</button></Tooltip>
			</div>
		</dialog>);
		const dialog = screen.getByRole("dialog", { name: "Workspace settings" });
		const tooltip = screen.getByRole("tooltip");
		expect(tooltip.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(dialog);
	});
});
