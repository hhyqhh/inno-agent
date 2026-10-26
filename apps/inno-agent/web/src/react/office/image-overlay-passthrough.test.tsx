import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dragLayerCoversPage, relaxImageOverlayDragLayer, watchImageOverlayPassthrough } from "./image-overlay-passthrough.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }) as DOMRect;
const PAGE = rect(0, 0, 794, 1123);

/** Engine-shaped overlay: the layer portals next to the pages area, outside
    `.canvas-page`; the border box is inert, then the grab layer, then handles. */
const buildOverlay = (dragRect: DOMRect, pageRect: DOMRect = PAGE) => {
	const container = document.createElement("div");
	container.className = "docx-editor";
	const pages = document.createElement("div");
	pages.className = "canvas-pages";
	const page = document.createElement("div");
	page.className = "canvas-page";
	pages.append(page);
	const overlay = document.createElement("div");
	overlay.className = "image-selection-overlay canvas-image-selection-overlay";
	const border = document.createElement("div");
	border.style.pointerEvents = "none";
	const drag = document.createElement("div");
	drag.style.pointerEvents = "auto";
	drag.style.cursor = "grab";
	const handle = document.createElement("div");
	handle.setAttribute("data-handle", "nw");
	handle.style.pointerEvents = "auto";
	overlay.append(border, drag, handle);
	container.append(pages, overlay);
	vi.spyOn(page, "getBoundingClientRect").mockReturnValue(pageRect);
	vi.spyOn(drag, "getBoundingClientRect").mockReturnValue(dragRect);
	return { container, overlay, drag, handle };
};

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("full-page image drag layer pass-through", () => {
	it("detects a drag layer that blankets its page", () => {
		expect(dragLayerCoversPage(rect(0, 0, 794, 1123), PAGE)).toBe(true);
		expect(dragLayerCoversPage(rect(0, 0, 790, 1120), PAGE)).toBe(true);
		expect(dragLayerCoversPage(rect(0, 0, 400, 1123), PAGE)).toBe(false);
		expect(dragLayerCoversPage(rect(0, 0, 794, 500), PAGE)).toBe(false);
		expect(dragLayerCoversPage(rect(0, 0, 794, 1123), rect(0, 0, 0, 0))).toBe(false);
	});

	it("makes a page-covering drag layer pointer-inert while handles stay hit-testable", () => {
		const { overlay, drag, handle } = buildOverlay(PAGE);
		expect(relaxImageOverlayDragLayer(overlay)).toBe(true);
		expect(drag.style.pointerEvents).toBe("none");
		expect(handle.style.pointerEvents).toBe("auto");
	});

	it("leaves regular-sized image drag layers untouched", () => {
		const { overlay, drag } = buildOverlay(rect(100, 100, 200, 120));
		expect(relaxImageOverlayDragLayer(overlay)).toBe(false);
		expect(drag.style.pointerEvents).toBe("auto");
	});

	it("skips overlays without a page under the layer and repeats safely on applied layers", () => {
		const stray = document.createElement("div");
		const overlay = document.createElement("div");
		const drag = document.createElement("div");
		drag.style.pointerEvents = "auto";
		overlay.append(drag);
		stray.append(overlay);
		vi.spyOn(drag, "getBoundingClientRect").mockReturnValue(PAGE);
		expect(relaxImageOverlayDragLayer(overlay)).toBe(false);
		expect(drag.style.pointerEvents).toBe("auto");

		// The layer centre sits outside every page of its editor.
		const { overlay: offPage, drag: offPageDrag } = buildOverlay(rect(2000, 4000, 794, 1123));
		expect(relaxImageOverlayDragLayer(offPage)).toBe(false);
		expect(offPageDrag.style.pointerEvents).toBe("auto");

		const { overlay: attached, drag: covering } = buildOverlay(PAGE);
		expect(relaxImageOverlayDragLayer(attached)).toBe(true);
		expect(relaxImageOverlayDragLayer(attached)).toBe(false);
		expect(covering.style.pointerEvents).toBe("none");
	});

	it("watches the editor root, re-applies after the engine resets the style, and stops on cleanup", async () => {
		const root = document.createElement("div");
		document.body.append(root);
		const stop = watchImageOverlayPassthrough(root);
		const { container, drag } = buildOverlay(PAGE);
		root.append(container);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(drag.style.pointerEvents).toBe("none");
		// The engine re-renders the overlay and restores its own inline style.
		drag.setAttribute("style", "position: absolute; pointer-events: auto; cursor: grab; z-index: 15;");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(drag.style.pointerEvents).toBe("none");
		stop();
		drag.setAttribute("style", "pointer-events: auto;");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(drag.style.pointerEvents).toBe("auto");
		root.remove();
	});
});
