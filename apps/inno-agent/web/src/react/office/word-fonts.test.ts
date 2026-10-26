import { describe, expect, it, vi } from "vitest";
import { configureWordFonts, createSystemFontLayer, matchSystemFace, wrapCjkBoldProvider, type SystemFontFace } from "./word-fonts.js";
import type { BundledFontProvider } from "@betteroffice/docx/layout";

const mocks = vi.hoisted(() => ({ configureDefaultFonts: vi.fn((_options?: unknown) => {}), createFontProvider: vi.fn((_options?: { baseUrl?: string | URL }) => ({ resolve: () => undefined })) }));
vi.mock("@betteroffice/docx-react", () => ({ configureDefaultFonts: mocks.configureDefaultFonts }));
vi.mock("@betteroffice/fonts", () => ({ createFontProvider: mocks.createFontProvider }));

const baseLoader = () => Promise.resolve(new ArrayBuffer(1));
const serifLoader = () => Promise.resolve(new ArrayBuffer(2));
const sansLoader = () => Promise.resolve(new ArrayBuffer(3));
const bytes = { serif: serifLoader, sans: sansLoader } as never;
const base = {
	resolve: vi.fn(() => baseLoader),
	resolveFamily: vi.fn(() => baseLoader),
	resolveScriptFallback: vi.fn(() => baseLoader),
	resolveLastResort: vi.fn(() => baseLoader),
} as unknown as BundledFontProvider & { resolve: ReturnType<typeof vi.fn>; resolveFamily: ReturnType<typeof vi.fn>; resolveScriptFallback: ReturnType<typeof vi.fn>; resolveLastResort: ReturnType<typeof vi.fn> };
const wrapped = () => wrapCjkBoldProvider(base, (face) => (bytes[face] as () => Promise<ArrayBuffer>)());

describe("CJK bold font provider", () => {
	it("routes bold Simplified Chinese serif families to the real Bold face", async () => {
		const provider = wrapped();
		for (const family of ["宋体", "SimSun", " 仿宋 ", "KaiTi", "楷体_GB2312"]) {
			const loader = provider.resolve(family, true, false);
			expect((await loader?.())?.byteLength).toBe(2);
		}
		expect(base.resolve).not.toHaveBeenCalledWith(expect.anything(), true, false);
	});

	it("routes bold sans families and keeps regular, italic and Latin requests on the bundled provider", async () => {
		const provider = wrapped();
		expect((await provider.resolve("微软雅黑", true, false)?.())?.byteLength).toBe(3);
		expect((await provider.resolve("黑体", true, true)?.())?.byteLength).toBe(3);
		expect(provider.resolve("宋体", false, false)).toBe(baseLoader);
		expect(provider.resolve("宋体", false, true)).toBe(baseLoader);
		expect(provider.resolve("Times New Roman", true, false)).toBe(baseLoader);
	});

	it("answers resolveFamily for the bundled face names without substituting style for regular requests", async () => {
		const provider = wrapped();
		expect((await provider.resolveFamily?.("Noto Serif SC", true, false)?.())?.byteLength).toBe(2);
		expect((await provider.resolveFamily?.("Noto Sans SC", true, false)?.())?.byteLength).toBe(3);
		expect(provider.resolveFamily?.("Noto Serif SC", false, false)).toBe(baseLoader);
		expect(provider.resolveFamily?.("Carlito", true, false)).toBe(baseLoader);
	});

	it("upgrades only the cjk-sc script fallback so other scripts keep upstream behavior", async () => {
		const provider = wrapped();
		expect((await provider.resolveScriptFallback?.("cjk-sc", true, false)?.())?.byteLength).toBe(3);
		expect(provider.resolveScriptFallback?.("cjk-sc", false, false)).toBe(baseLoader);
		expect(provider.resolveScriptFallback?.("cjk-tc", true, false)).toBe(baseLoader);
		expect(provider.resolveScriptFallback?.("arabic", true, false)).toBe(baseLoader);
	});

	it("passes the last-resort chain through untouched", () => {
		const office = "word" as const;
		wrapped().resolveLastResort?.("Wingdings", true, false, office);
		expect(base.resolveLastResort).toHaveBeenCalledWith("Wingdings", true, false, office);
	});

	it("configures the default font source once through a wrapped shim module", async () => {
		configureWordFonts();
		configureWordFonts();
		expect(mocks.configureDefaultFonts).toHaveBeenCalledTimes(1);
		const shim = mocks.configureDefaultFonts.mock.calls[0][0] as { load: () => Promise<{ createFontProvider: (options?: { baseUrl?: string | URL }) => unknown }> };
		// The shim keeps the production lazy fetch; stub it because node has no
		// file: fetch. Serif Bold is ~11.5MB on disk, not in the test.
		const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 })));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const providerModule = await shim.load();
			expect(mocks.createFontProvider).not.toHaveBeenCalled();
			const provider = providerModule.createFontProvider() as BundledFontProvider;
			expect(mocks.createFontProvider).toHaveBeenCalledWith(undefined);
			// The shim must hand back the wrapper, not the raw provider, and the
			// loader must fetch the bundled Bold file from this module's directory.
			expect((await provider.resolve("宋体", true, false)?.())?.byteLength).toBe(8);
			// The system-font index is fetched first (and fails soft in the test), then the bundled Bold file.
			expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("NotoSerifSC-Bold.otf"))).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

const index: SystemFontFace[] = [
	{ family: "Songti SC", weight: 400, style: "normal", file: "0:Songti.ttc" },
	{ family: "宋体-简", weight: 300, style: "normal", file: "0:Songti.ttc" },
	{ family: "Times New Roman", weight: 400, style: "normal", file: "0:Times New Roman.ttf" },
	{ family: "Times New Roman", weight: 700, style: "italic", file: "0:Times New Roman Bold Italic.ttf" },
];

describe("system font layer", () => {
	it("matches Word names to the machine's faces through the alias table", () => {
		expect(matchSystemFace(index, "宋体", false, false)?.file).toBe("0:Songti.ttc");
		expect(matchSystemFace(index, "Times New Roman", true, true)?.file).toBe("0:Times New Roman Bold Italic.ttf");
		expect(matchSystemFace(index, "Calibri", false, false)).toBeUndefined();
	});
	it("skips regular-only families on bold requests so the bundled bold face can take over", () => {
		// 宋體-簡 in this index only ships Light (300): returning it for a bold
		// request is what rendered 试卷 titles un-bold.
		expect(matchSystemFace(index, "宋体", true, false)).toBeUndefined();
	});
	it("keeps walking aliases until a family with a real bold cut is found", () => {
		const withBold = [...index, { family: "SimSun", weight: 700, style: "normal" as const, file: "0:simsun-bold.ttf" }];
		expect(matchSystemFace(withBold, "宋体", true, false)?.file).toBe("0:simsun-bold.ttf");
	});
	it("prefix-matches localized names onto the shipped family", () => {
		// 宋体 aliases resolve to whichever Songti face the OS reports first.
		expect(matchSystemFace(index, "宋体", false, false)?.file).toBe("0:Songti.ttc");
	});
	it("serves loaders from the warmed snapshot and degrades to empty", async () => {
		const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify({ faces: index }), { status: 200 })));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const layer = createSystemFontLayer("/api/system/fonts", (file) => `bytes/${file}`);
			await layer.ready();
			const loader = layer.resolve("宋体", false, false);
			expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("/api/system/fonts");
			await loader?.();
			expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("bytes/0:Songti.ttc");
		} finally {
			vi.unstubAllGlobals();
		}
		const broken = createSystemFontLayer("/api/system/fonts");
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
		try {
			await broken.ready();
			expect(broken.resolve("宋体", false, false)).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
