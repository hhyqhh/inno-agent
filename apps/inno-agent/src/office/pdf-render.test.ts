import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	render: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) })),
	destroy: vi.fn(), getPage: vi.fn(),
}));
vi.mock("@hyzyla/pdfium", () => ({ PDFiumLibrary: { init: async () => ({ loadDocument: async () => ({
	getPageCount: () => 7, getPage: mocks.getPage, destroy: mocks.destroy,
}) }) } }));
import { renderPdfToPngs } from "./pdf-render.js";
let directory: string;
beforeEach(async () => {
	vi.clearAllMocks();
	directory = await mkdtemp(join(tmpdir(), "pdf-render-test-"));
	await writeFile(join(directory, "report.pdf"), "pdf");
	mocks.getPage.mockImplementation((index: number) => ({ number: index, render: mocks.render }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("renders the requested page batch with a total count for checking the rest", async () => {
	const output = join(directory, "pages");
	const result = await renderPdfToPngs(join(directory, "report.pdf"), output, { startPage: 3, maxPages: 2 });
	expect(result.totalPages).toBe(7);
	expect(mocks.getPage.mock.calls).toEqual([[2], [3]]);
	expect(await readdir(output)).toEqual(["report-p2.png", "report-p3.png"]);
	expect(await readFile(result.paths[0]!)).toEqual(Buffer.from([1, 2, 3]));
	expect(mocks.destroy).toHaveBeenCalledOnce();
});

it("releases the PDF document when rasterization fails", async () => {
	mocks.render.mockRejectedValueOnce(new Error("render failed"));
	await expect(renderPdfToPngs(join(directory, "report.pdf"), join(directory, "pages"))).rejects.toThrow("render failed");
	expect(mocks.destroy).toHaveBeenCalledOnce();
});
