import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, type AppPage } from "../stores/app-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { SessionSidebar } from "./SessionSidebar.js";
import { useStoreSnapshot } from "./hooks.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { SIDEBAR_PREVIEW_CLOSE_DELAY } from "./use-sidebar-preview.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
vi.mock("../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("./WorkspaceBrowser.js", () => ({
	WorkspaceBrowser: ({ onPreviewFile, variant }: { onPreviewFile: (width: number) => void; variant: string }) => (
		<article aria-label="Sidebar files" data-variant={variant}>
			<button onClick={() => onPreviewFile(560)}>Open file</button>
		</article>
	),
}));

function Layout({ onPreviewFile = vi.fn() }: { onPreviewFile?: (width: number) => void }) {
	const collapsed = useStoreSnapshot(appStore, () => appStore.sidebarCollapsed);
	return (
		<InnoDndProvider>
			<SessionSidebar collapsed={collapsed} isDesktopWindow onOpenSearch={vi.fn()} onPreviewFile={onPreviewFile} chatContent={<div>Chat</div>} />
		</InnoDndProvider>
	);
}

function setPage(page: AppPage) {
	act(() => appStore.setPage(page, "none"));
}

function pointer(target: HTMLElement | Window, type: string, clientX: number) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 100 });
	Object.defineProperty(event, "pointerId", { value: 1 });
	fireEvent(target, event);
}

describe("Desktop sidebar message/file navigation", () => {
	beforeEach(() => {
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		localStorage.clear();
		appStore.page = "chat";
		appStore.sidebarCollapsed = false;
		appStore.sidebarWidth = 246;
		appStore.workspaceMode = "collapsed";
		appStore.workspaceWidth = 520;
		vi.stubGlobal("innerWidth", 1600);
		sessionsStore.sessions = [];
		sessionsStore.isLoading = false;
		sessionsStore.currentSessionId = null;
		workspacesStore.workspaces = [];
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("switches content inside the same pinned panel and collapses the segment on other pages", async () => {
		const { container } = render(<Layout />);
		const panel = container.querySelector("#session-sidebar-panel")!;
		const messages = screen.getByRole("radio", { name: "nav.chat" });
		fireEvent.click(screen.getByRole("radio", { name: "nav.files" }));
		expect((await screen.findByRole("article", { name: "Sidebar files" })).getAttribute("data-variant")).toBe("sidebar");
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
		expect(panel.classList.contains("is-pinned")).toBe(true);
		fireEvent.pointerEnter(messages);
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
		fireEvent.click(messages);
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		expect(container.querySelector("#session-sidebar-panel")).toBe(panel);
		expect(screen.queryByRole("article", { name: "Sidebar files" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "nav.notebook" }));
		expect(appStore.page).toBe("notebook");
		expect(screen.queryByRole("radio", { name: "nav.files" })).toBeNull();
		expect(panel.getAttribute("aria-hidden")).toBe("true");
	});

	it("previews both views on another page and keeps the existing delayed close across the segment and panel", async () => {
		appStore.page = "skills";
		const { container } = render(<Layout />);
		const panel = container.querySelector("#session-sidebar-panel")!;
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.chat" }));
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		expect(panel.classList.contains("is-preview")).toBe(true);
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.files" }));
		await screen.findByRole("article", { name: "Sidebar files" });
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
		expect(appStore.page).toBe("skills");

		vi.useFakeTimers();
		fireEvent.pointerLeave(container.querySelector(".inno-desktop-sidebar-segment")!);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY - 1));
		expect(panel.getAttribute("aria-hidden")).toBe("false");
		fireEvent.pointerEnter(panel);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(panel.getAttribute("aria-hidden")).toBe("false");
		fireEvent.pointerLeave(panel);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(panel.getAttribute("aria-hidden")).toBe("true");
		expect(screen.queryByRole("radio", { name: "nav.files" })).toBeNull();
		expect(appStore.page).toBe("skills");
	});

	it("does not commit a hovered view and retains Escape dismissal", async () => {
		const { container } = render(<Layout />);
		fireEvent.click(screen.getByRole("radio", { name: "nav.files" }));
		await screen.findByRole("article", { name: "Sidebar files" });
		setPage("jobs");
		const messages = screen.getByRole("radio", { name: "nav.chat" });
		fireEvent.pointerEnter(messages);
		const panel = container.querySelector("#session-sidebar-panel")!;
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		fireEvent.keyDown(messages, { key: "Escape" });
		expect(panel.getAttribute("aria-hidden")).toBe("true");
		setPage("chat");
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
	});

	it("keeps the closing file icon mounted for its exit animation and reuses it on re-entry", async () => {
		appStore.page = "notebook";
		const { container } = render(<Layout />);
		const messages = screen.getByRole("radio", { name: "nav.chat" });
		fireEvent.pointerEnter(messages);
		const files = screen.getByRole("radio", { name: "nav.files" }) as HTMLButtonElement;
		fireEvent.pointerEnter(files);
		await screen.findByRole("article", { name: "Sidebar files" });
		vi.useFakeTimers();
		fireEvent.pointerLeave(container.querySelector(".inno-desktop-sidebar-segment")!);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(screen.queryByRole("radio", { name: "nav.files" })).toBeNull();
		expect(files.isConnected).toBe(true);
		expect(files.getAttribute("aria-hidden")).toBe("true");
		expect(files.disabled).toBe(true);
		fireEvent.click(files);
		expect(appStore.page).toBe("notebook");
		fireEvent.pointerEnter(messages);
		expect(screen.getByRole("radio", { name: "nav.files" })).toBe(files);
		expect(files.disabled).toBe(false);
	});

	it.each(["messages", "files"] as const)("previews both panels after collapsing chat and restores the committed %s view", async (committedView) => {
		const { container } = render(<Layout />);
		const panel = container.querySelector("#session-sidebar-panel")!;
		const messages = screen.getByRole("radio", { name: "nav.chat" });
		const files = screen.getByRole("radio", { name: "nav.files" });
		if (committedView === "files") {
			fireEvent.click(files);
			await screen.findByRole("article", { name: "Sidebar files" });
		}
		act(() => appStore.setSidebarCollapsed(true));

		fireEvent.pointerEnter(messages);
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		fireEvent.pointerEnter(files);
		await screen.findByRole("article", { name: "Sidebar files" });
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
		expect(panel.classList.contains("is-preview")).toBe(true);
		fireEvent.pointerEnter(messages);
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		fireEvent.keyDown(messages, { key: "Escape" });
		expect(panel.getAttribute("aria-hidden")).toBe("true");

		fireEvent.pointerEnter(files);
		expect(panel.getAttribute("aria-label")).toBe("nav.files");
		vi.useFakeTimers();
		fireEvent.pointerLeave(container.querySelector(".inno-desktop-sidebar-segment")!);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY - 1));
		expect(panel.getAttribute("aria-hidden")).toBe("false");
		fireEvent.pointerEnter(panel);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(panel.getAttribute("aria-hidden")).toBe("false");
		fireEvent.pointerLeave(panel);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(panel.getAttribute("aria-hidden")).toBe("true");
		expect(appStore.page).toBe("chat");
		expect(appStore.sidebarCollapsed).toBe(true);

		act(() => appStore.setSidebarCollapsed(false));
		expect(panel.getAttribute("aria-label")).toBe(committedView === "files" ? "nav.files" : "nav.chat");
		expect(panel.classList.contains("is-pinned")).toBe(true);
		expect(container.querySelector("#session-sidebar-panel")).toBe(panel);
	});

	it("shares the resized width between messages, files and both hover preview entry points", async () => {
		const { container } = render(<Layout />);
		let handle = screen.getByRole("separator", { name: "sidebar.resize" });
		pointer(handle, "pointerdown", 300);
		pointer(window, "pointermove", 380);
		pointer(window, "pointerup", 380);
		expect(appStore.sidebarWidth).toBe(326);
		fireEvent.click(screen.getByRole("radio", { name: "nav.files" }));
		await screen.findByRole("article", { name: "Sidebar files" });
		expect(screen.getByRole("separator", { name: "sidebar.resize" }).getAttribute("aria-valuenow")).toBe("326");
		act(() => appStore.setSidebarCollapsed(true));
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.chat" }));
		handle = screen.getByRole("separator", { name: "sidebar.resize" });
		expect(handle.getAttribute("aria-valuenow")).toBe("326");
		pointer(handle, "pointerdown", 380);
		pointer(window, "pointermove", 420);
		pointer(window, "pointerup", 420);
		expect(appStore.sidebarWidth).toBe(366);
		expect(appStore.sidebarCollapsed).toBe(true);
		expect(appStore.page).toBe("chat");
		setPage("notebook");
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.chat" }));
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.files" }));
		expect(screen.getByRole("separator", { name: "sidebar.resize" }).getAttribute("aria-valuenow")).toBe("366");
		setPage("chat");
		act(() => appStore.setSidebarCollapsed(false));
		expect(screen.getByRole("separator", { name: "sidebar.resize" }).getAttribute("aria-valuenow")).toBe("366");
		expect(container.querySelector("#session-sidebar-panel")?.classList.contains("is-pinned")).toBe(true);
	});

	it("keeps a preview open throughout resizing and resumes delayed closing after release", () => {
		appStore.page = "notebook";
		const { container } = render(<Layout />);
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.chat" }));
		const panel = container.querySelector("#session-sidebar-panel") as HTMLElement;
		const handle = screen.getByRole("separator", { name: "sidebar.resize" });
		pointer(handle, "pointerdown", 300);
		vi.useFakeTimers();
		fireEvent.pointerLeave(panel);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY * 2));
		expect(panel.getAttribute("aria-hidden")).toBe("false");
		pointer(window, "pointermove", 380);
		pointer(window, "pointerup", 380);
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(panel.getAttribute("aria-hidden")).toBe("true");
		expect(appStore.page).toBe("notebook");
		expect(appStore.sidebarCollapsed).toBe(false);
	});

	it("supports vertical keyboard selection", async () => {
		render(<Layout />);
		const messages = screen.getByRole("radio", { name: "nav.chat" });
		fireEvent.keyDown(messages, { key: "ArrowDown" });
		await screen.findByRole("article", { name: "Sidebar files" });
		const files = screen.getByRole("radio", { name: "nav.files" });
		expect(document.activeElement).toBe(files);
		expect(files.getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(files, { key: "Home" });
		expect(document.activeElement).toBe(messages);
		expect(messages.getAttribute("aria-checked")).toBe("true");
	});

	it("commits an explicit panel selection while the chat sidebar remains collapsed", async () => {
		appStore.sidebarCollapsed = true;
		const { container } = render(<Layout />);
		const panel = container.querySelector("#session-sidebar-panel")!;
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.files" }));
		await screen.findByRole("article", { name: "Sidebar files" });
		fireEvent.click(screen.getByRole("radio", { name: "nav.chat" }));
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
		expect(appStore.sidebarCollapsed).toBe(true);
		act(() => appStore.setSidebarCollapsed(false));
		expect(panel.getAttribute("aria-label")).toBe("nav.chat");
	});

	it("opens a hovered file through the existing preview action without forcing the sidebar open", async () => {
		appStore.page = "learner";
		appStore.sidebarCollapsed = true;
		const onPreviewFile = vi.fn();
		render(<Layout onPreviewFile={onPreviewFile} />);
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.chat" }));
		fireEvent.pointerEnter(screen.getByRole("radio", { name: "nav.files" }));
		fireEvent.click(await screen.findByRole("button", { name: "Open file" }));
		expect(appStore.page).toBe("chat");
		expect(appStore.sidebarCollapsed).toBe(true);
		expect(onPreviewFile).toHaveBeenCalledWith(560);
	});
});
