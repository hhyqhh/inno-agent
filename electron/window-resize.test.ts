import { describe, expect, it } from "vitest";
import { getWindowResizeBounds } from "./window-resize.js";

const start = { x: 100, y: 80, width: 1200, height: 800 };
describe("window resize geometry", () => {
	it.each([
		["e", { x: 100, y: 80, width: 1220, height: 800 }],
		["w", { x: 120, y: 80, width: 1180, height: 800 }],
		["n", { x: 100, y: 110, width: 1200, height: 770 }],
		["s", { x: 100, y: 80, width: 1200, height: 830 }],
		["ne", { x: 100, y: 110, width: 1220, height: 770 }],
		["nw", { x: 120, y: 110, width: 1180, height: 770 }],
		["se", { x: 100, y: 80, width: 1220, height: 830 }],
		["sw", { x: 120, y: 80, width: 1180, height: 830 }],
	])("anchors the opposite side while dragging %s", (edge, expected) => {
		expect(getWindowResizeBounds(start, edge, { x: 20, y: 30 }, [612, 600], [0, 0])).toEqual(expected);
	});
	it("keeps the bottom/right anchor when hitting minimum or maximum size", () => {
		expect(getWindowResizeBounds(start, "nw", { x: 2000, y: 2000 }, [612, 600], [0, 0])).toEqual({ x: 688, y: 280, width: 612, height: 600 });
		expect(getWindowResizeBounds(start, "nw", { x: -2000, y: -2000 }, [612, 600], [1400, 1000])).toEqual({ x: -100, y: -120, width: 1400, height: 1000 });
	});
});
