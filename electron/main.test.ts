import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { nativeTheme } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	systemDark: true,
	cursor: { x: 100, y: 100 },
	openPath: vi.fn(async () => ""),
	listApps: vi.fn(),
	fileIcon: vi.fn(),
	openWith: vi.fn(),
	reveal: vi.fn(),
	windows: [] as any[],
	appHandlers: new Map<string, (...args: any[]) => void>(),
	handlers: new Map<string, (...args: any[]) => unknown>(),
	listeners: new Map<string, (...args: any[]) => void>(),
}));
vi.mock("./open-with.js", () => ({ listFileApplications: mocks.listApps, openFileInApplication: mocks.openWith }));
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
		isDestroyed = () => false; isMinimized = () => false;
		isFullScreen = vi.fn(() => false); isMaximized = vi.fn(() => false); isResizable = vi.fn(() => true);
		bounds = { x: 100, y: 80, width: 1200, height: 800 };
		getBounds = () => this.bounds;
		setBounds = vi.fn((bounds) => { this.bounds = bounds; });
		getMinimumSize = () => [612, 600]; getMaximumSize = () => [0, 0];
		setBackgroundColor = vi.fn(); close = vi.fn(() => { this.emit("closed"); });
	}
	return {
		app: { getFileIcon: mocks.fileIcon, isPackaged: false, commandLine: { appendSwitch: vi.fn() }, isReady: () => true,
			whenReady: () => new Promise(() => {}), on: (name: string, fn: (...args: any[]) => void) => mocks.appHandlers.set(name, fn) },
		nativeTheme: Object.defineProperty(Object.assign(new EventEmitter(), { themeSource: "system" }), "shouldUseDarkColors", { get() { return this.themeSource === "dark" || (this.themeSource === "system" && mocks.systemDark); } }),
		BrowserWindow: Window, Tray: vi.fn(), Menu: {}, shell: { openPath: mocks.openPath, showItemInFolder: mocks.reveal }, dialog: {}, nativeImage: {}, screen: { getCursorScreenPoint: () => ({ ...mocks.cursor }) },
		ipcMain: {
			handle: (name: string, fn: (...args: any[]) => unknown) => mocks.handlers.set(name, fn),
			on: (name: string, fn: (...args: any[]) => void) => mocks.listeners.set(name, fn),
		},
	};
});

afterEach(() => { vi.unstubAllGlobals(); });

const result = { id: "workspace:one", category: "workspace", title: "One", subtitle: "one", snippet: "match", workspaceId: "one" };

describe("desktop search IPC", () => {
	beforeEach(async () => {
		vi.resetModules(); mocks.windows.length = 0;
		mocks.systemDark = true; mocks.cursor = { x: 100, y: 100 }; nativeTheme.removeAllListeners();
		mocks.openPath.mockReset().mockResolvedValue("");
		mocks.listApps.mockReset().mockResolvedValue([{ id: "/Applications/Word.app", name: "Word", isDefault: true }]);
		mocks.openWith.mockReset().mockResolvedValue(undefined);
		mocks.reveal.mockReset();
		mocks.fileIcon.mockReset().mockRejectedValue(new Error("No file icon"));
		mocks.appHandlers.clear(); mocks.handlers.clear(); mocks.listeners.clear();
		await import("./main.js");
		mocks.appHandlers.get("activate")!();
	});
	const openSearch = () => {
		mocks.handlers.get("inno-open-search-window")!({ sender: mocks.windows[0].webContents }, "dark");
		return mocks.windows[1];
	};

	it("opens the original file resolved in its owner workspace", async () => {
		const fetchFile = vi.fn(async () => ({ ok: true, json: async () => ({ absolutePath: "/workspace/owner/report.docx" }) }));
		vi.stubGlobal("fetch", fetchFile);
		const opened = await mocks.handlers.get("inno-open-workspace-file")!({ sender: mocks.windows[0].webContents }, { path: "报告.docx", workspaceId: "owner" });
		expect(opened).toBe(true);
		const url = new URL(fetchFile.mock.calls[0][0] as string);
		expect(url.pathname).toBe("/api/workspace/file-location");
		expect(url.searchParams.get("workspaceId")).toBe("owner");
		expect(url.searchParams.get("path")).toBe("报告.docx");
		expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith("/workspace/owner/report.docx");
	});
	it("rejects untrusted senders, invalid inputs, missing files and OS failures", async () => {
		const fetchFile = vi.fn(); vi.stubGlobal("fetch", fetchFile);
		const open = mocks.handlers.get("inno-open-workspace-file")!;
		const trusted = { sender: mocks.windows[0].webContents };
		expect(await open({ sender: {} }, { path: "a.txt" })).toBe(false);
		for (const request of [null, {}, { path: "" }, { path: "a", workspaceId: 1 }]) expect(await open(trusted, request)).toBe(false);
		expect(fetchFile).not.toHaveBeenCalled();
		fetchFile.mockResolvedValueOnce({ ok: false });
		expect(await open(trusted, { path: "missing.txt" })).toBe(false);
		fetchFile.mockResolvedValueOnce({ ok: true, json: async () => ({ absolutePath: "relative.txt" }) });
		expect(await open(trusted, { path: "a.txt" })).toBe(false);
		expect(mocks.openPath).not.toHaveBeenCalled();
		fetchFile.mockResolvedValue({ ok: true, json: async () => ({ absolutePath: "/workspace/a.txt" }) });
		mocks.openPath.mockResolvedValue("No application");
		expect(await open(trusted, { path: "a.txt" })).toBe(false);
		fetchFile.mockRejectedValue(new Error("offline"));
		expect(await open(trusted, { path: "a.txt" })).toBe(false);
	});

	it("lists applicable apps, opens a selected registered app, and reveals the original", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ absolutePath: "/workspace/report.docx" }) })));
		const event = { sender: mocks.windows[0].webContents };
		const request = { path: "report.docx", workspaceId: "owner" };
		const result: any = await mocks.handlers.get("inno-workspace-file-applications")!(event, request);
		expect(result.applications).toEqual([{ id: "/Applications/Word.app", name: "Word", isDefault: true }]);
		expect(await mocks.handlers.get("inno-open-workspace-file")!(event, { ...request, applicationId: "/Applications/Word.app" })).toBe(true);
		expect(mocks.openWith).toHaveBeenCalledExactlyOnceWith("/workspace/report.docx", "/Applications/Word.app");
		expect(await mocks.handlers.get("inno-open-workspace-file")!(event, { ...request, applicationId: "/unregistered/Evil.app" })).toBe(false);
		expect(mocks.openWith).toHaveBeenCalledOnce();
		expect(await mocks.handlers.get("inno-reveal-workspace-file")!(event, request)).toBe(true);
		expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith("/workspace/report.docx");
	});
	it("keeps native bundle icons instead of replacing them with a generic file icon", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ absolutePath: "/workspace/report.docx" }) })));
		const icon = "data:image/png;base64,iVBORw0KGgo=";
		mocks.listApps.mockResolvedValue([{ id: "/Applications/Word.app", name: "Word", isDefault: true, icon }]);
		mocks.fileIcon.mockResolvedValue({ toDataURL: () => "generic-file-icon" });
		const result: any = await mocks.handlers.get("inno-workspace-file-applications")!({ sender: mocks.windows[0].webContents }, { path: "report.docx" });
		expect(result.applications[0].icon).toBe(icon);
		expect(mocks.fileIcon).not.toHaveBeenCalled();
	});
	it("keeps default opening when enumeration fails and rejects foreign list/reveal requests", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ absolutePath: "/workspace/report.docx" }) })));
		mocks.listApps.mockRejectedValue(new Error("native list unavailable"));
		const request = { path: "report.docx" }; const event = { sender: mocks.windows[0].webContents };
		expect(await mocks.handlers.get("inno-workspace-file-applications")!({ sender: {} }, request)).toBeNull();
		expect(await mocks.handlers.get("inno-reveal-workspace-file")!({ sender: {} }, request)).toBe(false);
		const result: any = await mocks.handlers.get("inno-workspace-file-applications")!(event, request);
		expect(result).toMatchObject({ unavailable: true, applications: [{ id: "system-default", isDefault: true }] });
		expect(await mocks.handlers.get("inno-open-workspace-file")!(event, request)).toBe(true);
	});

	it("resizes from the real screen cursor, uses the final release point, and stops afterwards", () => {
		const main = mocks.windows[0]; const event = { sender: main.webContents };
		const resize = mocks.listeners.get("inno-resize-window")!;
		resize(event, { action: "start", edge: "nw" });
		mocks.cursor = { x: 120, y: 130 };
		resize(event, { action: "update", x: 99999, y: 99999 });
		expect(main.setBounds).toHaveBeenLastCalledWith({ x: 120, y: 110, width: 1180, height: 770 }, false);
		mocks.cursor = { x: 130, y: 140 };
		resize(event, { action: "end" });
		expect(main.setBounds).toHaveBeenLastCalledWith({ x: 130, y: 120, width: 1170, height: 760 }, false);
		resize(event, { action: "update" });
		expect(main.setBounds).toHaveBeenCalledTimes(2);
	});

	it.each(["blur", "maximize", "enter-full-screen", "render-process-gone", "did-start-loading"])("drops the current resize after %s", (eventName) => {
		const main = mocks.windows[0]; const event = { sender: main.webContents };
		const resize = mocks.listeners.get("inno-resize-window")!;
		resize(event, { action: "start", edge: "e" });
		if (eventName === "render-process-gone" || eventName === "did-start-loading") main.webContents.emit(eventName);
		else main.emit(eventName);
		resize(event, { action: "update" });
		expect(main.setBounds).not.toHaveBeenCalled();
	});

	it("rejects foreign/invalid gestures and leaves maximized or fullscreen windows alone", () => {
		const main = mocks.windows[0]; const event = { sender: main.webContents };
		const resize = mocks.listeners.get("inno-resize-window")!;
		resize({ sender: {} }, { action: "start", edge: "e" });
		resize(event, { action: "update" });
		for (const request of [null, {}, { action: "bogus" }, { action: "start", edge: "bogus" }]) resize(event, request);
		for (const flag of ["isFullScreen", "isMaximized"]) {
			main[flag].mockReturnValue(true);
			resize(event, { action: "start", edge: "e" });
			main[flag].mockReturnValue(false);
			resize(event, { action: "update" });
		}
		resize(event, { action: "start", edge: "e" });
		resize(event, { action: "cancel" });
		resize(event, { action: "update" });
		expect(main.setBounds).not.toHaveBeenCalled();
	});

	it("matches light content with a light native frame even when the OS is dark", () => {
		const main = mocks.windows[0];
		expect(nativeTheme.themeSource).toBe("light");
		expect(main.options.backgroundColor).toBe("#f8fafd");
		const setTheme = mocks.handlers.get("inno-set-theme-preference")!;
		expect(setTheme({ sender: main.webContents }, "dark")).toBe("dark");
		expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#202020");
		expect(setTheme({ sender: main.webContents }, "light")).toBe("light");
		expect(nativeTheme.themeSource).toBe("light");
		expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#f8fafd");
	});

	it("follows OS appearance updates for native surfaces and rejects foreign theme changes", () => {
		const main = mocks.windows[0]; const search = openSearch();
		const setTheme = mocks.handlers.get("inno-set-theme-preference")!;
		expect(setTheme({ sender: main.webContents }, "system")).toBe("dark");
		expect(nativeTheme.themeSource).toBe("system");
		mocks.systemDark = false;
		nativeTheme.emit("updated");
		expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#f8fafd");
		expect(search.setBackgroundColor).toHaveBeenLastCalledWith("#f5f7fa");
		expect(setTheme({ sender: search.webContents }, "dark")).toBeNull();
		expect(setTheme({ sender: {} }, "dark")).toBeNull();
		expect(setTheme({ sender: main.webContents }, "invalid")).toBeNull();
		expect(nativeTheme.themeSource).toBe("system");
	});

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
	it("validates the edge resize protocol before sending native commands", () => {
		const { ipc, api } = bridge();
		api.resizeWindow("bogus"); api.resizeWindow("start", "bogus");
		expect(ipc.send).not.toHaveBeenCalled();
		for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
			api.resizeWindow("start", edge);
			expect(ipc.send).toHaveBeenLastCalledWith("inno-resize-window", { action: "start", edge });
		}
		api.resizeWindow("end");
		expect(ipc.send).toHaveBeenLastCalledWith("inno-resize-window", { action: "end", edge: undefined });
	});
	it("forwards only the three supported theme preferences", async () => {
		const { ipc, api } = bridge(); ipc.invoke.mockResolvedValue("dark");
		expect(await api.setThemePreference("invalid")).toBeNull();
		expect(ipc.invoke).not.toHaveBeenCalled();
		for (const preference of ["light", "dark", "system"]) {
			expect(await api.setThemePreference(preference)).toBe("dark");
			expect(ipc.invoke).toHaveBeenLastCalledWith("inno-set-theme-preference", preference);
		}
	});
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
	it("validates workspace-file requests before forwarding to the main process", async () => {
		const { ipc, api } = bridge(); ipc.invoke.mockResolvedValue(true);
		expect(await api.openWorkspaceFile("", "owner")).toBe(false);
		expect(await api.openWorkspaceFile("a.docx", 42)).toBe(false);
		expect(ipc.invoke).not.toHaveBeenCalled();
		expect(await api.openWorkspaceFile("a.docx", "owner")).toBe(true);
		expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("inno-open-workspace-file", { path: "a.docx", workspaceId: "owner", applicationId: undefined });
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
