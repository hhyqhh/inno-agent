import { describe, expect, it } from "vitest";

import { evidenceMarkersMatch, extractEvidenceMarkers, stripEvidenceMarkers } from "./evidence-markers.js";

describe("evidence markers", () => {
	it("ignores code, image labels, footnotes, and reference-link labels", () => {
		const body = "Claim [1]. `inline [2]`\n\n![3](image.png) [^4] [5][ref]\n\n[7]: https://example.com\n\n```md\n[6]\n```";

		expect(extractEvidenceMarkers(body)).toEqual({ markers: [1], invalid: false });
		expect(evidenceMarkersMatch(body, [1])).toBe(true);
		expect(stripEvidenceMarkers(body)).toBe("Claim . `inline [2]`\n\n![3](image.png) [^4] [5][ref]\n\n[7]: https://example.com\n\n```md\n[6]\n```");
	});

	it("rejects unsupported marker values outside the shared range", () => {
		expect(extractEvidenceMarkers("Claim [1000].")).toEqual({ markers: [], invalid: true });
		expect(evidenceMarkersMatch("Claim [1000].", [1000])).toBe(false);
	});

	it("rejects marker spellings wider than the UI's three-digit contract", () => {
		expect(extractEvidenceMarkers("Claim [0001].")).toEqual({ markers: [], invalid: true });
		expect(evidenceMarkersMatch("Claim [0001].", [1])).toBe(false);
	});
});
