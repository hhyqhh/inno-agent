import { createRef, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { OfficeEditorSession, type OfficeSessionHandle } from "./OfficeEditorSession.js";
import { saveWorkspaceFileBinary } from "../../api/workspace.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const exported = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../api/workspace.js", () => ({ saveWorkspaceFileBinary: vi.fn(), triggerDownload: vi.fn(), workspaceFileUrl: () => "/download" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./XlsxEditor.js", () => ({ default: forwardRef(function FakeEditor({ file, onReadyChange, onInteract }: any, ref) {
    useImperativeHandle(ref, () => ({ exportBytes: () => exported.run() }), []);
    useEffect(() => { onReadyChange(true); }, [onReadyChange]);
    return <button onClick={onInteract}>{file.path} edit</button>;
}) }));
const file: WorkspaceFileDetail = { path: "budget.xlsx", name: "budget.xlsx", kind: "office", format: "xlsx", mimeType: "application/octet-stream", size: 1, updatedAt: "now", url: "/budget.xlsx?workspaceId=owner" };
beforeEach(() => {
    vi.mocked(saveWorkspaceFileBinary).mockReset().mockResolvedValue({ path: "copy", saved: true, size: 1, updatedAt: "now" });
    exported.run.mockReset().mockResolvedValue(new Uint8Array([1, 2]));
    vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup() {
    const ref = createRef<OfficeSessionHandle>();
    const close = vi.fn();
    render(<OfficeEditorSession ref={ref} file={file} workspaceId="owner" active onClose={close} />);
    await screen.findByRole("button", { name: "budget.xlsx edit" });
    await waitFor(() => expect((screen.getByRole("button", { name: "officeEditor.saveCopy" }) as HTMLButtonElement).disabled).toBe(false));
    return { ref, close };
}
it("creates an edited copy in the original owner workspace", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveCopy" }));
    await waitFor(() => expect(saveWorkspaceFileBinary).toHaveBeenCalledOnce());
    const [path, bytes, owner] = vi.mocked(saveWorkspaceFileBinary).mock.calls[0];
    expect(path).toMatch(/^budget\.edited-.+\.xlsx$/);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(owner).toBe("owner");
    expect(await screen.findByText("officeEditor.copySaved")).toBeTruthy();
});
it("retains edits made while the previous revision is being exported", async () => {
    let finish!: (value: Uint8Array) => void;
    exported.run.mockImplementation(() => new Promise<Uint8Array>((resolve) => { finish = resolve; }));
    const { ref } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveCopy" }));
    fireEvent.click(screen.getByRole("button", { name: "budget.xlsx edit" }));
    await act(async () => { finish(new Uint8Array([3])); });
    expect(screen.getByText("officeEditor.unsaved")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "officeEditor.saveAndClose" }));
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
