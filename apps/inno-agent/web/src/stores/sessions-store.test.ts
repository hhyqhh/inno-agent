import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	getSession: vi.fn(),
	createSession: vi.fn(),
	activateSession: vi.fn(),
	getChatStatus: vi.fn(),
	chatDetach: vi.fn(),
	chatClear: vi.fn(),
	chatLoadHistory: vi.fn(),
	chatSetLoadingHistory: vi.fn(),
	chatShowError: vi.fn(),
}));

vi.mock("../api/sessions.js", () => ({
	listSessions: mocks.listSessions,
	getSession: mocks.getSession,
	createSession: mocks.createSession,
	activateSession: mocks.activateSession,
	archiveSession: vi.fn(),
	deleteSession: vi.fn(),
	generateSessionName: vi.fn(),
	unarchiveSession: vi.fn(),
	updateSessionName: vi.fn(),
}));
vi.mock("../api/chat.js", () => ({ getChatStatus: mocks.getChatStatus }));
vi.mock("../api/workspaces.js", () => ({ getSessionWorkspace: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }) }));
vi.mock("./chat-store.js", () => ({
	chatStore: {
		messages: [],
		isLoadingHistory: false,
		isSending: false,
		detach: mocks.chatDetach,
		clear: mocks.chatClear,
		loadHistory: mocks.chatLoadHistory,
		setLoadingHistory: mocks.chatSetLoadingHistory,
		showError: mocks.chatShowError,
		resumeStream: vi.fn(),
	},
}));
vi.mock("./workspace-store.js", () => ({ workspaceStore: { setActiveWorkspace: vi.fn() } }));
vi.mock("./workspaces-store.js", () => ({ workspacesStore: { load: vi.fn() } }));
vi.mock("./terminal-store.js", () => ({ terminalStore: { disconnect: vi.fn() } }));

import { SessionsStoreImpl } from "./sessions-store.js";

function session(id: string) {
	return {
		id,
		name: id,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
		messageCount: 0,
		preview: "",
		channels: [],
		messages: [],
		sessionRevision: "0:0",
	};
}

describe("SessionsStore navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		let href = "http://localhost/";
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: { get href() { return href; }, set href(value: string) { href = value; } },
				history: {
					pushState: vi.fn((_state, _title, url: URL) => { href = url.toString(); }),
					replaceState: vi.fn((_state, _title, url: URL) => { href = url.toString(); }),
				},
			},
		});
		mocks.listSessions.mockResolvedValue([]);
		mocks.activateSession.mockResolvedValue({ active: true });
		mocks.getChatStatus.mockResolvedValue({ found: false });
	});

	it("writes the created session to the URL before the first send can continue", async () => {
		mocks.createSession.mockResolvedValue({ id: "created.jsonl", active: true, workspaceId: "workspace-1" });
		const store = new SessionsStoreImpl();
		await store.createSessionWith({ workspaceId: "workspace-1" });
		expect(store.currentSessionId).toBe("created.jsonl");
		expect(new URL(window.location.href).searchParams.get("session")).toBe("created.jsonl");
		expect(window.history.replaceState).toHaveBeenCalled();
	});

	it("returns to the welcome page on a popstate URL without a session", () => {
		const store = new SessionsStoreImpl();
		store.currentSessionId = "a.jsonl";
		store.showWelcomeFromHistory();
		expect(store.currentSessionId).toBeNull();
		expect(store.pendingNewSession).toBe(true);
		expect(mocks.chatDetach).toHaveBeenCalled();
		expect(window.history.replaceState).not.toHaveBeenCalled();
	});

	it("does not let a stale open request overwrite a newer session", async () => {
		let resolveA!: (value: ReturnType<typeof session>) => void;
		const a = new Promise<ReturnType<typeof session>>((resolve) => { resolveA = resolve; });
		mocks.getSession.mockImplementation((id: string) => id === "a.jsonl" ? a : Promise.resolve(session("b.jsonl")));
		const store = new SessionsStoreImpl();
		const openingA = store.openSession("a.jsonl", { historyMode: "none" });
		await Promise.resolve();
		await store.openSession("b.jsonl", { historyMode: "none" });
		resolveA(session("a.jsonl"));
		await openingA;
		expect(store.currentSessionId).toBe("b.jsonl");
		expect(mocks.chatLoadHistory).toHaveBeenLastCalledWith([], "b.jsonl");
	});
});
