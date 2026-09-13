import { describe, expect, it } from "vitest";
import { positionModelMenu } from "./model-menu-position.js";

describe("positionModelMenu", () => {
	it.each([
		[320, 568], [375, 667], [390, 844], [430, 932], [768, 1024],
		[844, 390], [960, 800], [961, 800], [1440, 900], [320, 180],
	])("keeps a long menu within a %i × %i viewport", (width, height) => {
		for (const top of [0, height / 2, height - 40]) {
			for (const right of [12, width / 2, width + 100]) {
				const p = positionModelMenu({ top, bottom: top + 32, right },
					{ width, height, left: 0, top: 0 }, { width: 220, height: 820 });
				expect(p.left).toBeGreaterThanOrEqual(8);
				expect(p.top).toBeGreaterThanOrEqual(8);
				expect(p.left + p.maxWidth).toBeLessThanOrEqual(width - 8);
				expect(p.top + p.maxHeight).toBeLessThanOrEqual(height - 8);
				expect(p.maxHeight).toBeLessThanOrEqual(360);
			}
		}
	});

	it("anchors a short menu above the trigger when it fits", () => {
		const p = positionModelMenu({ top: 400, bottom: 432, right: 300 },
			{ width: 390, height: 844, left: 0, top: 0 }, { width: 220, height: 100 });
		expect(p.left).toBe(80);
		expect(p.top).toBe(292);
	});

	it("uses the space below a trigger near the top", () => {
		const p = positionModelMenu({ top: 20, bottom: 52, right: 300 },
			{ width: 390, height: 844, left: 0, top: 0 }, { width: 220, height: 100 });
		expect(p.top).toBe(60);
	});

	it("accounts for the visual viewport offset and reduced keyboard height", () => {
		const p = positionModelMenu({ top: 700, bottom: 732, right: 400 },
			{ width: 320, height: 240, left: 25, top: 350 }, { width: 220, height: 820 });
		expect(p.left).toBeGreaterThanOrEqual(33);
		expect(p.left + p.maxWidth).toBeLessThanOrEqual(337);
		expect(p.top).toBeGreaterThanOrEqual(358);
		expect(p.top + p.maxHeight).toBeLessThanOrEqual(582);
	});

	it("caps width on exceptionally narrow viewports", () => {
		const p = positionModelMenu({ top: 100, bottom: 132, right: 180 },
			{ width: 180, height: 300, left: 0, top: 0 }, { width: 220, height: 820 });
		expect(p.maxWidth).toBe(156);
		expect(p.left + p.maxWidth).toBeLessThanOrEqual(172);
	});
});
