import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	askBtw: vi.fn(),
	bringBackBtw: vi.fn(),
}));

vi.mock("../api/btw.js", () => ({
	askBtw: mocks.askBtw,
	bringBackBtw: mocks.bringBackBtw,
}));

import { BtwStoreImpl } from "./btw-store.js";

describe("BtwStore", () => {
	let store: BtwStoreImpl;

	beforeEach(() => {
		mocks.askBtw.mockReset();
		mocks.bringBackBtw.mockReset();
		store = new BtwStoreImpl();
	});

	it("asks a question and records the answer", async () => {
		mocks.askBtw.mockResolvedValue("闭包是能记住外层作用域的函数。");
		await store.ask("s1", "什么是闭包？");
		const thread = store.threadFor("s1");
		expect(thread).toHaveLength(1);
		expect(thread[0].status).toBe("done");
		expect(thread[0].answer).toBe("闭包是能记住外层作用域的函数。");
		expect(mocks.askBtw).toHaveBeenCalledWith("s1", "什么是闭包？", []);
		expect(store.panelOpen).toBe(true);
		expect(store.draft).toBe("");
	});

	it("sends prior completed exchanges as the follow-up history", async () => {
		mocks.askBtw.mockResolvedValueOnce("第一答").mockResolvedValueOnce("第二答");
		await store.ask("s1", "问题一");
		await store.ask("s1", "追问");
		expect(mocks.askBtw).toHaveBeenLastCalledWith("s1", "追问", [
			{ question: "问题一", answer: "第一答" },
		]);
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
		expect(mocks.askBtw).toHaveBeenLastCalledWith("s2", "问题二", []);
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
