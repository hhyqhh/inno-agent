import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import type { SearchResult } from "../../../src/shared/search.js";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../api/search.js", () => ({ searchInnoAgent: mocks.search }));
vi.mock("react-i18next", () => {
	const t = (key: string) => key;
	return { useTranslation: () => ({ t }) };
});
import { SearchPanel } from "./SearchPanel.js";

const result = (id: string): SearchResult => ({ id, category: "workspace", title: id, subtitle: "workspace", snippet: "matched", workspaceId: id });

describe("SearchPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.search.mockReset().mockResolvedValue({ results: [result("first"), result("second")], total: 2, counts: { workspace: 2 } });
		HTMLElement.prototype.scrollIntoView = vi.fn();
		Object.defineProperties(HTMLDialogElement.prototype, {
			showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
			close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
		});
	});
	afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
	const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(180); }); };
	const type = (value: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value } });

	it("debounces typing, trims the query and aborts the previous request on change/unmount", async () => {
		const { unmount } = render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
		type("n");
		type(" needle ");
		expect(mocks.search).not.toHaveBeenCalled();
		await flush();
		expect(mocks.search).toHaveBeenCalledOnce();
		expect(mocks.search.mock.calls[0].slice(0, 2)).toEqual(["needle", "all"]);
		const signal = mocks.search.mock.calls[0][2] as AbortSignal;
		type("new query");
		expect(signal.aborted).toBe(true);
		unmount();
		await flush();
		expect(mocks.search).toHaveBeenCalledOnce();
	});

	it("rejects an older response that resolves after the newer query", async () => {
		let finishOld!: (value: { results: SearchResult[] }) => void;
		mocks.search.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
			.mockResolvedValueOnce({ results: [result("new result")] });
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		type("old"); await flush();
		type("new"); await flush();
		await act(async () => { finishOld({ results: [result("stale result")] }); });
		expect(screen.getByRole("option").textContent).toContain("new result");
		expect(screen.queryByText("stale result")).toBeNull();
	});

	it("opens the keyboard selection without letting hover change it or IME Enter activate it", async () => {
		const navigate = vi.fn();
		render(<SearchPanel onClose={vi.fn()} onNavigate={navigate} />);
		type("needle"); await flush();
		const input = screen.getByRole("combobox");
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.pointerMove(screen.getAllByRole("option")[0]);
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Enter" });
		expect(navigate).toHaveBeenCalledExactlyOnceWith(result("second"));
	});

	it("keeps Enter on Close, tabs and results owned by their focused controls", async () => {
		const close = vi.fn(); const navigate = vi.fn();
		render(<SearchPanel onClose={close} onNavigate={navigate} />);
		type("needle"); await flush();
		const closeButton = screen.getByRole("button", { name: "common.close" });
		fireEvent.keyDown(closeButton, { key: "Enter" });
		fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "Enter" });
		const option = screen.getAllByRole("option")[1];
		fireEvent.keyDown(option, { key: "Enter" });
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.click(option);
		expect(navigate).toHaveBeenCalledExactlyOnceWith(result("second"));
		fireEvent.click(closeButton);
		expect(close).toHaveBeenCalledOnce();
	});

	it("uses linked tabs with arrow/Home/End navigation while keeping text-caret arrows intact", async () => {
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		const tabs = screen.getAllByRole("tab");
		fireEvent.keyDown(tabs[0], { key: "End" });
		expect(document.activeElement).toBe(tabs[4]);
		expect(tabs[4].getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[4].id);
		fireEvent.keyDown(tabs[4], { key: "Home" });
		expect(document.activeElement).toBe(tabs[0]);
		type("needle");
		const input = screen.getByRole("combobox") as HTMLInputElement;
		input.setSelectionRange(1, 1);
		fireEvent.keyDown(input, { key: "ArrowRight" });
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(input, { key: "ArrowRight", ctrlKey: true });
		expect(tabs[1].getAttribute("aria-selected")).toBe("true");
		await flush();
		expect(mocks.search.mock.calls.at(-1)?.[1]).toBe("conversation");
	});

	it("reports failures and clears them with the query", async () => {
		mocks.search.mockRejectedValueOnce(new Error("Search unavailable"));
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		type("needle"); await flush();
		expect(screen.getByRole("alert").textContent).toBe("Search unavailable");
		type("");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryAllByRole("option")).toHaveLength(0);
	});

	it("clears a pending search and returns focus without restoring its late results", async () => {
		let finishSearch!: (value: { results: SearchResult[]; total: number; counts: {} }) => void;
		mocks.search.mockReturnValueOnce(new Promise((resolve) => { finishSearch = resolve; }));
		render(<SearchPanel standalone macTitlebarInset onClose={vi.fn()} onNavigate={vi.fn()} />);
		expect(screen.queryByRole("button", { name: "globalSearch.clear" })).toBeNull();
		type("你好"); await flush();
		const signal = mocks.search.mock.calls[0][2] as AbortSignal;
		fireEvent.click(screen.getByRole("button", { name: "globalSearch.clear" }));
		expect(signal.aborted).toBe(true);
		expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
		await act(async () => { finishSearch({ results: [result("late")], total: 1, counts: {} }); });
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("globalSearch.emptyPrompt")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "globalSearch.clear" })).toBeNull();
	});

	it("opens all matches in a category and appends later pages without losing selection", async () => {
		mocks.search.mockResolvedValueOnce({ results: [result("first"), result("second")], total: 3, counts: { workspace: 3 } })
			.mockResolvedValueOnce({ results: [result("first"), result("second")], total: 3, counts: { workspace: 3 }, nextOffset: 2 })
			.mockResolvedValueOnce({ results: [result("third")], total: 3, counts: { workspace: 3 } });
		const navigate = vi.fn();
		render(<SearchPanel onClose={vi.fn()} onNavigate={navigate} />);
		type("needle"); await flush();
		fireEvent.click(screen.getByRole("button", { name: "globalSearch.viewAll" }));
		await flush();
		expect(mocks.search.mock.calls.at(-1)?.[1]).toBe("workspace");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "globalSearch.loadMore" })); });
		expect(mocks.search.mock.calls.at(-1)?.[3]).toBe(2);
		expect(screen.getAllByRole("option")).toHaveLength(3);
		expect(screen.queryByRole("button", { name: "globalSearch.loadMore" })).toBeNull();
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigate).toHaveBeenCalledExactlyOnceWith(result("second"));
	});

	it("keeps loaded results after a page failure and lets the user retry", async () => {
		mocks.search.mockResolvedValueOnce({ results: [result("first")], total: 2, counts: { workspace: 2 }, nextOffset: 1 })
			.mockRejectedValueOnce(new Error("Page unavailable"))
			.mockResolvedValueOnce({ results: [result("second")], total: 2, counts: { workspace: 2 } });
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		type("needle"); await flush();
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "globalSearch.loadMore" })); });
		expect(screen.getByRole("alert").textContent).toBe("Page unavailable");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "globalSearch.loadMore" })); });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getAllByRole("option")).toHaveLength(2);
	});

	it("does not append an older category page after the query changes", async () => {
		let finishPage!: (value: { results: SearchResult[]; total: number; counts: {} }) => void;
		mocks.search.mockResolvedValueOnce({ results: [result("first")], total: 2, counts: { workspace: 2 }, nextOffset: 1 })
			.mockReturnValueOnce(new Promise((resolve) => { finishPage = resolve; }))
			.mockResolvedValueOnce({ results: [result("new")], total: 1, counts: { workspace: 1 } });
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		type("old"); await flush();
		fireEvent.click(screen.getByRole("button", { name: "globalSearch.loadMore" }));
		const signal = mocks.search.mock.calls.at(-1)?.[2] as AbortSignal;
		type("new"); await flush();
		expect(signal.aborted).toBe(true);
		await act(async () => { finishPage({ results: [result("stale page")], total: 2, counts: {} }); });
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.queryByText("stale page")).toBeNull();
	});

	it("shows a file path once and keeps conversation time beside the title", async () => {
		mocks.search.mockResolvedValueOnce({ results: [
			{ ...result("file"), category: "file", subtitle: "workspace · notes/hello.md", snippet: "notes/hello.md" },
			{ ...result("conversation"), category: "conversation", subtitle: "2026-10-01T12:00:00.000Z", snippet: "你好" },
		], total: 2, counts: { file: 1, conversation: 1 } });
		render(<SearchPanel onClose={vi.fn()} onNavigate={vi.fn()} />);
		type("hello"); await flush();
		expect(screen.queryByText("notes/hello.md")).toBeNull();
		expect(screen.getByText("workspace · notes/hello.md")).toBeTruthy();
		expect(document.querySelector("time")?.dateTime).toBe("2026-10-01T12:00:00.000Z");
		expect(document.querySelector("time")?.parentElement?.textContent).toContain("conversation");
	});

	it("closes the browser modal on Escape, native cancel and backdrop click", () => {
		const close = vi.fn();
		render(<SearchPanel onClose={close} onNavigate={vi.fn()} />);
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
		expect(close).toHaveBeenCalledTimes(1);
		fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
		expect(close).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("dialog"));
		expect(close).toHaveBeenCalledTimes(3);
	});
});
