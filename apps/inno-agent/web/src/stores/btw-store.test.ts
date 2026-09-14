import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	askBtw: vi.fn(),
	bringBackBtw: vi.fn(),
	getBtwState: vi.fn(),
	saveBtwState: vi.fn(),
}));

vi.mock("../api/btw.js", () => ({
	askBtw: mocks.askBtw,
	bringBackBtw: mocks.bringBackBtw,
	getBtwState: mocks.getBtwState,
	saveBtwState: mocks.saveBtwState,
}));

import { BtwStoreImpl } from "./btw-store.js";

describe("BtwStore", () => {
	let store: BtwStoreImpl;

	beforeEach(() => {
		mocks.askBtw.mockReset();
		mocks.bringBackBtw.mockReset();
		mocks.getBtwState.mockReset().mockResolvedValue({
			session: { nextTabNumber: 1, activeTabId: null, tabs: [] },
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
		mocks.saveBtwState.mockReset().mockResolvedValue(undefined);
		store = new BtwStoreImpl();
	});

	it("asks a question and records the answer", async () => {
		mocks.askBtw.mockResolvedValue("闭包是能记住外层作用域的函数。");
		await store.ask("s1", "什么是闭包？");
		const thread = store.threadFor("s1");
		expect(thread).toHaveLength(1);
		expect(thread[0].status).toBe("done");
		expect(thread[0].answer).toBe("闭包是能记住外层作用域的函数。");
		expect(mocks.askBtw).toHaveBeenCalledWith("s1", "什么是闭包？", [], expect.any(AbortSignal));
		expect(store.panelOpen).toBe(true);
		expect(store.draft).toBe("");
	});

	it("sends prior completed exchanges as the follow-up history", async () => {
		mocks.askBtw.mockResolvedValueOnce("第一答").mockResolvedValueOnce("第二答");
		await store.ask("s1", "问题一");
		await store.ask("s1", "追问");
		expect(mocks.askBtw).toHaveBeenLastCalledWith("s1", "追问", [
			{ question: "问题一", answer: "第一答" },
		], expect.any(AbortSignal));
		expect(store.threadFor("s1").map((e) => e.answer)).toEqual(["第一答", "第二答"]);
	});

	it("marks failures as error and supports retry", async () => {
		mocks.askBtw.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("好了");
		await store.ask("s1", "问题");
		expect(store.threadFor("s1")[0].status).toBe("error");
		expect(store.threadFor("s1")[0].error).toBe("boom");

		await store.retry("s1", store.threadFor("s1")[0].id);
		expect(store.threadFor("s1")[0].status).toBe("done");
		expect(store.threadFor("s1")[0].answer).toBe("好了");
	});

	it("keeps threads bucketed per session", async () => {
		mocks.askBtw.mockResolvedValue("答");
		await store.ask("s1", "问题一");
		await store.ask("s2", "问题二");
		expect(store.threadFor("s1")).toHaveLength(1);
		expect(store.threadFor("s2")).toHaveLength(1);
		expect(store.threadFor("s3")).toEqual([]);
		// History for s2 must not leak s1's exchange.
		expect(mocks.askBtw).toHaveBeenLastCalledWith("s2", "问题二", [], expect.any(AbortSignal));
	});

	it("creates independent numbered tabs without reusing closed numbers", () => {
		const first = store.createTab("s1")!;
		store.createTab("s1");
		expect(store.tabsFor("s1").map((tab) => tab.number)).toEqual([1, 2]);

		store.closeTab("s1", first);
		const third = store.createTab("s1")!;
		expect(third).not.toBe(first);
		expect(store.tabsFor("s1").map((tab) => tab.number)).toEqual([2, 3]);
	});

	it("keeps drafts and exchanges isolated per tab", async () => {
		mocks.askBtw.mockResolvedValue("答");
		const first = store.createTab("s1")!;
		const second = store.createTab("s1")!;
		store.setDraft("s1", first, "草稿一");
		store.setDraft("s1", second, "草稿二");
		await store.ask("s1", first, "问题一");

		expect(store.tabFor("s1", first)?.draft).toBe("");
		expect(store.tabFor("s1", second)?.draft).toBe("草稿二");
		expect(store.tabFor("s1", first)?.exchanges).toHaveLength(1);
		expect(store.tabFor("s1", second)?.exchanges).toHaveLength(0);
	});

	it("allows requests in different tabs to run in parallel", async () => {
		const resolvers = new Map<string, (answer: string) => void>();
		mocks.askBtw.mockImplementation((_sessionId: string, question: string) => new Promise<string>((resolve) => {
			resolvers.set(question, resolve);
		}));
		const first = store.createTab("s1")!;
		const second = store.createTab("s1")!;
		const firstRequest = store.ask("s1", first, "问题一");
		const secondRequest = store.ask("s1", second, "问题二");
		await Promise.resolve();
		expect(store.tabFor("s1", first)?.exchanges[0].status).toBe("pending");
		expect(store.tabFor("s1", second)?.exchanges[0].status).toBe("pending");
		resolvers.get("问题二")?.("答二");
		resolvers.get("问题一")?.("答一");
		await Promise.all([firstRequest, secondRequest]);
		expect(store.tabFor("s1", first)?.exchanges[0].answer).toBe("答一");
		expect(store.tabFor("s1", second)?.exchanges[0].answer).toBe("答二");
	});

	it("minimizes and restores the whole window without deleting tabs", async () => {
		await store.openOrRestore("s1");
		expect(store.isVisible).toBe(true);
		store.minimizePanel();
		expect(store.isVisible).toBe(false);
		expect(store.tabsFor("s1")).toHaveLength(1);
		await store.openOrRestore("s1");
		expect(store.isVisible).toBe(true);
	});

	it("keeps the session unloaded and retryable when the first fetch fails", async () => {
		mocks.getBtwState.mockRejectedValueOnce(new Error("network down"));
		await store.hydrateSession("s1");
		expect(store.hydrationErrorFor("s1")).toBe("network down");
		// No fabricated empty session, and the failure does not count as loaded.
		expect(store.tabsFor("s1")).toEqual([]);

		mocks.getBtwState.mockResolvedValueOnce({
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{ id: "tab-1", number: 1, draft: "旧草稿", scrollTop: 0, exchanges: [] }],
			},
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
		await store.hydrateSession("s1");
		expect(store.hydrationErrorFor("s1")).toBeNull();
		expect(store.tabFor("s1", "tab-1")?.draft).toBe("旧草稿");
	});

	it("opens a recovery card instead of a fresh tab when hydration failed, and never persists", async () => {
		vi.useFakeTimers();
		try {
			mocks.getBtwState.mockRejectedValue(new Error("network down"));
			await store.openOrRestore("s1");
			// The panel opens to show the recovery state, but no tab is created.
			expect(store.panelOpen).toBe(true);
			expect(store.minimized).toBe(false);
			expect(store.hydrationErrorFor("s1")).toBe("network down");
			expect(store.tabsFor("s1")).toEqual([]);

			// Any stray local mutation must not reach the server: persistence is
			// blocked until a retry successfully loads the real history.
			store.createTab("s1");
			store.flushPersistence("s1");
			await vi.advanceTimersByTimeAsync(500);
			expect(mocks.saveBtwState).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("turns persisted pending exchanges into retryable errors on hydration", async () => {
		mocks.getBtwState.mockResolvedValueOnce({
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{
					id: "tab-1",
					number: 1,
					draft: "",
					scrollTop: 12,
					exchanges: [{ id: "exchange-1", question: "问题", answer: "", status: "pending" }],
				}],
			},
			window: { x: 10, y: 20, width: 500, height: 400 },
			windowInitialized: true,
			minimized: false,
		});
		await store.hydrateSession("s1");
		expect(store.tabFor("s1", "tab-1")?.exchanges[0]).toMatchObject({
			status: "error",
			error: "回答在应用关闭时中断，请重试",
		});
		expect(store.windowGeometry).toEqual({ x: 10, y: 20, width: 500, height: 400 });
	});

	it("aborts and removes a pending tab without allowing a stale answer back", async () => {
		let requestSignal: AbortSignal | undefined;
		mocks.askBtw.mockImplementation((_sessionId: string, _question: string, _thread: unknown[], signal: AbortSignal) => {
			requestSignal = signal;
			return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		});
		const tabId = store.createTab("s1")!;
		const request = store.ask("s1", tabId, "问题");
		await Promise.resolve();
		store.closeTab("s1", tabId);
		await request;
		expect(requestSignal?.aborted).toBe(true);
		expect(store.tabsFor("s1")).toEqual([]);
		expect(store.panelOpen).toBe(false);
	});

	it("brings a completed exchange back exactly once", async () => {
		mocks.askBtw.mockResolvedValue("答");
		mocks.bringBackBtw.mockResolvedValue(undefined);
		await store.ask("s1", "问题");
		const id = store.threadFor("s1")[0].id;
		await store.bringBack("s1", id);
		expect(mocks.bringBackBtw).toHaveBeenCalledWith("s1", "问题", "答");
		expect(store.threadFor("s1")[0].broughtBack).toBe(true);
		// A second call is a no-op.
		await store.bringBack("s1", id);
		expect(mocks.bringBackBtw).toHaveBeenCalledTimes(1);
	});

	it("refuses to bring back a pending or failed exchange", async () => {
		mocks.askBtw.mockRejectedValue(new Error("boom"));
		await store.ask("s1", "问题");
		await store.bringBack("s1", store.threadFor("s1")[0].id);
		expect(mocks.bringBackBtw).not.toHaveBeenCalled();
	});

	it("ignores empty questions and missing sessions", async () => {
		await store.ask("", "问题");
		await store.ask("s1", "   ");
		expect(mocks.askBtw).not.toHaveBeenCalled();
	});
});
