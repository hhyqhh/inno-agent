import { readFile } from "node:fs/promises";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { homeShortcutsStore } from "../../stores/home-shortcuts-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { TooltipProvider } from "../ui/index.js";
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
	sessionsStore.sessions = [];
});

describe("chat welcome shortcuts", () => {
	it.each(["light", "dark"])("shows the empty board and opens the workspace entry in %s theme", (theme) => {
		const onCreate = vi.fn();
		render(<div data-theme={theme}><ChatWelcome questionHint={null} busyBlocker={null} smartToast={null}
			composer={<div>composer</div>} wsError="" shortcuts={<HomeShortcuts
				workspaces={[]} selectedId={null} onSelect={vi.fn()} onEdit={vi.fn()} onCreate={onCreate} />} /></div>);
		expect(screen.getByRole("region", { name: "home.shortcuts" })).toBeTruthy();
		expect(screen.getByText("home.empty")).toBeTruthy();
		expect(screen.getByText("home.emptyAction")).toBeTruthy();
		fireEvent.click(screen.getByText("home.empty"));
		fireEvent.click(screen.getByRole("button", { name: "workspace.newWorkspace" }));
		expect(onCreate).toHaveBeenCalledOnce();
	});

	it("shows the latest conversation on unconfigured workspace cards and filters grouped picker items", () => {
		sessionsStore.sessions = [
			{
				id: "s-old",
				name: "Earlier chat",
				createdAt: "2026-11-25T10:00:00.000Z",
				updatedAt: "2026-11-25T10:00:00.000Z",
				messageCount: 2,
				preview: "old",
				channels: ["web"],
			},
			{
				id: "s-new",
				name: "Latest math optimization",
				createdAt: "2026-11-28T07:00:00.000Z",
				updatedAt: "2026-11-28T07:27:00.000Z",
				messageCount: 4,
				preview: "latest",
				channels: ["web"],
			},
		];
		homeShortcutsStore.update([
			{ key: "workspace:ws-1", size: "standard" },
			{ key: "workspace:ws-2", size: "standard" },
		]);
		const workspaces = [
			{ id: "ws-1", name: "AI4Math", relPath: "ai4math", createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-28T00:00:00.000Z", isTemp: false, sessionIds: ["s-old", "s-new"] },
			{ id: "ws-2", name: "Empty Space", relPath: "empty", createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-28T00:00:00.000Z", isTemp: false, sessionIds: [] },
		];

		const onSelect = vi.fn();
		const onOpenSession = vi.fn();
		render(<HomeShortcuts workspaces={workspaces} selectedId="ws-1" onSelect={onSelect} onOpenSession={onOpenSession} onEdit={vi.fn()} onCreate={vi.fn()} />);
		expect(screen.getByText("Latest math optimization")).toBeTruthy();
		expect(screen.getByText("home.noSessions")).toBeTruthy();

		fireEvent.click(screen.getByText("Latest math optimization"));
		expect(onOpenSession).toHaveBeenCalledWith("s-new");
		expect(onSelect).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "home.addCard" }));
		expect(screen.getByText("home.groupOverview")).toBeTruthy();
		expect(screen.getByText("home.groupWorkspaces")).toBeTruthy();

		fireEvent.change(screen.getByPlaceholderText("home.searchCards"), { target: { value: "non-existent-xyz" } });
		expect(screen.getByText("home.noMatches")).toBeTruthy();
	});

	it("closes the card options popover after performing an action", () => {
		const onEdit = vi.fn();
		homeShortcutsStore.update([{ key: "workspace:ws-1", size: "standard" }]);
		const workspaces = [
			{ id: "ws-1", name: "AI4Math", relPath: "ai4math", createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-28T00:00:00.000Z", isTemp: false },
		];

		render(<HomeShortcuts workspaces={workspaces} selectedId={null} onSelect={vi.fn()} onEdit={onEdit} onCreate={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "home.cardOptions" }));
		expect(screen.getByRole("button", { name: "home.editWorkspace" })).toBeTruthy();

		fireEvent.click(screen.getByRole("radio", { name: "home.wide" }));
		expect(screen.queryByRole("button", { name: "home.editWorkspace" })).toBeNull();
		expect(homeShortcutsStore.cards[0]?.size).toBe("wide");

		fireEvent.click(screen.getByRole("button", { name: "home.cardOptions" }));
		fireEvent.click(screen.getByRole("button", { name: "home.editWorkspace" }));
		expect(onEdit).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "home.editWorkspace" })).toBeNull();
	});

	it("shows a tooltip with the workspace purpose when present", () => {
		homeShortcutsStore.update([
			{ key: "workspace:ws-with-purpose", size: "standard" },
			{ key: "workspace:ws-plain", size: "standard" },
		]);
		const workspaces = [
			{
				id: "ws-with-purpose",
				name: "Math Prep",
				purpose: "Prepare grade-5 math lesson plans and quizzes",
				relPath: "math-prep",
				createdAt: "2026-11-20T00:00:00.000Z",
				updatedAt: "2026-11-28T00:00:00.000Z",
				isTemp: false,
			},
			{
				id: "ws-plain",
				name: "Plain Space",
				relPath: "plain",
				createdAt: "2026-11-20T00:00:00.000Z",
				updatedAt: "2026-11-28T00:00:00.000Z",
				isTemp: false,
			},
		];

		render(
			<TooltipProvider delayDuration={0}>
				<HomeShortcuts workspaces={workspaces} selectedId={null} onSelect={vi.fn()} onEdit={vi.fn()} onCreate={vi.fn()} />
			</TooltipProvider>,
		);

		fireEvent.focus(screen.getByRole("button", { name: /Math Prep/ }));
		expect(screen.getByRole("tooltip").textContent).toContain("Prepare grade-5 math lesson plans and quizzes");

		fireEvent.blur(screen.getByRole("button", { name: /Math Prep/ }));
		fireEvent.focus(screen.getByRole("button", { name: /Plain Space/ }));
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("merges privateSkillNames onto wide workspace cards", () => {
		homeShortcutsStore.update([{ key: "workspace:ws-priv", size: "wide" }]);
		const workspaces = [
			{
				id: "ws-priv",
				name: "Teaching Webpage",
				relPath: "teaching-webpage",
				createdAt: "2026-11-20T00:00:00.000Z",
				updatedAt: "2026-11-28T00:00:00.000Z",
				isTemp: false,
				privateSkillNames: ["interactive-webpage"],
			},
		];

		render(<HomeShortcuts workspaces={workspaces} selectedId={null} onSelect={vi.fn()} onEdit={vi.fn()} onCreate={vi.fn()} />);
		expect(screen.getByRole("button", { name: "interactive-webpage" })).toBeTruthy();
	});

	it("lets wrapped workspace content and the recent session contribute to the card height", async () => {
		const homeCss = await readFile("apps/inno-agent/web/src/react/home/home.css", "utf8");
		const board = homeCss.match(/\.inno-home-board\s*\{([^}]*)\}/)?.[1];
		const mainAction = homeCss.match(/\.inno-home-card \.inno-home-card-hit\s*\{([^}]*)\}/)?.[1];
		const recentSession = homeCss.match(/\.inno-home-card-session-btn\s*\{([^}]*)\}/)?.[1];

		expect(board).toContain("grid-auto-rows: max-content;");
		expect(mainAction).toContain("height: auto;");
		expect(recentSession).toContain("flex: none;");
	});

	it("keeps outer welcome viewport non-scrollable and confines overflow scrolling to the card board", async () => {
		const { container } = render(
			<ChatWelcome
				questionHint={null}
				busyBlocker={null}
				smartToast={null}
				composer={<div>composer</div>}
				wsError=""
				shortcuts={<HomeShortcuts workspaces={[]} selectedId={null} onSelect={vi.fn()} onEdit={vi.fn()} onCreate={vi.fn()} />}
			/>,
		);

		const viewport = container.querySelector(".inno-chat-welcome-viewport");
		expect(viewport).toBeTruthy();
		expect(viewport?.className).toContain("overflow-hidden");
		expect(viewport?.className).not.toContain("overflow-y-auto");

		const appCss = await readFile("apps/inno-agent/web/src/app.css", "utf8");
		const homeCss = await readFile("apps/inno-agent/web/src/react/home/home.css", "utf8");
		const welcomeLayout = appCss.match(/\.inno-chat-welcome-layout\s*\{([^}]*)\}/)?.[1] ?? "";
		const welcomeLayoutWithShortcuts = homeCss.match(/\.inno-chat-welcome-layout:has\(\.inno-home-shortcuts\)\s*\{([^}]*)\}/)?.[1] ?? "";
		const board = homeCss.match(/\.inno-home-board\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(welcomeLayout).toContain("min-height: 0");
		expect(welcomeLayout).not.toContain("480px");
		expect(welcomeLayoutWithShortcuts).toContain("padding-top:");
		expect(welcomeLayoutWithShortcuts).toContain("min-height: 0");
		expect(board).toContain("min-height: 0");
		expect(board).toContain("overflow-y: auto");
	});
});
