/**
 * PDF page rasterization (PDF → PNG) for the Office render-check loop.
 *
 * Uses the WASM pdfium build (`@hyzyla/pdfium`, already pulled in by
 * liteparse) plus sharp to encode raw bitmaps as PNG. This is what lets a
 * vision-capable model *look at* a generated/edited Office document after
 * `office_render_document` produced its PDF — the equivalent of WorkBuddy's
 * `slidep lint --visual` step.
 *
 * The WASM library init is expensive (~100ms) and shared process-wide.
 */

import { basename } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import sharp from "sharp";

export interface PdfRenderOptions {
	/** Render scale; 1 = 72 DPI. Default 1.5 (≈108 DPI, enough for layout checks). */
	scale?: number;
	/** Cap on rendered pages. Default 5. */
	maxPages?: number;
	/** One-based first page, for inspecting long documents in bounded batches. */
	startPage?: number;
}

let libraryPromise: Promise<PDFiumLibrary> | null = null;

function getLibrary(): Promise<PDFiumLibrary> {
	if (!libraryPromise) {
		libraryPromise = PDFiumLibrary.init().catch((err) => {
			libraryPromise = null;
			throw err;
		});
	}
	return libraryPromise;
}

/**
 * Render up to `maxPages` pages of `pdfPath` into `outDir` as
 * `<name>-p<n>.png`. Returns the paths and total page count for batch checks.
 */
export async function renderPdfToPngs(
	pdfPath: string,
	outDir: string,
	options: PdfRenderOptions = {},
): Promise<{ paths: string[]; totalPages: number }> {
	const scale = options.scale ?? 1.5;
	const maxPages = options.maxPages ?? 5;
	await mkdir(outDir, { recursive: true });

	const library = await getLibrary();
	const doc = await library.loadDocument(new Uint8Array(await readFile(pdfPath)));
	try {
		const written: string[] = [];
		const stem = basename(pdfPath).replace(/\.pdf$/i, "");
		const totalPages = doc.getPageCount();
		const startIndex = Math.max(0, (options.startPage ?? 1) - 1);
		for (let index = startIndex; index < Math.min(totalPages, startIndex + maxPages); index++) {
			const page = doc.getPage(index);
			const png = await page.render({
				scale,
				render: async ({ data, width, height }) => {
					// pdfium emits BGRA; sharp expects channel-count matching the raw
					// buffer, so declare 4 channels and let the PNG encoder drop alpha.
					const out = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
						raw: { width, height, channels: 4 },
					})
						.flatten({ background: "#ffffff" })
						.png({ compressionLevel: 6 })
						.toBuffer();
					return new Uint8Array(out);
				},
			});
			const outPath = await resolveContainedPathAsync(outDir, `${stem}-p${page.number}.png`);
			if (!outPath) throw new Error("Invalid rendered page path");
			await writeFile(outPath, png.data);
			written.push(outPath);
		}
		return { paths: written, totalPages };
	} finally {
		doc.destroy();
	}
}
