import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const trace = vi.hoisted(() => ({
	inputs: [] as unknown[],
	throwOnParse: false,
}));

vi.mock("@llamaindex/liteparse", () => ({
	LiteParse: class {
		async parse(input: unknown): Promise<{ text: string; pages: Array<{ pageNum: number; text: string }> }> {
			trace.inputs.push(input);
			if (trace.throwOnParse) throw new Error(`synthetic parser failure at ${String(input)}`);
			if (typeof input !== "string") throw new Error("DOCX parser input must be a path");
			if (readFileSync(input).toString("utf8") !== "synthetic docx bytes") {
				throw new Error("unexpected parser bytes");
			}
			return { text: "Converted DOCX", pages: [{ pageNum: 1, text: "Converted DOCX" }] };
		}
		async screenshot(): Promise<never[]> {
			return [];
		}
	},
}));

import { parseDocumentBytes } from "./document-parser.js";

afterEach(() => {
	trace.inputs = [];
	trace.throwOnParse = false;
});

describe("parseDocumentBytes", () => {
	it("cleans the private conversion input after parsing DOCX bytes", async () => {
		const result = await parseDocumentBytes("fixture.docx", Buffer.from("synthetic docx bytes", "utf8"));
		const input = trace.inputs[0];

		expect(result).toEqual({
			text: "Converted DOCX",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "Converted DOCX" }],
		});
		expect(typeof input).toBe("string");
		expect(input as string).toMatch(/input\.docx$/u);
		expect(existsSync(input as string)).toBe(false);
	});

	it("cleans the private conversion input when parsing fails", async () => {
		trace.throwOnParse = true;

		let thrown: unknown;
		try {
			await parseDocumentBytes("fixture.docx", Buffer.from("synthetic docx bytes", "utf8"));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({ code: "PARSE_ERROR", message: "Document parsing failed." });
		expect(typeof trace.inputs[0]).toBe("string");
		expect((thrown as Error).message).not.toContain(trace.inputs[0] as string);
		expect(existsSync(trace.inputs[0] as string)).toBe(false);
	});
});
