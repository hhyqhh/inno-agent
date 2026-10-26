import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	windows: [] as any[],
	appHandlers: new Map<string, (...args: any[]) => void>(),
	handlers: new Map<string, (...args: any[]) => unknown>(),
	listeners: new Map<string, (...args: any[]) => void>(),
}));
vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	class Window extends EventEmitter {
		loading = false;
		webContents = Object.assign(new EventEmitter(), {
			send: vi.fn(), isLoading: () => this.loading, setZoomFactor: vi.fn(),
			setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => "dark"),
		});
		constructor(public options: any) { super(); mocks.windows.push(this); }
		loadURL = vi.fn(); show = vi.fn(); focus = vi.fn(); restore = vi.fn();
		isDestroyed = () => false; isMinimized = () => false; isFullScreen = () => true;
		setBackgroundColor = vi.fn(); close = vi.fn(() => { this.emit("closed"); });
	}
	return {
		app: { isPackaged: false, commandLine: { appendSwitch: vi.fn() }, isReady: () => true,
			whenReady: () => new Promise(() => {}), on: (name: string, fn: (...args: any[]) => void) => mocks.appHandlers.set(name, fn) },
		BrowserWindow: Window, Tray: vi.fn(), Menu: {}, shell: {}, dialog: {}, nativeImage: {}, screen: {},
		ipcMain: {
			handle: (name: string, fn: (...args: any[]) => unknown) => mocks.handlers.set(name, fn),
			on: (name: string, fn: (...args: any[]) => void) => mocks.listeners.set(name, fn),
		},
	};
});

const result = { id: "workspace:one", category: "workspace", title: "One", subtitle: "one", snippet: "match", workspaceId: "one" };

describe("desktop search IPC", () => {
	beforeEach(async () => {
		vi.resetModules(); mocks.windows.length = 0;
		mocks.appHandlers.clear(); mocks.handlers.clear(); mocks.listeners.clear();
		await import("./main.js");
		mocks.appHandlers.get("activate")!();
	});
	const openSearch = () => {
		mocks.handlers.get("inno-open-search-window")!({ sender: mocks.windows[0].webContents }, "dark");
		return mocks.windows[1];
	};

	it("allows the native main window to shrink with the compact chat layout", () => {
		expect(mocks.windows[0].options).toMatchObject({ minWidth: 612, minHeight: 600 });
	});

	it("accepts requests only from the main window and reuses the isolated search window", () => {
		expect(mocks.handlers.get("inno-open-search-window")!({ sender: {} })).toBe(false);
		const search = openSearch();
		expect(search.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false });
		expect(new URL(search.loadURL.mock.calls[0][0]).searchParams.get("window")).toBe("search");
		openSearch();
		expect(mocks.windows).toHaveLength(2);
		expect(search.focus).toHaveBeenCalledTimes(2);
	});

	it("rejects foreign senders and malformed results before delivering a valid selection", () => {
		const search = openSearch(); const main = mocks.windows[0];
		const select = mocks.listeners.get("inno-search-open-result")!;
		select({ sender: main.webContents }, result);
		select({ sender: search.webContents }, { ...result, workspaceId: undefined });
		expect(main.webContents.send).not.toHaveBeenCalled();
		select({ sender: search.webContents }, result);
		expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inno-search-navigate", result);
		expect(search.close).toHaveBeenCalledOnce();
	});

	it("delivers a selection once after the main renderer finishes loading", () => {
		const search = openSearch(); const main = mocks.windows[0];
		main.loading = true;
		mocks.listeners.get("inno-search-open-result")!({ sender: search.webContents }, result);
		expect(main.webContents.send).not.toHaveBeenCalled();
		main.loading = false;
		main.webContents.emit("did-finish-load");
		main.webContents.emit("did-finish-load");
		expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inno-search-navigate", result);
	});

	it("handles Ctrl/Cmd K while leaving modified shortcuts alone", async () => {
		const event = { preventDefault: vi.fn() };
		const contents = mocks.windows[0].webContents;
		contents.emit("before-input-event", event, { type: "keyDown", key: "k", control: true, shift: true });
		expect(event.preventDefault).not.toHaveBeenCalled();
		contents.emit("before-input-event", event, { type: "keyDown", key: "K", meta: true });
		await Promise.resolve();
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(mocks.windows).toHaveLength(2);
	});
});

describe("desktop preload bridge", () => {
	function bridge() {
		const ipc = Object.assign(new EventEmitter(), { send: vi.fn(), invoke: vi.fn() });
		let api: any;
		runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf-8"), {
			require: () => ({ ipcRenderer: ipc, webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } } }),
		});
		return { ipc, api };
	}
	it("validates search payloads in both directions and releases navigation subscriptions", () => {
		const { ipc, api } = bridge(); const navigate = vi.fn();
		const unsubscribe = api.onSearchNavigation(navigate);
		ipc.emit("inno-search-navigate", {}, { category: "file" });
		api.openSearchResult({ ...result, category: "unknown" });
		expect(navigate).not.toHaveBeenCalled(); expect(ipc.send).not.toHaveBeenCalled();
		ipc.emit("inno-search-navigate", {}, result);
		api.openSearchResult(result);
		expect(navigate).toHaveBeenCalledExactlyOnceWith(result);
		expect(ipc.send).toHaveBeenCalledExactlyOnceWith("inno-search-open-result", result);
		unsubscribe(); expect(ipc.listenerCount("inno-search-navigate")).toBe(0);
	});
	it("filters fullscreen notifications and removes the listener on cleanup", () => {
		const { ipc, api } = bridge(); const update = vi.fn();
		const unsubscribe = api.onFullScreenChange(update);
		ipc.emit("inno-full-screen-change", {}, "yes");
		ipc.emit("inno-full-screen-change", {}, true);
		expect(update).toHaveBeenCalledExactlyOnceWith(true);
		unsubscribe(); expect(ipc.listenerCount("inno-full-screen-change")).toBe(0);
	});
});
