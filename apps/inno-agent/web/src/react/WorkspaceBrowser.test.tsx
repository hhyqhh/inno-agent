import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDragDropManager } from "react-dnd";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { WorkspaceBrowser } from "./WorkspaceBrowser.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";

vi.mock("@earendil-works/pi-web-ui", () => ({}));
vi.mock("./LazyCodeEditor.js", () => ({
	LazyCodeEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => (
		<textarea aria-label="File editor" value={value} onChange={(event) => onChange(event.target.value)} />
	),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
	t: (key: string, fallback?: string) => typeof fallback === "string" ? fallback : key,
}) }));

function Browser({ onPreviewFile = vi.fn(), variant = "sidebar" }: { onPreviewFile?: (width: number) => void; variant?: "sidebar" | "workspace" | "preview" }) {
	const dndManager = useDragDropManager();
	return <WorkspaceBrowser variant={variant} dndManager={dndManager} onPreviewFile={onPreviewFile} />;
}

describe("Sidebar workspace browser", () => {
	const observed: Element[] = [];
	beforeEach(() => {
		observed.length = 0;
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		vi.stubGlobal("ResizeObserver", class {
			observe(element: Element) { observed.push(element); }
			unobserve() {}
			disconnect() {}
		});
		workspaceStore.tree = {
			name: "Project", path: "", root: "project", type: "directory",
			children: [
				{ name: "report.md", path: "report.md", type: "file", size: 100 },
				{ name: "photo.png", path: "photo.png", type: "file", size: 200 },
				{ name: "data.csv", path: "data.csv", type: "file", size: 300 },
				{ name: "docs", path: "docs", type: "directory", children: [
					{ name: "report.pdf", path: "docs/report.pdf", type: "file", size: 400 },
				] },
			],
		};
		workspaceStore.currentFile = null;
		workspaceStore.streamingPreview = null;
		workspaceStore.isLoadingFile = false;
		workspaceStore.isEditing = false;
		workspaceStore.isSaving = false;
		workspaceStore.editBuffer = "";
		workspaceStore.error = "";
		workspaceStore.isLoadingTree = false;
		workspaceStore.isMutating = false;
		workspaceStore.activeWorkspaceId = null;
		sessionsStore.currentSessionId = null;
		vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
		vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
		vi.spyOn(workspacesStore, "load").mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([300, 900])("shows the desktop preview without a duplicate file tree at %spx", (width) => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height: 700 } as DOMRect);
		workspaceStore.currentFile = {
			name: "report.txt", path: "report.txt", kind: "text", mimeType: "text/plain",
			size: 100, updatedAt: "2026-10-24T00:00:00.000Z", content: "Preview remains visible",
		};
		const { container } = render(<InnoDndProvider><Browser variant="preview" /></InnoDndProvider>);
		expect(screen.getByText("Preview remains visible")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
		expect(container.querySelector(".inno-workspace-tree-pane")).toBeNull();
		expect(screen.queryByRole("tree")).toBeNull();
		expect(screen.queryByRole("button", { name: "workspace.filters.all" })).toBeNull();
		expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
	});

	it("keeps editing and saving available in the desktop preview", () => {
		workspaceStore.currentFile = {
			name: "report.txt", path: "report.txt", kind: "text", mimeType: "text/plain",
			size: 100, updatedAt: "2026-10-24T00:00:00.000Z", content: "Original content",
		};
		const save = vi.spyOn(workspaceStore, "saveFile").mockResolvedValue();
		render(<InnoDndProvider><Browser variant="preview" /></InnoDndProvider>);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect((screen.getByRole("textbox", { name: "File editor" }) as HTMLTextAreaElement).value).toBe("Original content");
		fireEvent.change(screen.getByRole("textbox", { name: "File editor" }), { target: { value: "Edited content" } });
		expect(workspaceStore.editBuffer).toBe("Edited content");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("Original content")).toBeTruthy();
	});

	it("keeps generated content visible without a file tree or its toggle", () => {
		workspaceStore.streamingPreview = {
			id: "generated-preview", title: "Generated result", language: "text", content: "Generating result content",
			status: "streaming", source: "assistant", createdAt: 1, updatedAt: 1,
		};
		const { container } = render(<InnoDndProvider><Browser variant="preview" /></InnoDndProvider>);
		expect(screen.getByText("Generated result")).toBeTruthy();
		expect(screen.getByText("Generating result content")).toBeTruthy();
		expect(container.querySelector(".inno-workspace-tree-pane")).toBeNull();
		expect(screen.queryByRole("button", { name: /侧栏|sidebar/i })).toBeNull();
	});

	it("searches nested files, combines type filters, and opens files through the shared store", () => {
		const onPreviewFile = vi.fn();
		const { container } = render(<InnoDndProvider><Browser onPreviewFile={onPreviewFile} /></InnoDndProvider>);
		fireEvent.change(screen.getByRole("textbox", { name: "files.searchFiles" }), { target: { value: "report" } });
		expect(container.querySelectorAll("[data-ws-path]")).toHaveLength(2);
		fireEvent.click(container.querySelector('[data-ws-path="docs/report.pdf"]')!);
		expect(onPreviewFile).toHaveBeenCalledWith(560);
		expect(workspaceStore.selectFile).toHaveBeenCalledWith("docs/report.pdf");
		fireEvent.click(screen.getByRole("button", { name: "workspace.filters.images" }));
		expect(screen.getByText("files.noResults")).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "files.searchFiles" }), { target: { value: "" } });
		expect(container.querySelectorAll("[data-ws-path]")).toHaveLength(1);
		expect(container.querySelector('[data-ws-path="photo.png"]')).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "workspace.filters.all" }));
		const tree = container.querySelector(".workspace-scroll");
		expect(observed).toContain(tree);
	});

	it("keeps the sidebar as a file list even when there is room for a full content pane", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 900, height: 700 } as DOMRect);
		const { container } = render(<InnoDndProvider><Browser /></InnoDndProvider>);
		expect(container.querySelector(".inno-workspace-preview-pane")).toBeNull();
		expect(container.querySelector(".inno-workspace-selection-card")).toBeNull();
		expect(workspaceStore.loadTree).not.toHaveBeenCalled();
	});

	it.each(["sidebar", "workspace"] as const)("retains file attachment dragging in the %s browser", (variant) => {
		const { container } = render(<InnoDndProvider><Browser variant={variant} /></InnoDndProvider>);
		const row = container.querySelector<HTMLDivElement>('[data-ws-path="report.md"]')!;
		const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
		const dispatch = vi.spyOn(window, "dispatchEvent");
		const item = { name: "report.md", path: "report.md", source: "workspace" };

		expect(row.draggable).toBe(true);
		fireEvent.dragStart(row, { dataTransfer: transfer });
		expect(transfer.setData).toHaveBeenCalledWith("application/x-inno-file", JSON.stringify(item));
		expect(transfer.setData).toHaveBeenCalledWith("text/plain", "ws:report.md");
		expect(transfer.effectAllowed).toBe("copy");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "inno-smart-dragstart", detail: { items: [item] } }));
		fireEvent.dragEnd(row);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "inno-smart-dragend" }));
	});

	it("opens only one context menu when sidebar and right-panel browsers coexist", () => {
		const { container } = render(<InnoDndProvider><Browser /><Browser variant="workspace" /></InnoDndProvider>);
		const row = container.querySelector('[data-ws-path="report.md"]')!;
		fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
		expect(screen.getAllByRole("menu")).toHaveLength(1);
		expect(screen.getAllByRole("menuitem", { name: "Rename" })).toHaveLength(1);
	});
});
