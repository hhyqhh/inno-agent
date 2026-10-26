import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import WordEditor from "./WordEditor.js";

const mocks = vi.hoisted(() => ({ open: vi.fn(), prepare: vi.fn(), mathPrepare: vi.fn(), mathRestore: vi.fn(), repair: vi.fn(), save: vi.fn(), serialize: vi.fn(), flush: vi.fn(), validate: vi.fn(), nativeSave: null as null | (() => Promise<void>), download: vi.fn(), theme: { current: "light", on: () => () => {} } }));
vi.mock("../../api/word-editor.js", () => ({ openWordDocument: mocks.open, saveWordDocument: mocks.save, downloadWordCopy: mocks.download }));
vi.mock("../../stores/theme-store.js", () => ({ themeStore: mocks.theme }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { time?: string }) => values?.time ? `${key} ${values.time}` : key, i18n: { language: "zh-CN" } }) }));
vi.mock("./validate-word-export.js", () => ({ validateWordExport: mocks.validate }));
vi.mock("./repair-word-export.js", () => ({ repairWordExport: mocks.repair }));
vi.mock("./prepare-vml.js", () => ({ prepareVml: mocks.prepare }));
vi.mock("./prepare-math.js", () => ({ createMathSession: mocks.mathPrepare }));
vi.mock("./WordRibbon.js", () => ({ WordRibbon: () => <div>Ribbon</div> }));
vi.mock("@betteroffice/docx-react", () => ({
 configureDefaultFonts: vi.fn(),
 LocaleProvider: ({ i18n, children }: { i18n?: { _lang?: string }; children: ReactNode }) => (
  <div data-testid="word-locale-provider" data-locale={i18n?._lang ?? "en"}>{children}</div>
 ),
 DocxEditor: forwardRef(({ onFirstPagePainted, onChange, onSaveRequest }: { onFirstPagePainted: () => void; onChange: () => void; onSaveRequest: () => Promise<void> }, ref) => {
  useImperativeHandle(ref, () => ({ save: mocks.serialize, flushPendingInput: mocks.flush }));
  useEffect(() => { onFirstPagePainted(); }, []);
  mocks.nativeSave = onSaveRequest;
  return <div data-testid="word-canvas"><button onClick={onChange}>Type in document</button></div>;
 }),
}));
const file: WorkspaceFileDetail = { path: "report.docx", name: "report.docx", kind: "office", format: "docx", mimeType: "", size: 100, updatedAt: "v1" };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => {
	mocks.open.mockResolvedValue({ bytes: new Uint8Array([1, 2]), version: "v1" });
	mocks.prepare.mockImplementation((bytes: Uint8Array) => ({ bytes, converted: 0, unsupported: 0 }));
	mocks.mathRestore.mockImplementation((buffer: ArrayBuffer) => buffer);
	mocks.mathPrepare.mockImplementation(async (bytes: Uint8Array) => ({ bytes, converted: 0, unsupported: 0, restore: mocks.mathRestore }));
	mocks.flush.mockResolvedValue(undefined);
	mocks.serialize.mockResolvedValue(new Uint8Array([3, 4]).buffer);
	mocks.repair.mockImplementation((buffer: ArrayBuffer) => buffer);
	mocks.save.mockResolvedValue({ version: "v2", savedAt: "2026-10-25T08:00:00Z" }); mocks.theme.current = "light";
	Object.defineProperties(HTMLDialogElement.prototype, { show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } }, showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } }, close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } } });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("browser Word editor", () => {
	it("prepares VML before opening and blocks lossy export for unsupported shapes", async () => {
		mocks.prepare.mockImplementation((bytes: Uint8Array) => ({ bytes, converted: 1, unsupported: 2 }));
		render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
		expect(mocks.prepare).toHaveBeenCalledWith(new Uint8Array([1, 2]));
		expect(screen.getByRole("alert").textContent).toContain("wordEditor.unsupportedVml");
		expect((screen.getByRole("button", { name: "wordEditor.save" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "wordEditor.downloadCopy" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(window, { key: "s", ctrlKey: true }); await flush();
		await act(async () => { await mocks.nativeSave?.(); });
		expect(mocks.serialize).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
	});
	it.each(["light", "dark"])("loads the owning workspace in %s mode without an Office service", async (theme) => {
		mocks.theme.current = theme; const { container } = render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
		expect(screen.getByTestId("word-canvas")).toBeTruthy(); expect(mocks.open).toHaveBeenCalledWith(file.path, "owner", expect.any(AbortSignal));
		expect(document.querySelector(".inno-word-editor")?.getAttribute("data-color-mode")).toBe(theme); expect(container.textContent).not.toContain("ONLYOFFICE");
	});
	it("renders inline with one file bar and no fullscreen dialog layer", async () => {
		render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
		expect(document.querySelector("dialog[open]")).toBeNull();
		expect(screen.getAllByRole("button", { name: "wordEditor.save" }).length).toBe(1);
		expect(screen.getByRole("button", { name: "wordEditor.back" })).toBeTruthy();
		expect(document.querySelector(".inno-file-name")?.textContent).toBe("report.docx");
		expect(screen.getByRole("status").textContent).toContain("wordEditor.saved");
	});
 it("provides the library locale context so the built-in context menu follows the app language", async () => {
  // The sync editor route never mounts the library's own LocaleProvider, and
  // its context menu reads from that context, so the editor must be wrapped.
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  const provider = screen.getByTestId("word-canvas").closest('[data-testid="word-locale-provider"]');
  expect(provider).toBeTruthy(); expect(provider?.getAttribute("data-locale")).toBe("zh-CN");
 });
 it("renders file-bar actions as ghost buttons whose hints come from the shared tooltip", async () => {
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  for (const name of ["wordEditor.save", "wordEditor.downloadCopy", "wordEditor.back"]) {
   const button = screen.getByRole("button", { name });
   expect(button.className).toContain("inno-ghost-button");
   expect(button.className).not.toContain("inno-primary-button");
   expect(button.className).not.toContain("inno-secondary-button");
   // Enabled triggers carry no native title: the shared tooltip owns the hint,
   // so the browser bubble never duplicates it.
   expect(button.getAttribute("title")).toBeNull();
  }
  fireEvent.focus(screen.getByRole("button", { name: "wordEditor.save" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain("wordEditor.saveShortcut");
 });
 it("keeps a native title on disabled actions as the mouse-hover fallback", async () => {
  mocks.prepare.mockImplementation((bytes: Uint8Array) => ({ bytes, converted: 1, unsupported: 2 }));
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  const save = screen.getByRole("button", { name: "wordEditor.save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(save.getAttribute("title")).toBe("wordEditor.saveShortcut");
  fireEvent.focus(save);
  expect(screen.queryByRole("tooltip")).toBeNull();
 });
 it("ignores the save shortcut while its tab is in the background", async () => {
		render(<WordEditor file={file} workspaceId="owner" active={false} onClose={vi.fn()} />); await flush();
		fireEvent.keyDown(window, { key: "s", ctrlKey: true }); await flush();
		expect(mocks.flush).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
	});
 it("uses the same workspace save path for the engine save action", async () => {
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  fireEvent.click(screen.getByText("Type in document"));
  await act(async () => { await mocks.nativeSave?.(); });
  expect(mocks.flush).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
 });
 it("saves and downloads the repaired export, not the raw engine bytes", async () => {
  const repaired = new Uint8Array([5, 6]).buffer;
  mocks.repair.mockReturnValue(repaired);
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  fireEvent.click(screen.getByText("Type in document"));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
  expect(mocks.repair).toHaveBeenCalledWith(new Uint8Array([3, 4]).buffer);
  expect(mocks.validate).toHaveBeenCalledWith(repaired);
  expect(mocks.save).toHaveBeenCalledWith(file.path, "owner", "v1", new Uint8Array(repaired));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.downloadCopy" })); await flush();
  expect(mocks.download).toHaveBeenCalledWith(file.name, repaired);
 });
 it("restores the original OMML after repair and before validation when math was typeset", async () => {
  const prepared = new Uint8Array([7, 8]);
  const restored = new Uint8Array([9, 10]).buffer;
  mocks.mathPrepare.mockImplementation(async () => ({ bytes: prepared, converted: 2, unsupported: 0, restore: mocks.mathRestore }));
  mocks.mathRestore.mockReturnValue(restored);
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  expect(mocks.mathPrepare).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  fireEvent.click(screen.getByText("Type in document"));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
  expect(mocks.mathRestore).toHaveBeenCalledWith(new Uint8Array([3, 4]).buffer);
  expect(mocks.validate).toHaveBeenCalledWith(restored);
  expect(mocks.save).toHaveBeenCalledWith(file.path, "owner", "v1", new Uint8Array(restored));
 });
 it("keeps the document editable when math typesetting fails entirely", async () => {
  mocks.mathPrepare.mockRejectedValueOnce(new Error("mathjax offline"));
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  expect(screen.getByTestId("word-canvas")).toBeTruthy();
  fireEvent.click(screen.getByText("Type in document"));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
  expect(mocks.mathRestore).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledOnce();
 });
 it("reports equations it could not typeset without blocking the save button", async () => {
  mocks.mathPrepare.mockImplementation(async (bytes: Uint8Array) => ({ bytes, converted: 51, unsupported: 3, restore: mocks.mathRestore }));
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  expect(screen.getByText("wordEditor.unsupportedMath")).toBeTruthy();
  expect((screen.getByRole("button", { name: "wordEditor.save" }) as HTMLButtonElement).disabled).toBe(false);
 });
 it("does not overwrite the original when the engine exports invalid XML", async () => {
  mocks.validate.mockImplementationOnce(() => { throw new Error("WORD_EDITOR_INVALID_EXPORT"); });
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  fireEvent.click(screen.getByText("Type in document"));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("wordEditor.unsaved");
  expect(screen.getByRole("alert").textContent).toContain("wordEditor.invalidExport");
 });
 it("waits for IME input to settle before serializing and refuses an empty export", async () => {
  let finish!: () => void;
  mocks.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  mocks.serialize.mockResolvedValueOnce(null);
  render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush();
  fireEvent.click(screen.getByText("Type in document"));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
  expect(mocks.serialize).not.toHaveBeenCalled();
  finish(); await flush();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("wordEditor.unsaved");
  expect(screen.getByRole("alert").textContent).toContain("wordEditor.saveFailed");
 });

	it("keeps edits dirty until the original workspace save commits", async () => {
		let finish!: (result: { version: string; savedAt: string }) => void;
		mocks.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />); await flush(); fireEvent.click(screen.getByText("Type in document"));
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
		expect(mocks.save).toHaveBeenCalledWith(file.path, "owner", "v1", new Uint8Array([3, 4])); expect(screen.getByRole("status").textContent).toBe("wordEditor.saving");
		finish({ version: "v2", savedAt: "2026-10-25T08:00:00Z" }); await flush(); expect(screen.getByRole("status").textContent).toContain("wordEditor.lastSaved");
		fireEvent.click(screen.getByText("Type in document")); fireEvent.keyDown(window, { key: "s", ctrlKey: true }); await flush();
		expect(mocks.save.mock.calls[1][2]).toBe("v2");
	});
	it("does not mark newer edits saved while an earlier revision is in flight", async () => {
		let finish!: (result: { version: string; savedAt: string }) => void;
		mocks.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		render(<WordEditor file={file} workspaceId="a" onClose={vi.fn()} />); await flush(); fireEvent.click(screen.getByText("Type in document")); fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush(); fireEvent.click(screen.getByText("Type in document"));
		finish({ version: "v2", savedAt: "2026-10-25T08:00:00Z" }); await flush(); expect(screen.getByRole("status").textContent).toBe("wordEditor.unsaved");
	});
	it("asks before leaving unsaved changes, then saves before closing", async () => {
		const close = vi.fn(); render(<WordEditor file={file} workspaceId="a" onClose={close} />); await flush(); fireEvent.click(screen.getByText("Type in document")); fireEvent.click(screen.getByRole("button", { name: "wordEditor.back" }));
		expect(close).not.toHaveBeenCalled(); expect(screen.getByRole("dialog", { name: "wordEditor.closeTitle" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" })); await flush(); expect(close).toHaveBeenCalledOnce();
	});
	it("anchors its leave confirmation to the editor pane and closes it with Escape", async () => {
		const close = vi.fn(); render(<WordEditor file={file} workspaceId="a" onClose={close} />); await flush(); fireEvent.click(screen.getByText("Type in document")); fireEvent.click(screen.getByRole("button", { name: "wordEditor.back" }));
		const dialog = screen.getByRole("dialog", { name: "wordEditor.closeTitle" });
		// The confirmation renders in place inside the editor pane (not the body),
		// so the mask and the centered card follow the pane instead of the window.
		expect(dialog.closest(".inno-word-editor")).toBeTruthy();
		expect(dialog.classList.contains("inno-word-confirm-dialog")).toBe(true);
		expect(dialog.querySelector(".inno-word-confirm-card")).toBeTruthy();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull();
		expect(close).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.back" }));
		// Clicking the mask (the dialog element itself) only dismisses the prompt.
		fireEvent.click(screen.getByRole("dialog", { name: "wordEditor.closeTitle" }));
		expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull();
		expect(close).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.back" }));
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.discard" }));
		expect(close).toHaveBeenCalledOnce();
	});
	it("retains a conflicted draft and downloads its current bytes", async () => {
		mocks.save.mockRejectedValue(new ApiError(409, "Conflict", { code: "WORD_EDITOR_CONFLICT" })); const close = vi.fn();
		render(<WordEditor file={file} workspaceId="a" onClose={close} />); await flush(); fireEvent.click(screen.getByText("Type in document")); fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" })); await flush();
		expect(screen.getByRole("alert").textContent).toContain("wordEditor.conflict"); expect(screen.getByRole("status").textContent).toBe("wordEditor.unsaved");
		fireEvent.click(screen.getAllByRole("button", { name: "wordEditor.downloadCopy" })[0]); await flush(); expect(mocks.download).toHaveBeenCalledWith(file.name, new Uint8Array([3, 4]).buffer); expect(close).not.toHaveBeenCalled();
	});
	it("retries a failed load and aborts its read on unmount", async () => {
		mocks.open.mockRejectedValueOnce(new Error("offline")); const { unmount } = render(<WordEditor file={file} workspaceId={null} onClose={vi.fn()} />); await flush();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.retry" })); await flush(); expect(screen.getByTestId("word-canvas")).toBeTruthy(); const signal = mocks.open.mock.calls[1][2] as AbortSignal;
		unmount(); expect(signal.aborted).toBe(true);
	});
});
