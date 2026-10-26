/**
 * MathML → SVG typesetting through MathJax (offline, bundled; no CDN).
 *
 * The output is a standalone SVG image that the editor lays out like any
 * other picture. Sizes come from the MathJax viewBox, where 1000 internal
 * units are 1em of the typeset math — the `ex` width/height attributes assume
 * an ambient HTML font that does not exist here, so they are ignored.
 */
import type { MathRow } from "./omml-to-mathml.js";

interface Renderer {
	adaptor: { outerHTML(node: unknown): string };
	document: { convert(math: string, options: { display: boolean }): unknown };
}

let rendererPromise: Promise<Renderer> | null = null;

async function getRenderer(): Promise<Renderer> {
	if (!rendererPromise) {
		rendererPromise = (async () => {
			const [{ mathjax }, { MathML }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
				import("mathjax-full/js/mathjax.js"),
				import("mathjax-full/js/input/mathml.js"),
				import("mathjax-full/js/output/svg.js"),
				import("mathjax-full/js/adaptors/liteAdaptor.js"),
				import("mathjax-full/js/handlers/html.js"),
			]);
			const adaptor = liteAdaptor();
			RegisterHTMLHandler(adaptor);
			return { adaptor, document: mathjax.document("", { InputJax: new MathML(), OutputJax: new SVG({ fontCache: "none" }) }) };
		})();
	}
	return rendererPromise;
}

/** Natural size of one typeset row, in em units of the math itself. */
interface TypesetRow {
	svg: string;
	widthEm: number;
	heightEm: number;
	/** Depth of the row's baseline below its top, in em (ascent). */
	ascentEm: number;
}

const VIEWBOX = /viewBox="0\s+(-?[\d.]+)\s+([\d.]+)\s+([\d.]+)"/;

async function typeset(mathml: string, display: boolean): Promise<TypesetRow | null> {
	const renderer = await getRenderer();
	const node = renderer.document.convert(`<math xmlns="http://www.w3.org/1998/Math/MathML">${mathml}</math>`, { display });
	const html = renderer.adaptor.outerHTML(node);
	const start = html.indexOf("<svg");
	const end = html.lastIndexOf("</svg>");
	if (start < 0 || end < 0) return null;
	const svg = html.slice(start, end + "</svg>".length);
	// A MathML input error yields an merror node; keep OMML for those instead
	// of showing broken output.
	if (svg.includes('data-mml-node="error"') || svg.includes("merror")) return null;
	const match = VIEWBOX.exec(svg);
	if (!match) return null;
	const ascent = Number(match[1]);
	const width = Number(match[2]);
	const height = Number(match[3]);
	if (![ascent, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
	return { svg, widthEm: width / 1000, heightEm: height / 1000, ascentEm: ascent / 1000 };
}

/** Typeset the equation-number part of a row (Word's `#(n)` convention). */
async function typesetNumber(mathml: string): Promise<{ svg: string; widthEm: number; heightEm: number } | null> {
	const renderer = await getRenderer();
	const node = renderer.document.convert(`<math xmlns="http://www.w3.org/1998/Math/MathML">${mathml}</math>`, { display: false });
	const html = renderer.adaptor.outerHTML(node);
	const start = html.indexOf("<svg");
	const end = html.lastIndexOf("</svg>");
	if (start < 0 || end < 0) return null;
	const svg = html.slice(start, end + "</svg>".length);
	const match = VIEWBOX.exec(svg);
	if (!match) return null;
	const width = Number(match[2]), height = Number(match[3]);
	return { svg, widthEm: width / 1000, heightEm: height / 1000 };
}

function fixSize(svg: string, widthPx: number, heightPx: number): string {
	return svg.replace(/width="[^"]*"/, `width="${round(widthPx)}"`).replace(/height="[^"]*"/, `height="${round(heightPx)}"`);
}

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** px per em for the equation image; EMU conversion happens in prepare-math. */
export function fontPxForPoints(points: number): number {
	return (points * 96) / 72;
}

export interface MathImage {
	/** Standalone SVG with explicit px width/height. */
	svg: string;
	widthPx: number;
	heightPx: number;
}

export interface TypesetOptions {
	/** Display equations (m:oMathPara) use display-style layout. */
	display: boolean;
	/** Document font size at the equation position, in CSS pixels per em. */
	fontPx: number;
	/**
	 * Text column width in px. When given, the image spans the column so rows
	 * center like Word display equations and `#(n)` numbers flush right.
	 */
	columnPx?: number;
}

/**
 * Typeset converted rows into one SVG image. Inline equations produce a
 * baseline-padded image; display equations span the given column width.
 */
export async function typesetRows(rows: MathRow[], options: TypesetOptions): Promise<MathImage | null> {
	if (!rows.length) return null;
	const typeset_ = await Promise.all(rows.map(async (row) => {
		const main = await typeset(row.mathml, options.display);
		if (!main) return null;
		const number = row.number ? await typesetNumber(row.number) : null;
		return { main, number };
	}));
	if (typeset_.some((row) => row === null)) return null;
	const done = typeset_ as Array<{ main: TypesetRow; number: { svg: string; widthEm: number; heightEm: number } | null }>;
	const em = options.fontPx;
	const fullColumn = options.columnPx != null && (options.display || done.some((row) => row.number));

	if (!fullColumn) {
		// Inline equation: single row, natural width. The engine bottom-aligns
		// pictures to the text baseline, so pad the top by the row's depth —
		// the math baseline then lands exactly on the text baseline and
		// below-baseline parts hang into the line like Word renders them.
		const row = done[0];
		const depth = Math.max(0, row.main.heightEm - row.main.ascentEm) * em;
		const widthPx = row.main.widthEm * em;
		const heightPx = row.main.heightEm * em + depth;
		const inner = fixSize(row.main.svg, widthPx, row.main.heightEm * em);
		return {
			svg: `<svg xmlns="${SVG_NS}" width="${round(widthPx)}" height="${round(heightPx)}" viewBox="0 0 ${round(widthPx)} ${round(heightPx)}">`
				+ `<g transform="translate(0 ${round(depth)})">${inner}</g></svg>`,
			widthPx,
			heightPx,
		};
	}

	// Display layout: rows stacked and centered in the column; a `#(n)` number
	// is flushed right like Word does.
	const columnPx = options.columnPx!;
	const rowGap = 0.4 * em;
	const placements = done.map((row) => {
		const widthPx = row.main.widthEm * em;
		const heightPx = row.main.heightEm * em;
		const numberWidthPx = row.number ? row.number.widthEm * em : 0;
		const available = columnPx - numberWidthPx - (row.number ? 0.6 * em : 0);
		let x = Math.max(0, (available - widthPx) / 2);
		let numberX = columnPx - numberWidthPx;
		if (row.number) {
			const centered = (columnPx - widthPx) / 2;
			if (centered + widthPx <= numberX - 0.3 * em) x = centered;
			else numberX = Math.min(columnPx, widthPx + 0.6 * em);
		}
		return { row, widthPx, heightPx, x, numberX };
	});
	const contentHeight = placements.reduce((sum, item) => sum + item.heightPx, 0) + rowGap * (placements.length - 1);
	const heightPx = Math.max(contentHeight, options.fontPx * 1.6);
	const parts: string[] = [`<svg xmlns="${SVG_NS}" width="${round(columnPx)}" height="${round(heightPx)}" viewBox="0 0 ${round(columnPx)} ${round(heightPx)}">`];
	let y = (heightPx - contentHeight) / 2;
	for (const item of placements) {
		const inner = fixSize(item.row.main.svg, item.widthPx, item.heightPx);
		parts.push(`<g transform="translate(${round(item.x)} ${round(y)})">${inner}</g>`);
		if (item.row.number) {
			const numberInner = fixSize(item.row.number.svg, item.row.number.widthEm * em, item.row.number.heightEm * em);
			const numberY = y + (item.heightPx - item.row.number.heightEm * em) / 2;
			parts.push(`<g transform="translate(${round(item.numberX)} ${round(numberY)})">${numberInner}</g>`);
		}
		y += item.heightPx + rowGap;
	}
	parts.push("</svg>");
	return { svg: parts.join(""), widthPx: columnPx, heightPx };
}
