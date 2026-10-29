import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusDefaultGraph } from "./graph-viewport.js";

const graphs: Core[] = [];

function graph(elements: ElementDefinition[]): Core {
	const cy = cytoscape({
		headless: true,
		styleEnabled: true,
		layout: { name: "preset", fit: false },
		minZoom: 0.05,
		maxZoom: 2.5,
		style: [{ selector: ".hidden", style: { display: "none" } }],
		elements,
	});
	vi.spyOn(cy, "width").mockReturnValue(426);
	vi.spyOn(cy, "height").mockReturnValue(600);
	graphs.push(cy);
	return cy;
}

const nodes: ElementDefinition[] = [
	{ data: { id: "a" }, position: { x: -100, y: 0 } },
	{ data: { id: "b" }, position: { x: 0, y: 0 } },
	{ data: { id: "c" }, position: { x: 100, y: 0 } },
	{ data: { id: "isolate" }, position: { x: 5_000, y: 4_000 } },
];
const edges: ElementDefinition[] = [
	{ data: { id: "ab", source: "a", target: "b" } },
	{ data: { id: "bc", source: "b", target: "c" } },
];

afterEach(() => {
	for (const cy of graphs.splice(0)) cy.destroy();
	vi.restoreAllMocks();
});

describe("default graph viewport", () => {
	it("centers the main connected group without letting distant isolates shrink it", () => {
		const cy = graph([...nodes, ...edges]);
		focusDefaultGraph(cy, null);
		expect(cy.zoom()).toBeGreaterThanOrEqual(1);
		expect(cy.getElementById("b").renderedPosition()).toEqual({ x: 213, y: 300 });
		expect(cy.getElementById("isolate").renderedPosition().x).toBeGreaterThan(426);
	});

	it("keeps a large component readable rather than squeezing every node onto the canvas", () => {
		const cy = graph([
			{ data: { id: "a" }, position: { x: -2_000, y: 0 } },
			{ data: { id: "b" }, position: { x: 0, y: 0 } },
			{ data: { id: "c" }, position: { x: 2_000, y: 0 } },
			...edges,
		]);
		focusDefaultGraph(cy, null);
		expect(cy.zoom()).toBe(1);
		expect(cy.getElementById("b").renderedPosition()).toEqual({ x: 213, y: 300 });
	});

	it("prioritizes a selected node even in a different component", () => {
		const cy = graph([...nodes, ...edges]);
		focusDefaultGraph(cy, "isolate");
		expect(cy.getElementById("isolate").renderedPosition()).toEqual({ x: 213, y: 300 });
		expect(cy.zoom()).toBeLessThanOrEqual(1.25);
	});

	it.each(["missing", "isolate"])("falls back to visible content for unavailable selection %s", (selectedId) => {
		const cy = graph([...nodes.map((node) => node.data?.id === "isolate" ? { ...node, classes: "hidden" } : node), ...edges]);
		focusDefaultGraph(cy, selectedId);
		expect(cy.getElementById("b").renderedPosition()).toEqual({ x: 213, y: 300 });
	});

	it("leaves the viewport alone when all nodes are hidden", () => {
		const cy = graph(nodes.map((node) => ({ ...node, classes: "hidden" })));
		cy.viewport({ zoom: 0.5, pan: { x: 12, y: 34 } });
		focusDefaultGraph(cy, null);
		expect(cy.zoom()).toBe(0.5);
		expect(cy.pan()).toEqual({ x: 12, y: 34 });
	});

	it("still allows fitting the complete graph on demand", () => {
		const cy = graph([...nodes, ...edges]);
		focusDefaultGraph(cy, null);
		cy.fit(cy.elements(":visible"), 32);
		expect(cy.zoom()).toBeLessThan(1);
		for (const node of cy.nodes()) {
			const position = node.renderedPosition();
			expect(position.x).toBeGreaterThanOrEqual(32);
			expect(position.x).toBeLessThanOrEqual(394);
			expect(position.y).toBeGreaterThanOrEqual(32);
			expect(position.y).toBeLessThanOrEqual(568);
		}
	});
});
