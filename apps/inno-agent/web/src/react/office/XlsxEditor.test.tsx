import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import XlsxEditor from "./XlsxEditor.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const mocks = vi.hoisted(() => ({
	language: "en", createUnit: vi.fn(), theme: vi.fn(), dispose: vi.fn(),
	listen: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: mocks.language } }) }));
vi.mock("exceljs", () => ({ default: { Workbook: class { xlsx = { load: async () => {} }; } } }));
vi.mock("./univer-xlsx.js", () => ({ excelJsToUniver: () => ({}), univerSnapshotToXlsxBytes: vi.fn() }));
vi.mock("@univerjs/presets", () => ({
	LocaleType: { ZH_CN: "zh", EN_US: "en" }, UniverInstanceType: { UNIVER_SHEET: "sheet" }, CommandType: { MUTATION: "mutation" },
	createUniver: () => ({
		univer: { createUnit: mocks.createUnit, dispose: vi.fn() },
		univerAPI: { toggleDarkMode: mocks.theme, dispose: mocks.dispose, Event: { CommandExecuted: "command" }, addEvent: mocks.listen, getActiveWorkbook: () => ({ save: mocks.snapshot }) },
	}),
}));
vi.mock("@univerjs/preset-sheets-core", () => ({ UniverSheetsCorePreset: () => ({}) }));
vi.mock("@univerjs/preset-sheets-core/locales/en-US", () => ({ default: {} }));
vi.mock("@univerjs/preset-sheets-core/locales/zh-CN", () => ({ default: {} }));
const file = { name: "budget.xlsx", path: "budget.xlsx", url: "/budget" } as WorkspaceFileDetail;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); delete document.documentElement.dataset.theme; mocks.language = "en"; });

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
