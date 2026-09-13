import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BTW_INTERRUPTED_ERROR,
	btwStatePath,
	clearSessionBtw,
	readBtwState,
	resetBtwStoreForTests,
	writeBtwState,
} from "./btw-store.js";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "btw-store-"));
	mkdirSync(join(dataDir, "sessions"), { recursive: true });
	resetBtwStoreForTests();
});

afterEach(() => {
	resetBtwStoreForTests();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("btw sidecar store", () => {
	it("returns an empty session and default geometry when no sidecar exists", () => {
		expect(readBtwState(dataDir, "s1")).toEqual({
			session: { nextTabNumber: 1, activeTabId: null, tabs: [] },
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
	});

	it("persists sessions independently while sharing window state", () => {
		const payload = {
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{ id: "tab-1", number: 1, draft: "草稿", scrollTop: 12, exchanges: [] }],
			},
			window: { x: 24, y: 30, width: 520, height: 420 },
			windowInitialized: true,
			minimized: true,
		};
		writeBtwState(dataDir, "s1", payload);

		expect(readBtwState(dataDir, "s1")).toEqual(payload);
		expect(readBtwState(dataDir, "s2").session).toEqual({ nextTabNumber: 1, activeTabId: null, tabs: [] });
		expect(btwStatePath(dataDir)).toBe(join(dataDir, "sessions", "btw.json"));
	});

	it("restores pending exchanges as retryable errors after a store restart", () => {
		writeBtwState(dataDir, "s1", {
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{
					id: "tab-1",
					number: 1,
					draft: "",
					scrollTop: 0,
					exchanges: [{ id: "exchange-1", question: "问题", answer: "", status: "pending" }],
				}],
			},
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
		resetBtwStoreForTests();

		const restored = readBtwState(dataDir, "s1");
		expect(restored.session.tabs[0].exchanges[0]).toMatchObject({
			status: "error",
			error: BTW_INTERRUPTED_ERROR,
		});
	});

	it("falls back to defaults for a malformed sidecar", () => {
		writeFileSync(btwStatePath(dataDir), "not-json");
		expect(readBtwState(dataDir, "s1").session.tabs).toEqual([]);
	});

	it("clears one session without removing another", () => {
		const empty = readBtwState(dataDir, "s1");
		writeBtwState(dataDir, "s1", empty);
		writeBtwState(dataDir, "s2", empty);
		clearSessionBtw(dataDir, "s1");
		expect(readBtwState(dataDir, "s1").session.tabs).toEqual([]);
		expect(readBtwState(dataDir, "s2").session).toEqual(empty.session);
	});
});
