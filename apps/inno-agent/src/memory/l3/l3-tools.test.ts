import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), backfill: vi.fn(), index: vi.fn() }));
vi.mock("./sqlite-store.js", () => ({ openL3Store: mocks.open }));
vi.mock("./indexer.js", () => ({ indexAllSessions: mocks.backfill, indexSession: mocks.index }));
vi.mock("../../utils/path-safety.js", () => ({ resolveContainedPathAsync: async (_root: string, id: string) => `/sessions/${id}` }));
import { L3Memory } from "./l3-tools.js";

describe("L3 concurrent indexing", () => {
	beforeEach(() => { vi.resetAllMocks(); });

	it("shares store initialization and a single backfill across simultaneous searches", async () => {
		const hits = [{ text: "needle" }];
		const store = { searchLexical: vi.fn(() => hits), close: vi.fn() };
		let finishOpen!: (value: typeof store) => void;
		mocks.open.mockReturnValue(new Promise((resolve) => { finishOpen = resolve; }));
		mocks.backfill.mockResolvedValue({ sessions: 1, chunks: 1 });
		const memory = new L3Memory("/l3", "/sessions");
		const searches = [memory.searchLexical("needle"), memory.searchLexical("needle")];
		finishOpen(store);
		expect(await Promise.all(searches)).toEqual([hits, hits]);
		expect(mocks.open).toHaveBeenCalledOnce();
		expect(mocks.backfill).toHaveBeenCalledOnce();
		memory.close();
	});

	it("finishes an older backfill before writing an incremental session update", async () => {
		mocks.open.mockResolvedValue({ close: vi.fn() });
		let finishBackfill!: (value: { sessions: number; chunks: number }) => void;
		mocks.backfill.mockReturnValue(new Promise((resolve) => { finishBackfill = resolve; }));
		mocks.index.mockResolvedValue(1);
		const memory = new L3Memory("/l3", "/sessions");
		const backfill = memory.backfill();
		await vi.waitFor(() => expect(mocks.backfill).toHaveBeenCalled());
		const update = memory.indexById("latest.jsonl");
		await Promise.resolve();
		expect(mocks.index).not.toHaveBeenCalled();
		finishBackfill({ sessions: 1, chunks: 1 });
		await Promise.all([backfill, update]);
		expect(mocks.index).toHaveBeenCalledOnce();
		memory.close();
	});
});
