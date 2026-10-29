import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({ western: vi.fn(), cjk: vi.fn() }));
vi.mock("@docx-editor.dev/fonts", () => ({ packagedFonts: (options: { onFailure(): void }) => (request: unknown) => loaders.western({ ...options, ...request as object }) }));
vi.mock("@docx-editor.dev/fonts-cjk/browser", () => ({
	cjkFonts: (options: { onFailure(): void }) => (request: unknown) => loaders.cjk(options, request),
}));
vi.mock("@docx-editor.dev/core/editor", async importOriginal => ({
	...await importOriginal<typeof import("@docx-editor.dev/core/editor")>(),
	createFontSource: (bytes: Uint8Array, { faceIndex, ...request }: { faceIndex: number }, options: { id: string }) => ({ source: { bytes, request, id: options.id, hash: "sha256:test", faceIndex } }),
}));

beforeEach(() => {
	vi.resetModules(); vi.clearAllMocks();
	loaders.western.mockResolvedValue({ sources: [] });
	loaders.cjk.mockResolvedValue({ sources: [], substitutions: [] });
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ faces: [] }) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Word editor font resolution", () => {
	it("reuses an already admitted physical face across later localized picker requests", async () => {
		const { resolveLocalFonts } = await import("./word-editor-fonts.js");
		const read = vi.fn();
		const result = await resolveLocalFonts({ families: ["微软雅黑"], defaultFamily: "Calibri", resolvedFaces: [{ family: "Microsoft YaHei", weight: 400, style: "normal" }] }, [
			{ family: "Microsoft YaHei", aliases: ["微软雅黑"], weight: 400, style: "normal", id: "yahei", faceIndex: 0 },
		], read);
		expect(read).not.toHaveBeenCalled();
		expect(result.sources).toEqual([]);
		expect(result.substitutions).toContainEqual({ from: { family: "微软雅黑", weight: 400, style: "normal" }, to: { family: "Microsoft YaHei", weight: 400, style: "normal" } });
	});
	it("shares a completed font load across independent editor tabs", async () => {
		const { loadWordEditorFonts } = await import("./word-editor-fonts.js");
		const first = loadWordEditorFonts();
		expect(loadWordEditorFonts()).toBe(first);
		expect((await first).degraded).toBe(false);
		await loadWordEditorFonts();
		expect(loaders.western).not.toHaveBeenCalled();
		expect(loaders.cjk).not.toHaveBeenCalled();
		await (await first).configuration({ families: ["宋体"], defaultFamily: "Calibri" });
		expect(loaders.cjk.mock.calls[0][1].families).toContain("宋体");
	});

	it("allows a later open to retry fonts after a recoverable load failure", async () => {
		loaders.western.mockImplementationOnce(async ({ onFailure }) => { onFailure(); return { sources: [] }; });
		const { loadWordEditorFonts } = await import("./word-editor-fonts.js");
		const first = await loadWordEditorFonts();
		await first.configuration({ families: ["Calibri"], defaultFamily: "Calibri" });
		expect(first.degraded).toBe(true);
		const second = await loadWordEditorFonts();
		await second.configuration({ families: ["Calibri"], defaultFamily: "Calibri" });
		expect(second.degraded).toBe(false);
		expect(loaders.western).toHaveBeenCalledTimes(2);
	});

	it("keeps 宋体 and 黑体 distinct and requests the correct TTC face", async () => {
		const { resolveLocalFonts } = await import("./word-editor-fonts.js");
		const read = vi.fn(async () => new Uint8Array([1, 2]));
		const result = await resolveLocalFonts({ families: ["宋体", "黑体"], defaultFamily: "Calibri" }, [
			{ family: "SimSun", aliases: ["宋体"], weight: 400, style: "normal", id: "song", faceIndex: 1 },
			{ family: "SimHei", aliases: ["黑体"], weight: 400, style: "normal", id: "hei", faceIndex: 0 },
		], read);
		expect(result.sources?.map(s => s.request.family)).toEqual(["宋体", "黑体"]);
		expect(read.mock.calls).toHaveLength(2);
		expect(result.substitutions?.find(s => s.from.family === "宋体" && s.from.weight === 700)?.to.family).toBe("宋体");
	});

	it("supplies actual local bytes before packaged CJK substitution", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ faces: [
			{ family: "SimSun", aliases: ["宋体"], weight: 400, style: "normal", id: "song", faceIndex: 0 },
		] }) } as Response).mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) } as Response);
		const { loadWordEditorFonts } = await import("./word-editor-fonts.js");
		const fonts = await loadWordEditorFonts();
		const result = await fonts.configuration({ families: ["宋体"], defaultFamily: "Calibri" });
		expect(result?.sources?.[0].request.family).toBe("宋体");
		expect(loaders.cjk.mock.calls[0][1].resolvedFaces).toContainEqual({ family: "宋体", weight: 400, style: "normal" });
		await fonts.configuration({ families: ["宋体"], defaultFamily: "Calibri" });
		// one catalog + one shared local face + the four KaTeX_Size delimiter
		// faces, which load once per module lifetime (cached in mathDelimFaces).
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	it("shares one physical face for localized aliases and skips unused installed weights", async () => {
		const { resolveLocalFonts } = await import("./word-editor-fonts.js");
		const faces = [300, 400, 500, 600, 700, 900].map(weight => ({ family: "Source Han Serif SC", aliases: ["思源宋体"], weight, style: "normal" as const, id: `song-${weight}`, faceIndex: 0 }));
		const result = await resolveLocalFonts({ families: ["Source Han Serif SC", "思源宋体"], defaultFamily: "Calibri" }, faces, async () => new Uint8Array([1]));
		expect(result.sources).toHaveLength(2);
		expect(result.sources?.map(s => s.request.weight)).toEqual([400, 700]);
		expect(result.substitutions).toContainEqual({ from: { family: "思源宋体", weight: 700, style: "normal" }, to: { family: "Source Han Serif SC", weight: 700, style: "normal" } });
	});

	it("leaves missing or unreadable families available to the fallback resolver", async () => {
		const { resolveLocalFonts } = await import("./word-editor-fonts.js");
		const result = await resolveLocalFonts({ families: ["宋体", "missing"], defaultFamily: "Calibri" }, [
			{ family: "SimSun", aliases: ["宋体"], weight: 400, style: "normal", id: "song", faceIndex: 0 },
		], async () => { throw new Error("unreadable"); });
		expect(result.sources).toEqual([]);
		expect(result.substitutions).toEqual([]);
	});
});
