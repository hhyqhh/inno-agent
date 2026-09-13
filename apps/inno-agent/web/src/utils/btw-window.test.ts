import { describe, expect, it } from "vitest";
import {
	constrainBtwGeometry,
	defaultBtwGeometry,
	moveBtwGeometry,
	resizeBtwGeometry,
} from "./btw-window.js";

describe("btw window geometry", () => {
	it("starts above the composer at the requested default size", () => {
		const geometry = defaultBtwGeometry({ width: 1200, height: 900, composerClearance: 88 });
		expect(geometry).toEqual({ x: 656, y: 368, width: 520, height: 420 });
	});

	it("clamps size to the minimum and 70 percent viewport bounds", () => {
		expect(constrainBtwGeometry(
			{ x: -50, y: -10, width: 1000, height: 1000 },
			{ width: 1000, height: 800 },
		)).toEqual({ x: 0, y: 0, width: 700, height: 560 });

		expect(constrainBtwGeometry(
			{ x: 0, y: 0, width: 10, height: 10 },
			{ width: 1000, height: 800 },
		)).toEqual({ x: 0, y: 0, width: 360, height: 260 });
	});

	it("keeps dragged windows inside the viewport", () => {
		const geometry = { x: 300, y: 200, width: 500, height: 300 };
		expect(moveBtwGeometry(geometry, 1000, 1000, { width: 1000, height: 800 })).toEqual({
			x: 500,
			y: 500,
			width: 500,
			height: 300,
		});
		expect(moveBtwGeometry(geometry, -1000, -1000, { width: 1000, height: 800 })).toEqual({
			x: 0,
			y: 0,
			width: 500,
			height: 300,
		});
	});

	it("resizes from the bottom-right while preserving the top-left anchor", () => {
		expect(resizeBtwGeometry(
			{ x: 40, y: 50, width: 520, height: 420 },
			"se",
			140,
			100,
			{ width: 1200, height: 900 },
		)).toEqual({ x: 40, y: 50, width: 660, height: 520 });
	});

	it("resizes from every edge and corner while preserving the opposite edges", () => {
		const geometry = { x: 40, y: 50, width: 520, height: 420 };
		const viewport = { width: 1200, height: 900 };

		expect(resizeBtwGeometry(geometry, "w", 100, 0, viewport)).toEqual({
			x: 140, y: 50, width: 420, height: 420,
		});
		expect(resizeBtwGeometry(geometry, "n", 0, 100, viewport)).toEqual({
			x: 40, y: 150, width: 520, height: 320,
		});
		expect(resizeBtwGeometry(geometry, "nw", 100, 100, viewport)).toEqual({
			x: 140, y: 150, width: 420, height: 320,
		});
		expect(resizeBtwGeometry(geometry, "e", 100, 0, viewport)).toEqual({
			x: 40, y: 50, width: 620, height: 420,
		});
		expect(resizeBtwGeometry(geometry, "s", 0, 100, viewport)).toEqual({
			x: 40, y: 50, width: 520, height: 520,
		});
		expect(resizeBtwGeometry(geometry, "sw", -40, 100, viewport)).toEqual({
			x: 0, y: 50, width: 560, height: 520,
		});
		expect(resizeBtwGeometry(geometry, "ne", 100, -50, viewport)).toEqual({
			x: 40, y: 0, width: 620, height: 470,
		});
	});

	it("keeps min/max dimensions fixed while moving", () => {
		const viewport = { width: 1000, height: 800 };
		const maxWidth = resizeBtwGeometry({ x: 100, y: 100, width: 520, height: 420 }, "e", 1000, 0, viewport);
		const minWidth = resizeBtwGeometry(maxWidth, "e", -1000, 0, viewport);

		expect(maxWidth.width).toBe(700);
		expect(moveBtwGeometry(maxWidth, 100, 100, viewport)).toMatchObject({ width: 700, height: 420 });
		expect(minWidth.width).toBe(360);
		expect(moveBtwGeometry(minWidth, -100, -100, viewport)).toMatchObject({ width: 360, height: 420 });
	});
});
