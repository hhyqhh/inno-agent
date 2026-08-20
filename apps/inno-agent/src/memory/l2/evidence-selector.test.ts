import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: completeMock }));

import type { EvidenceBlock } from "./evidence-index.js";
import { createModelEvidenceSelector } from "./evidence-selector.js";

function modelResponse(value: unknown) {
	return {
		stopReason: "stop",
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
	};
}

function registry(apiKey = "test-key") {
	return {
		getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey, headers: { "x-test": "yes" } }),
	} as any;
}

function block(id: string, text: string): EvidenceBlock {
	return { id, kind: "markdown", text, paragraph: 1 };
}

const selectionInput = {
	pagePath: "wiki/concepts/forces.md",
	pageBody: "# Forces\n\nThe page explains balanced forces.",
	sourceId: "l2src_physics_001",
	blocks: [block("md:b0001:alpha", "Balanced forces have equal magnitude and opposite directions.")],
};

beforeEach(() => {
	completeMock.mockReset();
});

describe("createModelEvidenceSelector", () => {
	it("returns null unless both a model and registry are available", () => {
		expect(createModelEvidenceSelector(undefined, registry())).toBeNull();
		expect(createModelEvidenceSelector({} as any, undefined)).toBeNull();
	});

	it("selects only exact candidate objects whose quotes stay inside the supplied block", async () => {
		completeMock.mockResolvedValue(modelResponse({
			candidates: [{
				source_id: selectionInput.sourceId,
				block_id: selectionInput.blocks[0].id,
				quote: "equal magnitude and opposite directions",
			}],
		}));
		const selector = createModelEvidenceSelector({ id: "model" } as any, registry())!;

		await expect(selector.select(selectionInput)).resolves.toEqual([{
			source_id: selectionInput.sourceId,
			block_id: selectionInput.blocks[0].id,
			quote: "equal magnitude and opposite directions",
		}]);

		expect(completeMock).toHaveBeenCalledOnce();
		const prompt = completeMock.mock.calls[0][1].messages[0].content[0].text as string;
		expect(prompt).toContain(selectionInput.pagePath);
		expect(prompt).toContain(selectionInput.pageBody);
		expect(prompt).toContain(selectionInput.blocks[0].text);
		expect(prompt).toContain("source_id");
		expect(prompt).toContain("block_id");
	});

	it.each([
		["extra locator", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id, quote: "Balanced forces", locator: { kind: "markdown-block" } }],
		["extra path", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id, quote: "Balanced forces", path: "raw/private.md" }],
		["extra page", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id, quote: "Balanced forces", page: 1 }],
		["missing quote", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id }],
		["wrong source", { source_id: "l2src_other", block_id: selectionInput.blocks[0].id, quote: "Balanced forces" }],
		["unknown block", { source_id: selectionInput.sourceId, block_id: "md:missing", quote: "Balanced forces" }],
		["out-of-block quote", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id, quote: "not present in the source block" }],
		["oversized quote", { source_id: selectionInput.sourceId, block_id: selectionInput.blocks[0].id, quote: "x".repeat(501) }],
	] as const)("rejects an invalid model candidate: %s", async (_label, candidate) => {
		completeMock.mockResolvedValue(modelResponse({ candidates: [candidate] }));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.select(selectionInput)).resolves.toEqual([]);
	});

	it.each([
		["bad JSON", "not-json"],
		["a fenced guess", "```json\n{\"candidates\": []}\n```"],
		["an array root", JSON.stringify([])],
		["an extra root key", JSON.stringify({ candidates: [], explanation: "private reasoning" })],
		["a non-array candidate field", JSON.stringify({ candidates: {} })],
	] as const)("returns no candidates for %s", async (_label, text) => {
		completeMock.mockResolvedValue(modelResponse(text));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.select(selectionInput)).resolves.toEqual([]);
	});

	it("returns no candidates for empty output, missing auth, model errors, or thrown calls", async () => {
		const selector = createModelEvidenceSelector({} as any, registry())!;

		completeMock.mockResolvedValueOnce(modelResponse({ candidates: [] }));
		await expect(selector.select(selectionInput)).resolves.toEqual([]);

		const noAuthSelector = createModelEvidenceSelector({} as any, registry(""))!;
		await expect(noAuthSelector.select(selectionInput)).resolves.toEqual([]);

		completeMock.mockResolvedValueOnce({ stopReason: "error", errorMessage: "provider failed", content: [] });
		await expect(selector.select(selectionInput)).resolves.toEqual([]);

		completeMock.mockRejectedValueOnce(new Error("network failed"));
		await expect(selector.select(selectionInput)).resolves.toEqual([]);
	});

	it("normalizes only the comparison view when checking block containment", async () => {
		const input = {
			...selectionInput,
			blocks: [block("md:b0001:nfc", "Cafe\u0301\nkeeps   exact spacing")],
		};
		completeMock.mockResolvedValue(modelResponse({
			candidates: [{ source_id: input.sourceId, block_id: input.blocks[0].id, quote: "Caf\u00e9 keeps exact spacing" }],
		}));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.select(input)).resolves.toHaveLength(1);
	});

	it("batches long evidence by complete blocks without truncating a block", async () => {
		const firstText = `FIRST-BEGIN ${"a".repeat(15_000)} FIRST-END`;
		const secondText = `SECOND-BEGIN ${"b".repeat(15_000)} SECOND-END`;
		const input = {
			...selectionInput,
			blocks: [block("md:first", firstText), block("md:second", secondText)],
		};
		completeMock.mockResolvedValue(modelResponse({ candidates: [] }));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.select(input)).resolves.toEqual([]);
		expect(completeMock).toHaveBeenCalledTimes(2);
		const prompts = completeMock.mock.calls.map((call) => call[1].messages[0].content[0].text as string);
		expect(prompts[0]).toContain(firstText);
		expect(prompts[0]).not.toContain("SECOND-BEGIN");
		expect(prompts[1]).toContain(secondText);
		expect(prompts[1]).not.toContain("FIRST-BEGIN");
	});

	it("keeps valid batch results if a later batch is malformed", async () => {
		const input = {
			...selectionInput,
			blocks: [
				block("md:first", `First evidence ${"a".repeat(15_000)}`),
				block("md:second", `Second evidence ${"b".repeat(15_000)}`),
			],
		};
		completeMock
			.mockResolvedValueOnce(modelResponse({
				candidates: [{ source_id: input.sourceId, block_id: "md:first", quote: "First evidence" }],
			}))
			.mockResolvedValueOnce(modelResponse("not-json"));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.select(input)).resolves.toEqual([{
			source_id: input.sourceId,
			block_id: "md:first",
			quote: "First evidence",
		}]);
	});

	it("selects evidence for multiple wiki pages in one model call", async () => {
		const secondInput = {
			...selectionInput,
			pagePath: "wiki/concepts/motion.md",
			pageBody: "# Motion\n\nThe page explains opposite directions.",
		};
		completeMock.mockResolvedValue(modelResponse({
			pages: [
				{
					page_id: "page-1",
					candidates: [{
						source_id: selectionInput.sourceId,
						block_id: selectionInput.blocks[0].id,
						quote: "Balanced forces",
					}],
				},
				{
					page_id: "page-2",
					candidates: [{
						source_id: selectionInput.sourceId,
						block_id: selectionInput.blocks[0].id,
						quote: "opposite directions",
					}],
				},
			],
		}));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		expect(selector.selectMany).toBeTypeOf("function");
		await expect(selector.selectMany!([selectionInput, secondInput])).resolves.toEqual([
			{
				candidates: [{
					source_id: selectionInput.sourceId,
					block_id: selectionInput.blocks[0].id,
					quote: "Balanced forces",
				}],
				codes: [],
				rejected: 0,
			},
			{
				candidates: [{
					source_id: selectionInput.sourceId,
					block_id: selectionInput.blocks[0].id,
					quote: "opposite directions",
				}],
				codes: [],
				rejected: 0,
			},
		]);
		expect(completeMock).toHaveBeenCalledOnce();
		const prompt = completeMock.mock.calls[0][1].messages[0].content[0].text as string;
		expect(prompt).toContain(selectionInput.pagePath);
		expect(prompt).toContain(secondInput.pagePath);
	});

	it("keeps valid candidates beside malformed candidates and reports a safe code", async () => {
		completeMock.mockResolvedValue(modelResponse({
			pages: [{
				page_id: "page-1",
				candidates: [
					{
						source_id: selectionInput.sourceId,
						block_id: selectionInput.blocks[0].id,
						quote: "Balanced forces",
					},
					{
						source_id: selectionInput.sourceId,
						block_id: "md:invented",
						quote: "private model output must not be logged",
					},
				],
			}],
		}));
		const selector = createModelEvidenceSelector({} as any, registry())!;

		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [{
				source_id: selectionInput.sourceId,
				block_id: selectionInput.blocks[0].id,
				quote: "Balanced forces",
			}],
			codes: ["selector-malformed-response"],
			rejected: 1,
		}]);
	});

	it("distinguishes unavailable auth, provider errors, malformed output, and zero candidates", async () => {
		const noAuthSelector = createModelEvidenceSelector({} as any, registry(""))!;
		await expect(noAuthSelector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-auth-unavailable"],
			rejected: 1,
		}]);

		const selector = createModelEvidenceSelector({} as any, registry())!;
		completeMock.mockResolvedValueOnce({ stopReason: "error", errorMessage: "private provider text", content: [] });
		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-provider-error"],
			rejected: 1,
		}]);

		completeMock.mockRejectedValueOnce(new Error("private transport details"));
		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-error"],
			rejected: 1,
		}]);

		completeMock.mockResolvedValueOnce(modelResponse("private malformed model text"));
		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-malformed-response"],
			 rejected: 1,
		}]);

		completeMock.mockResolvedValueOnce({ stopReason: "stop", content: undefined });
		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-malformed-response"],
			rejected: 1,
		}]);

		completeMock.mockResolvedValueOnce(modelResponse({
			pages: [{ page_id: "page-1", candidates: [] }],
		}));
		await expect(selector.selectMany!([selectionInput])).resolves.toEqual([{
			candidates: [],
			codes: ["selector-zero-candidates"],
			rejected: 0,
		}]);
	});
});
