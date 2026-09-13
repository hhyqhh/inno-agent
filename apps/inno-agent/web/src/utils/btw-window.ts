import type { BtwWindowGeometry } from "../types/btw.js";

export const BTW_DEFAULT_WIDTH = 520;
export const BTW_DEFAULT_HEIGHT = 420;
export const BTW_MIN_WIDTH = 360;
export const BTW_MIN_HEIGHT = 260;
export const BTW_MAX_VIEWPORT_RATIO = 0.7;
export const BTW_VIEWPORT_GAP = 24;

export type BtwResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export interface BtwViewportSize {
	width: number;
	height: number;
	composerClearance?: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

function effectiveBounds(viewport: BtwViewportSize) {
	const maxWidth = Math.max(1, viewport.width * BTW_MAX_VIEWPORT_RATIO);
	const maxHeight = Math.max(1, viewport.height * BTW_MAX_VIEWPORT_RATIO);
	return {
		minWidth: Math.min(BTW_MIN_WIDTH, maxWidth),
		minHeight: Math.min(BTW_MIN_HEIGHT, maxHeight),
		maxWidth,
		maxHeight,
	};
}

export function defaultBtwGeometry(viewport: BtwViewportSize): BtwWindowGeometry {
	const bounds = effectiveBounds(viewport);
	const width = clamp(BTW_DEFAULT_WIDTH, bounds.minWidth, bounds.maxWidth);
	const height = clamp(BTW_DEFAULT_HEIGHT, bounds.minHeight, bounds.maxHeight);
	const composerClearance = viewport.composerClearance ?? 88;
	return {
		x: Math.max(0, viewport.width - width - BTW_VIEWPORT_GAP),
		y: Math.max(0, viewport.height - height - composerClearance - BTW_VIEWPORT_GAP),
		width,
		height,
	};
}

export function constrainBtwGeometry(
	geometry: BtwWindowGeometry,
	viewport: BtwViewportSize,
): BtwWindowGeometry {
	const bounds = effectiveBounds(viewport);
	const width = clamp(geometry.width, bounds.minWidth, bounds.maxWidth);
	const height = clamp(geometry.height, bounds.minHeight, bounds.maxHeight);
	return {
		width,
		height,
		x: clamp(geometry.x, 0, viewport.width - width),
		y: clamp(geometry.y, 0, viewport.height - height),
	};
}

export function resizeBtwGeometry(
	geometry: BtwWindowGeometry,
	edge: BtwResizeEdge,
	deltaX: number,
	deltaY: number,
	viewport: BtwViewportSize,
): BtwWindowGeometry {
	const start = constrainBtwGeometry(geometry, viewport);
	const bounds = effectiveBounds(viewport);
	const startRight = start.x + start.width;
	const startBottom = start.y + start.height;
	const resizeWest = edge.includes("w");
	const resizeEast = edge.includes("e");
	const resizeNorth = edge.includes("n");
	const resizeSouth = edge.includes("s");

	let x = start.x;
	let width = start.width;
	if (resizeWest) {
		const minX = Math.max(0, startRight - bounds.maxWidth);
		const maxX = startRight - bounds.minWidth;
		x = clamp(start.x + deltaX, minX, maxX);
		width = startRight - x;
	} else if (resizeEast) {
		const minRight = start.x + bounds.minWidth;
		const maxRight = Math.min(viewport.width, start.x + bounds.maxWidth);
		const right = clamp(startRight + deltaX, minRight, maxRight);
		width = right - start.x;
	}

	let y = start.y;
	let height = start.height;
	if (resizeNorth) {
		const minY = Math.max(0, startBottom - bounds.maxHeight);
		const maxY = startBottom - bounds.minHeight;
		y = clamp(start.y + deltaY, minY, maxY);
		height = startBottom - y;
	} else if (resizeSouth) {
		const minBottom = start.y + bounds.minHeight;
		const maxBottom = Math.min(viewport.height, start.y + bounds.maxHeight);
		const bottom = clamp(startBottom + deltaY, minBottom, maxBottom);
		height = bottom - start.y;
	}

	return { x, y, width, height };
}

export function moveBtwGeometry(
	geometry: BtwWindowGeometry,
	deltaX: number,
	deltaY: number,
	viewport: BtwViewportSize,
): BtwWindowGeometry {
	// Normalize once before moving so an already min/max-sized window keeps
	// exactly that size throughout a drag. Resizing owns width/height changes.
	const start = constrainBtwGeometry(geometry, viewport);
	return {
		...start,
		x: clamp(start.x + deltaX, 0, viewport.width - start.width),
		y: clamp(start.y + deltaY, 0, viewport.height - start.height),
	};
}
