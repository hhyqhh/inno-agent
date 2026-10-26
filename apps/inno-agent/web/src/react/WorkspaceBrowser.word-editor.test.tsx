import { forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDragDropManager } from "react-dnd";
import { workspaceStore, previewTabKey, isStartTab, isStartTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import type { WorkspaceFileDetail } from "../types/workspace.js";
import { WorkspaceBrowser } from "./WorkspaceBrowser.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";

const lifecycle = vi.hoisted(() => ({
	mount: vi.fn(),
	unmount: vi.fn(),
	isDirty: vi.fn(() => false),
	// save receives the editor instance id ("<workspace>:<path>") so tests can
	// verify a close flow saves the confirmed file, never a sibling tab's editor.
	save: vi.fn((_instanceId?: string) => Promise.resolve(true)),
}));
vi.mock("@earendil-works/pi-web-ui", () => ({}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock("./office/DocxPreview.js", () => ({ default: () => <div>Document preview</div> }));
vi.mock("./office/WordEditor.js", () => ({
	default: forwardRef(function MockedWordEditor({ file, workspaceId, active, onClose }: { file: WorkspaceFileDetail; workspaceId: string | null; active?: boolean; onClose(): void }, ref) {
		useEffect(() => { lifecycle.mount(); return () => { lifecycle.unmount(); }; }, []);
		useImperativeHandle(ref, () => ({ isDirty: () => lifecycle.isDirty(), save: () => lifecycle.save(`${workspaceId ?? ""}:${file.path}`) }));
		return <div role="group" aria-label="Word editor" data-active={active ? "true" : "false"}><span>{workspaceId}:{file.path}</span><button onClick={onClose}>Finish editing</button></div>;
	}),
}));

function Browser() { return <WorkspaceBrowser variant="workspace" dndManager={useDragDropManager()} />; }

describe("Inline Word editor workspace ownership", () => {
	let width: number;
	const observers: Array<{ element: Element; callback: ResizeObserverCallback }> = [];
	beforeEach(() => {
		width = 900;
		observers.length = 0;
		vi.clearAllMocks();
		lifecycle.isDirty.mockReturnValue(false);
		lifecycle.save.mockResolvedValue(true);
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		vi.stubGlobal("ResizeObserver", class {
			constructor(private callback: ResizeObserverCallback) {}
			observe(element: Element) { observers.push({ element, callback: this.callback }); }
			unobserve() {}
			disconnect() {}
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 700 } as DOMRect));
		Object.defineProperties(HTMLDialogElement.prototype, { show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } }, showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } }, close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } } });
		const file: WorkspaceFileDetail = { path: "report.docx", name: "report.docx", kind: "office", format: "docx", mimeType: "", size: 100, updatedAt: "now" };
		const tab = { path: file.path, name: file.name, workspaceId: "owner", file, isLoading: false, isEditing: false, editBuffer: "", isSaving: false, error: "", requestId: 1 };
		workspaceStore.previewTabs = [tab, { ...tab, workspaceId: "other", path: "other.docx", name: "other.docx", file: { ...file, path: "other.docx", name: "other.docx" } }];
		workspaceStore.activePreviewPath = previewTabKey(tab);
		workspaceStore.activeWorkspaceId = "owner";
		workspaceStore.tree = { name: "Project", path: "", root: "project", type: "directory", children: [] };
		workspaceStore.streamingPreview = null;
		workspaceStore.error = "";
		workspaceStore.isLoadingTree = false;
		workspaceStore.isMutating = false;
		sessionsStore.currentSessionId = null;
		vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
		vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
		vi.spyOn(workspacesStore, "load").mockResolvedValue();
	});
	afterEach(() => {
		cleanup();
		workspaceStore.previewTabs = [];
		workspaceStore.activePreviewPath = null;
		workspaceStore.activeWorkspaceId = null;
		workspaceStore.wordEditCloseGuard = null;
		delete document.documentElement.dataset.theme;
		vi.restoreAllMocks(); vi.unstubAllGlobals();
	});

	it("opens the editor inside the preview pane instead of a fullscreen dialog", async () => {
		const { container } = render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		const pane = container.querySelector(".inno-workspace-preview-pane");
		expect(pane).toBeTruthy();
		expect(pane!.textContent).toContain("owner:report.docx");
		expect(document.querySelector("dialog[open]")).toBeNull();
		expect(lifecycle.mount).toHaveBeenCalledOnce();
	});

	it("offers the DOCX edit entry as a ghost button with the shared tooltip", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		const edit = screen.getByRole("button", { name: "Edit" });
		expect(edit.className).toContain("inno-ghost-button");
		expect(edit.className).not.toContain("inno-secondary-button");
		// The hint rides the shared tooltip (keyboard focus included), so the
		// enabled trigger must not also expose a native title bubble.
		expect(edit.getAttribute("title")).toBeNull();
		fireEvent.focus(edit);
		expect((await screen.findByRole("tooltip")).textContent).toBe("Edit");
	});

	it("keeps one editor session across width and workspace changes in both themes", async () => {
		for (const theme of ["light", "dark"] as const) {
			width = 900;
			lifecycle.mount.mockClear(); lifecycle.unmount.mockClear();
			document.documentElement.dataset.theme = theme;
			const { container } = render(<InnoDndProvider><Browser /></InnoDndProvider>);
			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			await screen.findByLabelText("Word editor");
			act(() => {
				width = 320;
				for (const { element, callback } of [...observers]) callback([{ target: element, contentRect: { width, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
				workspaceStore.activeWorkspaceId = "other";
				workspaceStore.activatePreview(previewTabKey({ workspaceId: "other", path: "other.docx" }));
			});
			// The session pins the pane open and stays mounted while its tab is
			// backgrounded; the editor hides instead of losing the draft.
			expect(container.querySelector(".inno-workspace-preview-pane")).not.toBeNull();
			const editor = screen.getByLabelText("Word editor");
			const layer = editor.parentElement as HTMLElement;
			expect(layer.className).toContain("invisible");
			expect(layer.getAttribute("inert")).not.toBeNull();
			expect(editor.textContent).toContain("owner:report.docx");
			expect(lifecycle.unmount).not.toHaveBeenCalled();
			act(() => { workspaceStore.activatePreview(previewTabKey({ workspaceId: "owner", path: "report.docx" })); });
			expect((screen.getByLabelText("Word editor").parentElement as HTMLElement).className).not.toContain("invisible");
			fireEvent.click(screen.getByRole("button", { name: "Finish editing" }));
			expect(lifecycle.unmount).toHaveBeenCalledOnce();
			expect(workspaceStore.selectFile).toHaveBeenCalledWith("report.docx", expect.any(Function), "owner");
			cleanup();
		}
	});

	it("asks before closing the session tab with unsaved work, then completes the close", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		lifecycle.isDirty.mockReturnValue(true);
		const tabKey = previewTabKey({ path: "report.docx", workspaceId: "owner" });
		act(() => { workspaceStore.closePreview(tabKey); });
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["report.docx", "other.docx"]);
		const confirm = screen.getByRole("dialog", { name: "wordEditor.closeTitle" });
		// The confirmation is scoped to the document pane (in-place render), so it
		// centers on the pane instead of the window and masks only that pane.
		expect(confirm.closest(".inno-workspace-preview-pane")).toBeTruthy();
		expect(confirm.classList.contains("inno-word-confirm-dialog")).toBe(true);
		expect(confirm.querySelector(".inno-word-confirm-card")).toBeTruthy();
		expect(lifecycle.unmount).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.discard" }));
		await waitFor(() => expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["other.docx"]));
		expect(screen.queryByLabelText("Word editor")).toBeNull();
		expect(lifecycle.unmount).toHaveBeenCalledOnce();
	});

	it("ends a clean session when its tab closes, without a confirmation", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		lifecycle.isDirty.mockReturnValue(false);
		act(() => { workspaceStore.closePreview(previewTabKey({ path: "report.docx", workspaceId: "owner" })); });
		await waitFor(() => expect(lifecycle.unmount).toHaveBeenCalledOnce());
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["other.docx"]);
		expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull();
	});

	it("opens a second document as a parallel session and keeps the dirty draft", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		lifecycle.isDirty.mockReturnValue(true);
		act(() => { workspaceStore.activatePreview(previewTabKey({ workspaceId: "other", path: "other.docx" })); });
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(screen.getAllByLabelText("Word editor")).toHaveLength(2));
		// Parallel sessions need no replacement confirmation: the dirty draft
		// survives in its hidden editor while the second document opens.
		expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull();
		expect(lifecycle.unmount).not.toHaveBeenCalled();
		const editors = screen.getAllByLabelText("Word editor");
		expect((editors[1].parentElement as HTMLElement).className).not.toContain("invisible");
		expect(editors[1].textContent).toContain("other:other.docx");
		expect((editors[0].parentElement as HTMLElement).className).toContain("invisible");
		expect(editors[0].textContent).toContain("owner:report.docx");
		expect(lifecycle.mount).toHaveBeenCalledTimes(2);
	});

	it("saves the draft before completing the guarded tab close", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		lifecycle.isDirty.mockReturnValue(true);
		lifecycle.save.mockResolvedValue(true);
		act(() => { workspaceStore.closePreview(previewTabKey({ path: "report.docx", workspaceId: "owner" })); });
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["report.docx", "other.docx"]);
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
		await waitFor(() => expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["other.docx"]));
		expect(lifecycle.save).toHaveBeenCalledOnce();
		expect(lifecycle.unmount).toHaveBeenCalledOnce();
	});

	it("closing the last file tab via save-and-close returns to a start page, not an empty pane", async () => {
		const file: WorkspaceFileDetail = { path: "report.docx", name: "report.docx", kind: "office", format: "docx", mimeType: "", size: 100, updatedAt: "now" };
		workspaceStore.previewTabs = [{ path: file.path, name: file.name, workspaceId: "owner", file, isLoading: false, isEditing: false, editBuffer: "", isSaving: false, error: "", requestId: 1 }];
		workspaceStore.activePreviewPath = previewTabKey({ path: file.path, workspaceId: "owner" });
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Word editor");
		lifecycle.isDirty.mockReturnValue(true);
		lifecycle.save.mockResolvedValue(true);
		act(() => { workspaceStore.closePreview(previewTabKey({ path: file.path, workspaceId: "owner" })); });
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
		await waitFor(() => expect(workspaceStore.previewTabs).toHaveLength(1));
		expect(isStartTab(workspaceStore.previewTabs[0])).toBe(true);
		expect(isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
		expect(lifecycle.save).toHaveBeenCalledWith("owner:report.docx");
		expect(lifecycle.unmount).toHaveBeenCalledOnce();
		// The pane must show start-page content instead of an empty body.
		await waitFor(() => expect(document.querySelector(".inno-workspace-preview-pane")?.textContent).not.toBe(""));
	});

	const openEditorFor = async (path: string, workspaceId: string) => {
		act(() => { workspaceStore.activatePreview(previewTabKey({ path, workspaceId })); });
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(screen.getAllByLabelText("Word editor").some((editor) => editor.textContent?.includes(`${workspaceId}:${path}`))).toBe(true));
	};

	it("keeps both sessions mounted and restores visibility across repeated tab switches", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		await openEditorFor("report.docx", "owner");
		await openEditorFor("other.docx", "other");
		expect(lifecycle.mount).toHaveBeenCalledTimes(2);
		for (const turn of [previewTabKey({ path: "report.docx", workspaceId: "owner" }), previewTabKey({ path: "other.docx", workspaceId: "other" }), previewTabKey({ path: "report.docx", workspaceId: "owner" })]) {
			act(() => { workspaceStore.activatePreview(turn); });
			const editors = screen.getAllByLabelText("Word editor");
			expect(editors).toHaveLength(2);
			for (const editor of editors) {
				const isShown = editor.textContent?.includes(turn.includes("report") ? "owner:report.docx" : "other:other.docx");
				expect(editor.dataset.active).toBe(isShown ? "true" : "false");
				const layer = editor.parentElement as HTMLElement;
				expect(layer.className.includes("invisible")).toBe(!isShown);
				expect(layer.hasAttribute("inert")).toBe(!isShown);
			}
		}
		expect(lifecycle.mount).toHaveBeenCalledTimes(2);
		expect(lifecycle.unmount).not.toHaveBeenCalled();
	});

	it("holds independent sessions for the same path in different workspaces", async () => {
		const file: WorkspaceFileDetail = { path: "report.docx", name: "report.docx", kind: "office", format: "docx", mimeType: "", size: 100, updatedAt: "now" };
		const tab = { path: file.path, name: file.name, workspaceId: "owner", file, isLoading: false, isEditing: false, editBuffer: "", isSaving: false, error: "", requestId: 1 };
		workspaceStore.previewTabs = [tab, { ...tab, workspaceId: "other" }];
		workspaceStore.activePreviewPath = previewTabKey(tab);
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		await openEditorFor("report.docx", "owner");
		await openEditorFor("report.docx", "other");
		const editors = screen.getAllByLabelText("Word editor");
		expect(editors[0].textContent).toContain("owner:report.docx");
		expect(editors[1].textContent).toContain("other:report.docx");
		expect(lifecycle.unmount).not.toHaveBeenCalled();
	});

	it("closing one dirty document confirms only that file and leaves the other session running", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		await openEditorFor("report.docx", "owner");
		await openEditorFor("other.docx", "other");
		lifecycle.isDirty.mockReturnValue(true);
		act(() => { workspaceStore.closePreview(previewTabKey({ path: "report.docx", workspaceId: "owner" })); });
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["report.docx", "other.docx"]);
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.discard" }));
		await waitFor(() => expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["other.docx"]));
		await waitFor(() => expect(lifecycle.unmount).toHaveBeenCalledOnce());
		const survivor = screen.getByLabelText("Word editor");
		expect(survivor.textContent).toContain("other:other.docx");
		expect(survivor.dataset.active).toBe("true");
		expect(lifecycle.unmount).toHaveBeenCalledOnce();
		expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull();
	});

	it("a close-time save that settles after switching tabs still saves and closes its own file", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		await openEditorFor("report.docx", "owner");
		await openEditorFor("other.docx", "other");
		lifecycle.isDirty.mockReturnValue(true);
		let finish!: () => void;
		lifecycle.save.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
		act(() => { workspaceStore.closePreview(previewTabKey({ path: "report.docx", workspaceId: "owner" })); });
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
		// The save is still in flight while the user moves on to the other document.
		act(() => { workspaceStore.activatePreview(previewTabKey({ path: "other.docx", workspaceId: "other" })); });
		finish();
		await waitFor(() => expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["other.docx"]));
		expect(lifecycle.save).toHaveBeenCalledWith("owner:report.docx");
		expect(lifecycle.save).toHaveBeenCalledTimes(1);
		expect(lifecycle.unmount).toHaveBeenCalledOnce();
		expect(screen.getByLabelText("Word editor").textContent).toContain("other:other.docx");
	});

	it("keeps both sessions when a close-time save fails", async () => {
		render(<InnoDndProvider><Browser /></InnoDndProvider>);
		await openEditorFor("report.docx", "owner");
		await openEditorFor("other.docx", "other");
		lifecycle.isDirty.mockReturnValue(true);
		lifecycle.save.mockResolvedValueOnce(false);
		act(() => { workspaceStore.closePreview(previewTabKey({ path: "report.docx", workspaceId: "owner" })); });
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "wordEditor.closeTitle" })).toBeNull());
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["report.docx", "other.docx"]);
		expect(lifecycle.unmount).not.toHaveBeenCalled();
	});
});
