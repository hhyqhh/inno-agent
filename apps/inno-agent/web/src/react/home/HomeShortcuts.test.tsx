import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { homeShortcutsStore } from "../../stores/home-shortcuts-store.js";
import { HomeShortcuts } from "./HomeShortcuts.js";
import { ChatWelcome } from "../chat/ChatWelcome.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }),
}));
vi.mock("../terminal/TerminalDrawer.js", () => ({ TerminalDrawer: () => null }));
vi.mock("../../api/jobs.js", () => ({ listJobs: vi.fn(async () => []) }));

beforeAll(() => {
	if (!HTMLDialogElement.prototype.showModal) {
		HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
		HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
	}
});

afterEach(() => {
	cleanup();
	homeShortcutsStore.update([]);
});

describe("chat welcome shortcuts", () => {
	it.each(["light", "dark"])("shows the empty board and opens the workspace entry in %s theme", (theme) => {
		const onCreate = vi.fn();
		render(<div data-theme={theme}><ChatWelcome questionHint={null} busyBlocker={null} smartToast={null}
			composer={<div>composer</div>} wsError="" shortcuts={<HomeShortcuts
				workspaces={[]} selectedId={null} onSelect={vi.fn()} onEdit={vi.fn()} onCreate={onCreate} />} /></div>);
		expect(screen.getByRole("region", { name: "home.shortcuts" })).toBeTruthy();
		expect(screen.getByText("home.empty")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "home.addCard" }));
		fireEvent.click(screen.getByRole("button", { name: "workspace.newWorkspace" }));
		expect(onCreate).toHaveBeenCalledOnce();
	});
});
