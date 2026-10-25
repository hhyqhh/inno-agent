import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { useDragDropManager } from "react-dnd";
import { workspaceStore, type WorkspacePreviewTab } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { WorkspaceBrowser } from "./WorkspaceBrowser.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";

vi.mock("@earendil-works/pi-web-ui", () => ({}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));

function Browser() {
	return <WorkspaceBrowser variant="preview" dndManager={useDragDropManager()} />;
}

function editingTab(path: string): WorkspacePreviewTab {
	return {
		path, name: path, isLoading: false, isEditing: true, isSaving: false, error: "", requestId: 1,
		editBuffer: `draft ${path}`,
		file: { path, name: path, kind: "text", mimeType: "text/plain", size: 10, updatedAt: "now", content: `original ${path}` },
	};
}

describe("Workspace preview editor isolation", () => {
	beforeEach(() => {
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
		// jsdom has no text layout; CodeMirror's measurement pass needs these APIs.
		Object.defineProperties(Range.prototype, {
			getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
			getClientRects: { configurable: true, value: () => [] },
		});
		workspaceStore.previewTabs = [editingTab("a.ts"), editingTab("b.ts")];
		workspaceStore.activePreviewPath = "a.ts";
		workspaceStore.streamingPreview = null;
		workspaceStore.error = "";
		workspaceStore.isLoadingTree = false;
		workspaceStore.activeWorkspaceId = null;
		sessionsStore.currentSessionId = null;
		vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
		vi.spyOn(workspacesStore, "load").mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		workspaceStore.previewTabs = [];
		workspaceStore.activePreviewPath = null;
		delete document.documentElement.dataset.theme;
		Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
		Reflect.deleteProperty(Range.prototype, "getClientRects");
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each(["light", "dark"])("does not undo into another file's content in the %s theme", async (theme) => {
		document.documentElement.dataset.theme = theme;
		const { container } = render(<InnoDndProvider><Browser /></InnoDndProvider>);
		const editor = () => EditorView.findFromDOM(container.querySelector(".cm-editor")! as HTMLElement)!;
		await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
		await waitFor(() => expect(editor().state.doc.toString()).toBe("draft a.ts"));
		act(() => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: "edited a.ts" } }));
		expect(workspaceStore.editBuffer).toBe("edited a.ts");
		act(() => workspaceStore.activatePreview("b.ts"));
		await waitFor(() => expect(editor().state.doc.toString()).toBe("draft b.ts"));
		let didUndo = false;
		act(() => { didUndo = undo(editor()); });
		expect(didUndo).toBe(false);
		expect(workspaceStore.editBuffer).toBe("draft b.ts");
		act(() => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: "edited b.ts" } }));
		act(() => { didUndo = undo(editor()); });
		expect(didUndo).toBe(true);
		expect(workspaceStore.editBuffer).toBe("draft b.ts");
		act(() => workspaceStore.activatePreview("a.ts"));
		await waitFor(() => expect(editor().state.doc.toString()).toBe("edited a.ts"));
	});
});
