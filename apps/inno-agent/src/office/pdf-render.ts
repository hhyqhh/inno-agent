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
 * `<name>-p<n>.png`. Returns the written PNG paths in page order.
 */
export async function renderPdfToPngs(
	pdfPath: string,
	outDir: string,
	options: PdfRenderOptions = {},
): Promise<string[]> {
	const scale = options.scale ?? 1.5;
	const maxPages = options.maxPages ?? 5;
	await mkdir(outDir, { recursive: true });

	const library = await getLibrary();
	const doc = await library.loadDocument(new Uint8Array(await readFile(pdfPath)));
	try {
		const written: string[] = [];
		const stem = basename(pdfPath).replace(/\.pdf$/i, "");
		for (const page of doc.pages()) {
			if (written.length >= maxPages) break;
			const png = await page.render({
				scale,
				render: async ({ data, width, height }) => {
                    // PDFium's wrapper renders with REVERSE_BYTE_ORDER, so
                    // its callback already receives RGBA (verified by a real
                    // red-page raster test); do not swap these channels again.
                    const out = await sharp(Buffer.from(data), {
						raw: { width, height, channels: 4 },
					})
						.flatten({ background: "#ffffff" })
						.png({ compressionLevel: 6 })
						.toBuffer();
					return new Uint8Array(out);
				},
			});
			const outPath = await resolveContainedPathAsync(outDir, `${stem}-p${page.number + 1}.png`);
			if (!outPath) throw new Error("Invalid render output path");
			await writeFile(outPath, png.data);
			written.push(outPath);
		}
		return written;
	} finally {
		doc.destroy();
	}
}
