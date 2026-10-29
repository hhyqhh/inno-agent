import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import PdfPreview from "./PdfPreview.js";

const state = vi.hoisted(() => ({ viewers: [] as any[], tasks: [] as any[], resize: undefined as (() => void) | undefined, disconnect: vi.fn(), navigateOutline: vi.fn(async () => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: {},
	getDocument: vi.fn(() => {
		const task = { promise: Promise.resolve({ numPages: 67, getOutline: async () => [{ title: "Chapter one", dest: "chapter-one", items: [{ title: "Section one", dest: "section-one", items: [] }] }] }), destroy: vi.fn(async () => {}) };
		state.tasks.push(task);
		return task;
	}),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
	EventBus: class {
		listeners = new Map<string, Set<(data?: any) => void>>();
		on(name: string, callback: () => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(callback); }
		off(name: string, callback: () => void) { this.listeners.get(name)?.delete(callback); }
		dispatch(name: string, data?: any) { this.listeners.get(name)?.forEach((callback) => callback(data)); }
	},
	PDFLinkService: class { setViewer() {} setDocument() {} goToDestination = state.navigateOutline; },
	PDFViewer: class {
		bus: any;
		pagesCount = 67;
		page = 1;
		scale = 1;
		preset = "";
		update = vi.fn();
		setDocument = vi.fn((document: unknown) => { if (document) this.bus.dispatch("pagesinit"); });
		constructor({ eventBus }: any) { this.bus = eventBus; state.viewers.push(this); }
		get currentPageNumber() { return this.page; }
		set currentPageNumber(value: number) { this.page = value; this.bus.dispatch("pagechanging", { pageNumber: value }); }
		get currentScale() { return this.scale; }
		set currentScale(value: number) { this.scale = value; this.preset = String(value); this.bus.dispatch("scalechanging", { scale: value }); }
		get currentScaleValue() { return this.preset; }
		set currentScaleValue(value: string) { this.preset = value; this.scale = 0.67; this.bus.dispatch("scalechanging", { scale: this.scale, presetValue: value }); }
	},
}));
import { getDocument } from "pdfjs-dist";

beforeEach(() => {
	state.viewers = [];
	state.tasks = [];
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { state.resize = callback; }
		observe() {}
		disconnect = state.disconnect;
	});
	vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; });

async function open() {
	const view = render(<PdfPreview url="/preview.pdf" name="report.docx" />);
	await waitFor(() => expect(screen.getByText("67%")).toBeTruthy());
	return view;
}
it.each(["light", "dark"])("uses app chrome and exposes no download/print actions in %s mode", async (theme) => {
	document.documentElement.dataset.theme = theme;
	await open();
	expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "/preview.pdf" }));
	expect(screen.getByRole("group", { name: "preview.pdfControls" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "preview.previousPage" }).hasAttribute("disabled")).toBe(true);
	expect(document.querySelector("iframe")).toBeNull();
	expect(screen.queryByRole("button", { name: /download|print/i })).toBeNull();
	document.documentElement.dataset.theme = theme === "dark" ? "light" : "dark";
	expect(state.tasks).toHaveLength(1);
});
it("navigates, validates page input and follows continuous scrolling", async () => {
	await open();
	const input = screen.getByRole("textbox", { name: "preview.currentPage" }) as HTMLInputElement;
	fireEvent.click(screen.getByRole("button", { name: "preview.nextPage" }));
	expect(input.value).toBe("2");
	fireEvent.change(input, { target: { value: "67" } });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(state.viewers[0].currentPageNumber).toBe(67);
	expect(screen.getByRole("button", { name: "preview.nextPage" }).hasAttribute("disabled")).toBe(true);
	for (const value of ["0", "68", "1.5", "garbage", ""]) {
		fireEvent.change(input, { target: { value } });
		fireEvent.blur(input);
		expect(input.value).toBe("67");
	}
	act(() => state.viewers[0].bus.dispatch("pagechanging", { pageNumber: 12 }));
	expect(input.value).toBe("12");
});
it("keeps fit-width on resize, preserves explicit zoom and restores fit-width", async () => {
	await open();
	const viewer = state.viewers[0];
	act(() => state.resize?.());
	expect(viewer.currentScaleValue).toBe("page-width");
	fireEvent.click(screen.getByRole("button", { name: "preview.zoomIn" }));
	expect(viewer.currentScale).toBeCloseTo(0.804);
	expect(screen.getByRole("button", { name: "preview.fitWidth" }).getAttribute("aria-pressed")).toBe("false");
	act(() => state.resize?.());
	expect(viewer.currentScale).toBeCloseTo(0.804);
	fireEvent.click(screen.getByRole("button", { name: "preview.fitWidth" }));
	expect(viewer.currentScaleValue).toBe("page-width");
	act(() => viewer.bus.dispatch("scalechanging", { scale: 4 }));
	expect(screen.getByRole("button", { name: "preview.zoomIn" }).hasAttribute("disabled")).toBe(true);
});
it("releases rendering, range requests, listeners and resize subscription on unmount", async () => {
	const view = await open();
	view.unmount();
	expect(state.tasks[0].destroy).toHaveBeenCalledOnce();
	expect(state.viewers[0].setDocument).toHaveBeenLastCalledWith(null);
	expect(state.disconnect).toHaveBeenCalledOnce();
	for (const listeners of state.viewers[0].bus.listeners.values()) expect(listeners.size).toBe(0);
});
it("offers a working retry after PDF loading fails", async () => {
	vi.mocked(getDocument).mockImplementationOnce(() => ({ promise: Promise.reject(new Error("bad PDF")), destroy: vi.fn(async () => {}) }) as any);
	render(<PdfPreview url="/preview.pdf" name="report.docx" />);
	expect(await screen.findByRole("alert")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "preview.wordRetry" }));
	await waitFor(() => expect(screen.getByText("67%")).toBeTruthy());
	expect(screen.queryByRole("alert")).toBeNull();
});
it("retains the document outline and nested destination navigation", async () => {
	await open();
	fireEvent.click(screen.getByRole("button", { name: "preview.documentNavigation" }));
	expect(screen.getByRole("complementary", { name: "preview.documentNavigation" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Chapter one", expanded: false }));
	fireEvent.click(screen.getByRole("button", { name: "Section one" }));
	expect(state.navigateOutline).toHaveBeenCalledWith("section-one");
	fireEvent.click(screen.getByRole("button", { name: "Chapter one", expanded: true }));
	expect(screen.queryByRole("button", { name: "Section one" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "preview.closeNavigation" }));
	expect(screen.queryByRole("complementary")).toBeNull();
});
it.each(["ctrlKey", "metaKey"])("handles document zoom shortcuts with %s and prevents browser zoom", async (modifier) => {
	await open();
	const viewport = screen.getByLabelText("preview.documentPages");
	const viewer = state.viewers[0];
	for (const key of ["=", "+"]) {
		const event = new KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true });
		fireEvent(viewport, event);
		expect(event.defaultPrevented).toBe(true);
	}
	expect(viewer.currentScale).toBeCloseTo(0.67 * 1.2 * 1.2);
	fireEvent.keyDown(viewport, { key: "-", [modifier]: true });
	expect(viewer.currentScale).toBeCloseTo(0.804);
	fireEvent.keyDown(viewport, { key: "0", [modifier]: true });
	expect(viewer.currentScale).toBe(1);
	fireEvent.click(screen.getByRole("button", { name: "preview.zoomIn" }));
	fireEvent.click(screen.getByRole("button", { name: "preview.resetZoom" }));
	expect(viewer.currentScale).toBe(1);
});
it("keeps text editing, directory tab navigation and shortcuts outside the preview untouched", async () => {
	await open();
	const input = screen.getByRole("textbox", { name: "preview.currentPage" });
	const event = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true, cancelable: true });
	fireEvent(input, event);
	expect(event.defaultPrevented).toBe(false);
	fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
	fireEvent.keyDown(screen.getByLabelText("preview.documentPages"), { key: "=", ctrlKey: true, altKey: true });
	expect(state.viewers[0].currentScale).toBe(0.67);
	fireEvent.click(screen.getByRole("button", { name: "preview.documentNavigation" }));
	fireEvent.keyDown(screen.getByRole("tab", { name: "preview.documentOutline" }), { key: "End" });
	expect(state.viewers[0].currentPageNumber).toBe(1);
});
it("supports page navigation keys only in the reading area", async () => {
	await open();
	const viewport = screen.getByLabelText("preview.documentPages");
	fireEvent.keyDown(viewport, { key: "PageDown" });
	expect(state.viewers[0].currentPageNumber).toBe(2);
	fireEvent.keyDown(viewport, { key: "PageUp" });
	expect(state.viewers[0].currentPageNumber).toBe(1);
	fireEvent.keyDown(viewport, { key: "End" });
	expect(state.viewers[0].currentPageNumber).toBe(67);
	fireEvent.keyDown(viewport, { key: "PageDown" });
	expect(state.viewers[0].currentPageNumber).toBe(67);
	fireEvent.keyDown(viewport, { key: "Home" });
	expect(state.viewers[0].currentPageNumber).toBe(1);
});
it("zooms the document with Ctrl+wheel, preserves normal scrolling and removes the listener on unmount", async () => {
	const view = await open();
	const viewport = screen.getByLabelText("preview.documentPages");
	const normal = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
	fireEvent(viewport, normal);
	expect(normal.defaultPrevented).toBe(false);
	expect(state.viewers[0].currentScale).toBe(0.67);
	const modified = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
	fireEvent(viewport, modified);
	expect(modified.defaultPrevented).toBe(true);
	expect(state.viewers[0].currentScale).toBeCloseTo(0.67 * Math.exp(0.2));
	view.unmount();
	const afterUnmount = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
	viewport.dispatchEvent(afterUnmount);
	expect(afterUnmount.defaultPrevented).toBe(false);
});
