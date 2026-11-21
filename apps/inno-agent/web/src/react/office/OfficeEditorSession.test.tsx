import { createRef, forwardRef, useEffect, useImperativeHandle } from "react";
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { OfficeEditorSession, type OfficeSessionHandle } from "./OfficeEditorSession.js";
import { ApiError } from "../../api/client.js";
import { saveWorkspaceFileBinary } from "../../api/workspace.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const exported = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../api/workspace.js", () => ({ saveWorkspaceFileBinary: vi.fn(), triggerDownload: vi.fn(), workspaceFileUrl: () => "/download" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./XlsxEditor.js", () => ({ default: forwardRef(function FakeEditor({ file, onReadyChange, onInteract }: any, ref) {
    useImperativeHandle(ref, () => ({ exportBytes: () => exported.run(), getSourceBytes: () => new Uint8Array([9, 8]) }), []);
    useEffect(() => { onReadyChange(true); }, [onReadyChange]);
    return <button onClick={onInteract}>{file.path} edit</button>;
}) }));
const file: WorkspaceFileDetail = { path: "budget.xlsx", name: "budget.xlsx", kind: "office", format: "xlsx", mimeType: "application/octet-stream", size: 1, updatedAt: "now", url: "/budget.xlsx?workspaceId=owner" };
beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(saveWorkspaceFileBinary).mockReset().mockResolvedValue({ path: "budget.xlsx", backupPath: "budget.backup-original.xlsx", saved: true, size: 1, updatedAt: "now" });
    exported.run.mockReset().mockResolvedValue(new Uint8Array([1, 2]));
    vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
    const ref = createRef<OfficeSessionHandle>();
    const close = vi.fn();
    render(<OfficeEditorSession ref={ref} file={file} workspaceId="owner" active onClose={close} />);
    await screen.findByRole("button", { name: "budget.xlsx edit" });
    await waitFor(() => expect((screen.getByRole("button", { name: "wordEditor.save" }) as HTMLButtonElement).disabled).toBe(false));
    return { ref, close };
}
it.each(["light", "dark"])("saves directly and keeps backup details out of the editor in the %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(saveWorkspaceFileBinary).toHaveBeenCalledOnce());
    const [path, bytes, owner, options] = vi.mocked(saveWorkspaceFileBinary).mock.calls[0];
    expect(path).toBe("budget.xlsx");
    expect(options).toEqual({ confirmOverwrite: true, backupOriginal: false, expectedContentHash: createHash("sha256").update(new Uint8Array([9, 8])).digest("hex") });
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(owner).toBe("owner");
    expect(await screen.findByText("wordEditor.saved")).toBeTruthy();
    expect(screen.queryByText(/budget.backup-original.xlsx/)).toBeNull();
});
it("retains edits made while the previous revision is being exported", async () => {
    let finish!: (value: Uint8Array) => void;
    exported.run.mockImplementation(() => new Promise<Uint8Array>((resolve) => { finish = resolve; }));
    const { ref } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" }));
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    await act(async () => { finish(new Uint8Array([3])); });
    expect(await screen.findByText("wordEditor.unsaved")).toBeTruthy();
    act(() => { expect(ref.current!.requestCloseTab()).toBe(true); });
    expect(screen.getByRole("dialog")).toBeTruthy();
});
it("blocks close on an edit in the same batch and retains a failed save", async () => {
    const { ref, close } = await setup();
    vi.mocked(saveWorkspaceFileBinary).mockRejectedValue(new Error("disk full"));
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
        expect(ref.current!.requestCloseTab()).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(within(screen.getByRole("dialog")).getByText("disk full")).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
});
it("warns before unloading a page with an unsaved draft", async () => {
    await setup();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
});
it("does not export hidden editors on the save shortcut", async () => {
    render(<OfficeEditorSession file={file} workspaceId="owner" active={false} onClose={vi.fn()} />);
    await screen.findByText("budget.xlsx edit");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(exported.run).not.toHaveBeenCalled();
});

it("saves directly with the keyboard shortcut", async () => {
    await setup();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await screen.findByText("wordEditor.saved");
    expect(saveWorkspaceFileBinary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
});

it("numbers copies when a readable filename is already taken", async () => {
    vi.mocked(saveWorkspaceFileBinary).mockRejectedValueOnce(new ApiError(409, "File already exists", { code: "FILE_EXISTS" }))
        .mockImplementationOnce(async path => ({ path, saved: true, size: 2, updatedAt: "now" }));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveCopy" }));
    await screen.findByText("officeEditor.copySaved");
    expect(vi.mocked(saveWorkspaceFileBinary).mock.calls.map(call => call[0])).toEqual(["budget - officeEditor.copyName.xlsx", "budget - officeEditor.copyName (2).xlsx"]);
});

it.each(["light", "dark"])("saves the current draft as a new file in the %s theme without confirming an overwrite", async (theme) => {
    document.documentElement.dataset.theme = theme;
    vi.mocked(saveWorkspaceFileBinary).mockImplementation(async (path) => ({ path, saved: true, size: 2, updatedAt: "now" }));
    const { ref } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveCopy" }));
    await screen.findByText("officeEditor.copySaved");
    const [path, bytes, owner, options] = vi.mocked(saveWorkspaceFileBinary).mock.calls[0];
    expect(path).toBe("budget - officeEditor.copyName.xlsx");
    expect(path).not.toBe(file.path);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(owner).toBe("owner");
    expect(options).toEqual({ createOnly: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/officeEditor.copyPath/).textContent).toContain(path);
    act(() => { expect(ref.current!.requestCloseTab()).toBe(false); });
});
it("keeps a draft unsaved when preserving export refuses an unsupported edit", async () => {
    exported.run.mockRejectedValue(new Error("Cannot preserve this edit"));
    const { ref } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveCopy" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot preserve this edit");
    expect(saveWorkspaceFileBinary).not.toHaveBeenCalled();
    act(() => { expect(ref.current!.requestCloseTab()).toBe(true); });
});

it("keeps the editor free of a persistent warning banner", async () => {
    await setup();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("officeEditor.overwriteNotice")).toBeNull();
    expect(screen.getByRole("button", { name: "officeEditor.saveCopy" }).getAttribute("aria-label")).toBe("officeEditor.saveCopy");
});
it("uses the latest successful overwrite version for the next save", async () => {
    await setup();
    vi.mocked(saveWorkspaceFileBinary).mockResolvedValue({ path: file.path, saved: true, size: 1, updatedAt: "new-version" });
    for (let i = 0; i < 2; i++) {
        fireEvent.click(screen.getByRole("button", { name: "wordEditor.save" }));
        await waitFor(() => expect(saveWorkspaceFileBinary).toHaveBeenCalledTimes(i + 1));
        await waitFor(() => expect((screen.getByRole("button", { name: "wordEditor.save" }) as HTMLButtonElement).disabled).toBe(false));
    }
    expect(vi.mocked(saveWorkspaceFileBinary).mock.calls[1][3]).toEqual({ confirmOverwrite: true, backupOriginal: false, expectedContentHash: createHash("sha256").update(new Uint8Array([1, 2])).digest("hex") });
});
