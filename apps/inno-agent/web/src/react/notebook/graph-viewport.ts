import type { Core } from "cytoscape";

/** Keep the default view readable; fitting distant isolates is a separate action. */
export function focusDefaultGraph(cy: Core, selectedNodeId: string | null): void {
	const visible = cy.elements(":visible");
	const selected = selectedNodeId ? visible.nodes().getElementById(selectedNodeId) : cy.collection();
	const subject = selected.nonempty()
		? selected.closedNeighborhood().intersection(visible)
		: visible.components().reduce(
			(largest, component) => component.nodes().length > largest.nodes().length ? component : largest,
			cy.collection(),
		);
	if (subject.empty()) return;

	const bounds = subject.nodes().boundingBox({ includeLabels: false });
	const center = selected.nonempty() ? selected.position() : {
		x: (bounds.x1 + bounds.x2) / 2,
		y: (bounds.y1 + bounds.y2) / 2,
	};
	// A 12px label stays at least 12px in the default view. Large components
	// may extend outside the canvas, where users can reach them by panning.
	const zoom = Math.max(1, Math.min(1.25,
		(cy.width() - 64) / Math.max(bounds.w, 1),
		(cy.height() - 64) / Math.max(bounds.h, 1),
	));
	cy.viewport({
		zoom,
		pan: { x: cy.width() / 2 - center.x * zoom, y: cy.height() / 2 - center.y * zoom },
	});
}
