import type { Core, CytoscapeOptions } from "cytoscape";
import { readFile } from "node:fs/promises";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/index.js";
import { notebookStore } from "../../stores/notebook-store.js";
import { renderWithTooltipProvider } from "../test-utils.js";
import { GraphView } from "./GraphView.js";

const renderer = vi.hoisted(() => ({ cy: null as Core | null }));

// Use real Cytoscape geometry/events and real force ticks, replacing only the
// canvas renderer and container measurements that jsdom cannot provide.
vi.mock("cytoscape", async (importOriginal) => {
	const { default: cytoscape } = await importOriginal<{ default: typeof import("cytoscape") }>();
	return {
		default: (options: CytoscapeOptions) => {
			const cy = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
			vi.spyOn(cy, "width").mockReturnValue(426);
			vi.spyOn(cy, "height").mockReturnValue(600);
			renderer.cy = cy;
			return cy;
		},
	};
});

let themeStyle: HTMLStyleElement;
let themeCss: string;

beforeAll(async () => {
	themeCss = await readFile("apps/inno-agent/web/src/themes.css", "utf8");
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
		matches: false, media: query, onchange: null,
		addListener: vi.fn(), removeListener: vi.fn(),
		addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
	})));
	themeStyle = document.createElement("style");
	themeStyle.textContent = themeCss;
	document.head.appendChild(themeStyle);
	Object.assign(notebookStore, {
		nodes: [
			{ id: "a", title: "Page A", type: "source", tags: [], community: 0 },
			{ id: "b", title: "Page B", type: "entity", tags: [], community: 0 },
			{ id: "c", title: "Page C", type: "concept", tags: [], community: 0 },
			{ id: "isolate", title: "Isolated page", type: "analysis", tags: [], community: 1 },
		],
		edges: [
			{ source: "a", target: "b", type: "link", weight: 1 },
			{ source: "b", target: "c", type: "link", weight: 1 },
		],
		selectedNodeId: null,
		searchQuery: "",
		isLoadingGraph: false,
		communities: null,
	});
});

afterEach(() => {
	cleanup();
	renderer.cy = null;
	themeStyle.remove();
	document.documentElement.removeAttribute("data-theme");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function settle() {
	act(() => vi.advanceTimersByTime(8_000));
}

describe("graph viewport interactions", () => {
	it("recenters after the force layout settles and does so only once", () => {
		renderWithTooltipProvider(<GraphView />);
		const cy = renderer.cy!;
		const initialPan = { ...cy.pan() };
		settle();
		expect(cy.zoom()).toBeGreaterThanOrEqual(1);
		expect(cy.pan()).not.toEqual(initialPan);
		const settledPan = { ...cy.pan() };
		settle();
		expect(cy.pan()).toEqual(settledPan);
	});

	it.each(["dragpan", "scrollzoom", "pinchzoom", "grab"])("preserves the user's camera after %s during layout", (gesture) => {
		renderWithTooltipProvider(<GraphView />);
		const cy = renderer.cy!;
		act(() => {
			cy.viewport({ zoom: 0.45, pan: { x: 12, y: 34 } });
			cy.emit(gesture);
		});
		settle();
		expect(cy.zoom()).toBe(0.45);
		expect(cy.pan()).toEqual({ x: 12, y: 34 });
	});

	it("keeps full-graph mode after layout and restores the default view on request", () => {
		renderWithTooltipProvider(<GraphView />);
		const cy = renderer.cy!;
		fireEvent.click(screen.getByRole("button", { name: "查看全图" }));
		const fullView = { zoom: cy.zoom(), pan: { ...cy.pan() } };
		expect(fullView.zoom).toBeLessThan(1);
		settle();
		expect(cy.zoom()).toBe(fullView.zoom);
		expect(cy.pan()).toEqual(fullView.pan);
		fireEvent.click(screen.getByRole("button", { name: "回到默认视图" }));
		expect(cy.zoom()).toBeGreaterThanOrEqual(1);
	});

	it("centers an existing selection after the layout settles", () => {
		notebookStore.selectedNodeId = "isolate";
		renderWithTooltipProvider(<GraphView />);
		settle();
		expect(renderer.cy!.getElementById("isolate").renderedPosition()).toEqual({ x: 213, y: 300 });
	});

	it("responds immediately to an external selection while the layout is running", () => {
		renderWithTooltipProvider(<GraphView />);
		act(() => notebookStore.selectNode("isolate"));
		expect(renderer.cy!.getElementById("isolate").renderedPosition()).toEqual({ x: 213, y: 300 });
		settle();
		expect(renderer.cy!.getElementById("isolate").renderedPosition()).toEqual({ x: 213, y: 300 });
	});

	it("reveals the hovered name without labelling every neighbor", () => {
		renderWithTooltipProvider(<GraphView />);
		const cy = renderer.cy!;
		act(() => cy.getElementById("b").emit("mouseover"));
		expect(cy.getElementById("b").style("label")).toBe("Page B");
		expect(cy.getElementById("a").style("label")).toBe("");
		expect(cy.getElementById("c").style("label")).toBe("");
		expect(cy.getElementById("a").hasClass("hl")).toBe(true);
		act(() => cy.getElementById("a").emit("mouseover"));
		expect(cy.getElementById("a").style("label")).toBe("Page A");
		expect(cy.nodes(".focus").length).toBe(1);
	});

	it.each([
		["light", "rgb(68,71,70)"],
		["dark", "rgb(197,197,197)"],
	])("keeps readable default labels and theme colors in %s", (theme, labelColor) => {
		document.documentElement.setAttribute("data-theme", theme);
		renderWithTooltipProvider(<GraphView />);
		settle();
		const node = renderer.cy!.getElementById("a");
		expect(Number(node.numericStyle("font-size")) * renderer.cy!.zoom()).toBeGreaterThanOrEqual(12);
		expect(node.style("color")).toBe(labelColor);
		expect(node.numericStyle("min-zoomed-font-size")).toBe(10);
	});
});
