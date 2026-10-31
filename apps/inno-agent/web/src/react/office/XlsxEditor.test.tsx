import { createRef } from "react";
import { univerSnapshotToXlsxBytes } from "./univer-xlsx.js";
import type { OfficeEditorHandle } from "./office-editor-handle.js";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import XlsxEditor from "./XlsxEditor.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const mocks = vi.hoisted(() => ({
	language: "en", createUnit: vi.fn(), theme: vi.fn(), dispose: vi.fn(),
	listen: vi.fn(), snapshot: vi.fn(), commit: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: mocks.language }, t: (key: string) => key }) }));
vi.mock("exceljs", () => ({ default: { Workbook: class { xlsx = { load: async () => {} }; } } }));
vi.mock("./univer-xlsx.js", () => ({ excelJsToUniver: () => ({}), univerSnapshotToXlsxBytes: vi.fn() }));
vi.mock("@univerjs/presets", () => ({
	LocaleType: { ZH_CN: "zh", EN_US: "en" }, UniverInstanceType: { UNIVER_SHEET: "sheet" }, CommandType: { MUTATION: "mutation" },
	createUniver: () => ({
		univer: { createUnit: mocks.createUnit, dispose: vi.fn() },
		univerAPI: { toggleDarkMode: mocks.theme, dispose: mocks.dispose, Event: { CommandExecuted: "command", BeforeCommandExecute: "before", SheetEditChanging: "edit" }, addEvent: mocks.listen, getCurrentTheme: () => ({ gray: { 900: "#123456" } }), getActiveWorkbook: () => ({ save: mocks.snapshot, endEditingAsync: mocks.commit }) },
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
	mocks.listen.mockImplementation((event, callback) => { if (event === "command") mutation = callback; return { dispose: vi.fn() }; });
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

it("allows cell formatting, paste and structural edits and exports the full current workbook", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const listeners = new Map<string, (event: any) => void>();
    mocks.listen.mockImplementation((name, callback) => { listeners.set(name, callback); return { dispose: vi.fn() }; });
    const snapshot = { sheets: { updated: { name: "Renamed", cellData: { 0: { 0: { v: "edited", s: { bl: 1 } } } } } } };
    mocks.snapshot.mockReturnValue(snapshot);
    vi.mocked(univerSnapshotToXlsxBytes).mockResolvedValue(new Uint8Array([7, 8]));
    const ref = createRef<OfficeEditorHandle>(), ready = vi.fn(), dirty = vi.fn();
    render(<XlsxEditor ref={ref} file={file} onReadyChange={ready} onInteract={dirty} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    for (const id of ["sheet.mutation.insert-row", "sheet.mutation.move-range", "sheet.mutation.remove-sheet", "sheet.command.set-text-color", "doc.command.set-inline-format", "sheet.command.paste"]) {
        const event = { id, type: "mutation", cancel: false };
        act(() => listeners.get("before")?.(event));
        expect(event.cancel).toBe(false);
    }
    // Editor-document initialization is not a workbook modification. Actual
    // input still marks the draft before the cell has been committed.
    act(() => listeners.get("command")?.({ type: "mutation", id: "doc.mutation.rich-text-editing" }));
    expect(dirty).not.toHaveBeenCalled();
    act(() => listeners.get("edit")?.({}));
    expect(dirty).toHaveBeenCalledOnce();
    mocks.commit.mockImplementationOnce(async () => {
        listeners.get("edit")?.({});
        listeners.get("command")?.({ type: "mutation", id: "sheet.mutation.set-range-values" });
    });
    expect(await ref.current!.exportBytes()).toEqual(new Uint8Array([7, 8]));
    expect(mocks.commit).toHaveBeenCalledWith(true);
    expect(dirty).toHaveBeenCalledOnce();
    expect(univerSnapshotToXlsxBytes).toHaveBeenCalledWith(snapshot, file.name, expect.objectContaining({ bytes: expect.any(Uint8Array) }));
});

it("retains workbook loading failures instead of expiring them with action feedback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const mounted = render(<XlsxEditor file={file} />);
    expect((await mounted.findByRole("alert")).textContent).toContain("404");
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(10_000));
    expect(mounted.getByRole("alert").textContent).toContain("404");
});
