import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import XlsxEditor from "./XlsxEditor.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const mocks = vi.hoisted(() => ({
	language: "en", createUnit: vi.fn(), theme: vi.fn(), dispose: vi.fn(),
	listen: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: mocks.language }, t: (key: string) => key }) }));
vi.mock("exceljs", () => ({ default: { Workbook: class { xlsx = { load: async () => {} }; } } }));
vi.mock("./univer-xlsx.js", () => ({ excelJsToUniver: () => ({}), univerSnapshotToXlsxBytes: vi.fn() }));
vi.mock("@univerjs/presets", () => ({
	LocaleType: { ZH_CN: "zh", EN_US: "en" }, UniverInstanceType: { UNIVER_SHEET: "sheet" }, CommandType: { MUTATION: "mutation" },
	createUniver: () => ({
		univer: { createUnit: mocks.createUnit, dispose: vi.fn() },
		univerAPI: { toggleDarkMode: mocks.theme, dispose: mocks.dispose, Event: { CommandExecuted: "command", BeforeCommandExecute: "before" }, addEvent: mocks.listen, getCurrentTheme: () => ({ gray: { 900: "#123456" } }), getActiveWorkbook: () => ({ save: mocks.snapshot }) },
	}),
}));
vi.mock("@univerjs/preset-sheets-core", () => ({ UniverSheetsCorePreset: () => ({}) }));
vi.mock("@univerjs/preset-sheets-core/locales/en-US", () => ({ default: {} }));
vi.mock("@univerjs/preset-sheets-core/locales/zh-CN", () => ({ default: {} }));
const file = { name: "budget.xlsx", path: "budget.xlsx", url: "/budget" } as WorkspaceFileDetail;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); delete document.documentElement.dataset.theme; mocks.language = "en"; });

it("tracks immediate edits, synchronizes both themes, and preserves the draft on locale/callback changes", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
	let mutation!: (event: { type: string; id: string }) => void;
	mocks.listen.mockImplementation((_event, callback) => { mutation = callback; return { dispose: vi.fn() }; });
	const ready = vi.fn(); const dirty = vi.fn();
	document.documentElement.dataset.theme = "light";
	const mounted = render(<XlsxEditor file={file} onReadyChange={ready} onInteract={dirty} />);
	await waitFor(() => expect(ready).toHaveBeenCalledWith(true));
	expect(mocks.theme).toHaveBeenCalledWith(false);
	act(() => { mutation({ type: "mutation", id: "sheet.mutation.set-range-values" }); });
	expect(dirty).toHaveBeenCalledOnce();
	act(() => { mutation({ type: "mutation", id: "formula.mutation.set-results" }); });
	expect(dirty).toHaveBeenCalledOnce();
	await act(async () => { document.documentElement.dataset.theme = "dark"; });
	expect(mocks.theme).toHaveBeenLastCalledWith(true);
	mocks.language = "zh-CN";
	const nextDirty = vi.fn();
	mounted.rerender(<XlsxEditor file={file} onReadyChange={vi.fn()} onInteract={nextDirty} />);
	expect(mocks.createUnit).toHaveBeenCalledOnce();
	expect(mocks.dispose).not.toHaveBeenCalled();
	act(() => { mutation({ type: "mutation", id: "sheet.mutation.set-range-values" }); });
	expect(nextDirty).toHaveBeenCalledOnce();
	mounted.unmount();
	expect(mocks.dispose).toHaveBeenCalledOnce();
});

it("cancels structural mutations before the incomplete import can change source references", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    let before!: (event: { id: string; type: string; cancel?: boolean }) => void;
    mocks.listen.mockImplementation((name, callback) => { if (name === "before") before = callback; return { dispose: vi.fn() }; });
    const ready = vi.fn();
    render(<XlsxEditor file={file} onReadyChange={ready} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    for (const id of ["sheet.mutation.insert-row", "sheet.mutation.move-range", "sheet.mutation.remove-sheet", "sheet.command.set-text-color", "doc.command.set-inline-format", "sheet.command.paste", "univer.command.paste"]) {
        const event = { id, type: "mutation", cancel: false };
        act(() => before(event));
        expect(event.cancel).toBe(true);
    }
    const inputStyle = { id: "doc.command.set-input-style", type: "command", cancel: false };
    act(() => before(inputStyle));
    expect(inputStyle.cancel).toBe(false);
    const safe = { id: "sheet.mutation.set-range-values", type: "mutation", cancel: false };
    act(() => before(safe));
    expect(safe.cancel).toBe(false);
    const values = { id: "univer.command.paste", type: "command", params: { value: "special-paste-value" }, cancel: false };
    act(() => before(values));
    expect(values.cancel).toBe(false);
});


it.each(["light", "dark"])("keeps ordinary cell input silent and dismisses blocked-action feedback in %s", async (theme) => {
    document.documentElement.dataset.theme = theme;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const listeners = new Map<string, (event: { id: string; type: string; cancel?: boolean }) => void>();
    mocks.listen.mockImplementation((name, callback) => { listeners.set(name, callback); return { dispose: vi.fn() }; });
    const ready = vi.fn(), dirty = vi.fn();
    const mounted = render(<XlsxEditor file={file} onReadyChange={ready} onInteract={dirty} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    vi.useFakeTimers();
    const before = listeners.get("before")!, executed = listeners.get("command")!;
    const input = { id: "doc.command.set-input-style", type: "command", cancel: false };
    act(() => before(input));
    expect(input.cancel).toBe(false);
    expect(mounted.queryByRole("status")).toBeNull();
    const blocked = () => before({ id: "sheet.command.set-text-color", type: "command" });
    act(blocked);
    expect(mounted.getByRole("status").textContent).toBe("officeEditor.unsupportedCommand");
    expect(mounted.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    act(blocked);
    act(() => vi.advanceTimersByTime(3_999));
    expect(mounted.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.queryByRole("status")).toBeNull();
    act(blocked);
    act(() => executed({ id: "sheet.mutation.set-range-values", type: "mutation" }));
    expect(dirty).toHaveBeenCalledOnce();
    expect(mounted.queryByRole("status")).toBeNull();
    act(blocked);
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it("retains workbook loading failures instead of expiring them with action feedback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const mounted = render(<XlsxEditor file={file} />);
    expect((await mounted.findByRole("alert")).textContent).toContain("404");
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(10_000));
    expect(mounted.getByRole("alert").textContent).toContain("404");
});
