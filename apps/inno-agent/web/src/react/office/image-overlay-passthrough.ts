/**
 * BetterOffice renders a move-drag layer over the whole selected image's rect
 * (`cursor: grab; pointer-events: auto; z-index: 15`) inside its
 * `.image-selection-overlay`, so a selected image can be dragged to move it.
 * Documents anchored with a full-page behind-text background image (extent
 * equal to the page size, `behindDoc="1"`) make that rect the entire page:
 * from the moment the background gets selected — one click on the poster area
 * — the drag layer blankets the page, every body-text hover shows the grab
 * hand, and mousedown arms an image drag above the engine's text-first hit
 * test. Verified against @betteroffice/docx-react 0.4.3: the layer's geometry
 * is exactly the selected image's rect, while the engine's own mousedown
 * routing still resolves clicks by page coordinates and correctly prefers
 * text. So when the drag layer covers (nearly) the whole page under it, make
 * that one layer pointer-inert: hover and clicks fall through to the canvas,
 * while the selection border and the resize handles (their own pointer-events)
 * keep working. Drag layers of regular-sized images are left untouched.
 *
 * The overlay portals next to the pages scroll area (not inside
 * `.canvas-page`), so the page box is looked up by geometry: the page whose
 * rect contains the layer's centre.
 */

const COVER_RATIO = 0.9;

/** True when the drag layer's rect blankets the page it floats over. */
export function dragLayerCoversPage(layer: DOMRect, page: DOMRect): boolean {
	if (page.width <= 0 || page.height <= 0 || layer.width <= 0 || layer.height <= 0) return false;
	return layer.width >= page.width * COVER_RATIO && layer.height >= page.height * COVER_RATIO;
}

function pageUnderLayer(scope: Element, layer: Element): Element | null {
	const rect = layer.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const x = rect.x + rect.width / 2;
	const y = rect.y + rect.height / 2;
	for (const page of scope.querySelectorAll(".canvas-page")) {
		const pr = page.getBoundingClientRect();
		if (pr.width <= 0 || pr.height <= 0) continue;
		if (x >= pr.x && x <= pr.x + pr.width && y >= pr.y && y <= pr.y + pr.height) return page;
	}
	return null;
}

/**
 * Apply the pass-through to one overlay when needed. Returns whether the drag
 * layer was made pointer-inert. React owns the layer's inline style and resets
 * it on every re-render, so callers must re-run this whenever the overlay's
 * `style` attribute changes.
 */
export function relaxImageOverlayDragLayer(overlay: Element): boolean {
	// The overlay holds the selection border (pointer-inert), the drag layer,
	// and the resize handles; only the drag layer is directly hit-testable.
	const layer = [...overlay.children].find(
		(child) => child.getAttribute("data-handle") === null && getComputedStyle(child).pointerEvents === "auto",
	);
	if (!layer) return false;
	const scope = overlay.closest(".docx-editor");
	const page = scope ? pageUnderLayer(scope, layer) : null;
	if (!page) return false;
	if (!dragLayerCoversPage(layer.getBoundingClientRect(), page.getBoundingClientRect())) return false;
	// Already inert: our earlier pass, or the engine changed its own design.
	// React rewrites the layer's inline style on re-render, so never trust a
	// marker — the live inline value is the state we and the engine share.
	if ((layer as HTMLElement).style.pointerEvents === "none") return false;
	(layer as HTMLElement).style.pointerEvents = "none";
	return true;
}

/**
 * Watch the editor root and keep full-page image drag layers pointer-inert.
 * Returns a cleanup that disconnects the observer.
 */
export function watchImageOverlayPassthrough(root: HTMLElement): () => void {
	const pass = () => {
		for (const overlay of root.querySelectorAll(".image-selection-overlay")) relaxImageOverlayDragLayer(overlay);
	};
	const observer = new MutationObserver(() => {
		if (root.isConnected) pass();
	});
	// The engine rewrites the drag layer's inline style on selection changes,
	// which silently restores `pointer-events: auto`; style mutations re-arm us.
	observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
	pass();
	return () => observer.disconnect();
}
