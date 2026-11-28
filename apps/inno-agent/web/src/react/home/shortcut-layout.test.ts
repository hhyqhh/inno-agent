import { describe, expect, it } from "vitest";
import type { ShortcutCard } from "../../stores/home-shortcuts-store.js";
import { arrangeShortcuts, moveShortcut } from "./shortcut-layout.js";

const wideReminder: ShortcutCard = { key: "reminder:prep", size: "wide" };
const wideOverview: ShortcutCard = { key: "reminders", size: "wide" };
const workspace: ShortcutCard = { key: "workspace:math", size: "standard" };
const bank: ShortcutCard = { key: "workspace:bank", size: "standard" };

describe("home shortcut arrangement", () => {
	it("fills both three-column rows without changing card widths", () => {
		const stored = [wideReminder, wideOverview, workspace, bank];
		expect(arrangeShortcuts(stored, 3)).toEqual([wideReminder, workspace, wideOverview, bank]);
		expect(arrangeShortcuts(stored, 2)).toEqual(stored);
		expect(arrangeShortcuts(stored, 1)).toEqual(stored);
	});

	it("uses the same visible order for forward moves and rendering", () => {
		const visible = [wideReminder, workspace, wideOverview, bank];
		const moved = moveShortcut(visible, 1, 2, 3);
		expect(moved).toEqual([wideReminder, bank, wideOverview, workspace]);
		expect(arrangeShortcuts(moved!, 3)).toEqual(moved);
	});
});
