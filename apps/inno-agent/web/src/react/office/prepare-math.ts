import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { convertOmml, type MathRow } from "./omml-to-mathml.js";
import { fontPxForPoints, typesetRows } from "./render-math.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const story = /^word\/(?:document|header[^/]*|footer[^/]*)\.xml$/;

/**
 * Word math is the one construct BetterOffice 0.4.3 parses (and round-trips
 * verbatim) but does not lay out: it paints only the equation's plain text, so
 * fractions, subscripts and `#(n)` equation numbers collapse into one line.
 * Following the VML precedent, prepare the document for the editor by turning
 * each equation into an inline SVG picture — pagination, anchors and scaling
 * stay with the engine. Unlike VML, OMML survives inside the engine, so the
 * document stays editable; restore() puts the original OMML back into the
 * engine's export before anything is written to disk, keeping formulas intact
 * for Word/WPS. Disk originals are never touched.
 */

interface Placeholder {
	/** Story part the equation lived in, e.g. "word/document.xml". */
	part: string;
	mediaPath: string;
	relationshipId: string;
	svg: string;
	widthPx: number;
	heightPx: number;
	/** Serialized original `m:oMath`/`m:oMathPara` element. */
	omml: string;
}

export interface MathPreparation {
	bytes: Uint8Array;
	converted: number;
	unsupported: number;
	/**
	 * Replace the placeholder pictures in an engine export with the original
	 * OMML. A placeholder whose picture vanished was deleted in the editor and
	 * stays deleted; one that is still present but not referenced means the
	 * export restructured drawings — throw so nothing broken is written back.
	 */
	restore(saved: ArrayBuffer): ArrayBuffer;
}

const parser = new DOMParser();
const parse = (xml: string) => {
	const doc = parser.parseFromString(xml, "application/xml");
	if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid Word XML");
	return doc;
};
const serializeNode = (node: Node) => new Uint8Array(strToU8(new XMLSerializer().serializeToString(node)));
const attr = (element: Element, name: string, namespace = W): string | null => element.getAttributeNS(namespace, name) ?? element.getAttribute(name);
const descendants = (element: Element, local: string): Element[] => Array.from(element.getElementsByTagNameNS(W, local));
const firstOf = (element: Element, local: string): Element | null => descendants(element, local)[0] ?? null;

interface StyleInfo {
	basedOn: string | null;
	size: number | null;
	/** First-line indent in twips; negative values store firstLineChars/100. */
	firstLine: number | null;
}

function styleMap(styles: XMLDocument): Map<string, StyleInfo> {
	const map = new Map<string, StyleInfo>();
	for (const style of Array.from(styles.getElementsByTagNameNS(W, "style"))) {
		const id = attr(style, "styleId");
		if (!id) continue;
		const basedOn = firstOf(style, "basedOn");
		const sizeNode = firstOf(style, "sz");
		const indent = firstOf(style, "ind");
		const sizeValue = sizeNode ? attr(sizeNode, "val") : null;
		const chars = indent ? attr(indent, "firstLineChars") : null;
		const twips = indent ? attr(indent, "firstLine") : null;
		map.set(id, {
			basedOn: basedOn ? attr(basedOn, "val") : null,
			size: sizeValue ? Number(sizeValue) : null,
			firstLine: twips ? Number(twips) : chars ? -Number(chars) : null,
		});
	}
	return map;
}

function styleChain(styleId: string | null, styles: Map<string, StyleInfo>): StyleInfo[] {
	const chain: StyleInfo[] = [];
	let id = styleId;
	for (let hop = 0; id && hop < 6; hop++) {
		const info = styles.get(id);
		if (!info) break;
		chain.push(info);
		id = info.basedOn;
	}
	return chain;
}

function paragraphStyleId(paragraph: Element | null): string | null {
	const properties = paragraph ? firstOf(paragraph, "pPr") : null;
	const style = properties ? firstOf(properties, "pStyle") : null;
	return style ? attr(style, "val") : null;
}

/** Document default run size in half-points (w:docDefaults), fallback 22 = 11pt. */
function documentDefaultSize(styles: XMLDocument): number {
	const defaults = firstOf(styles.documentElement, "docDefaults");
	const size = defaults ? firstOf(defaults, "sz") : null;
	const value = size ? attr(size, "val") : null;
	const parsed = value ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 22;
}

/** Effective run size for an equation, in half-points. */
function resolveFontSize(oMath: Element, paragraph: Element | null, styles: Map<string, StyleInfo>, fallback: number): number {
	for (const sz of Array.from(oMath.getElementsByTagNameNS(W, "sz"))) {
		const value = Number(attr(sz, "val"));
		if (Number.isFinite(value) && value > 0) return value;
	}
	const fromStyle = styleChain(paragraphStyleId(paragraph), styles).map((info) => info.size).find((value) => value != null && Number.isFinite(value));
	if (fromStyle != null) return fromStyle;
	const mark = paragraph ? firstOf(firstOf(paragraph, "pPr") ?? paragraph, "sz") : null;
	const markValue = mark ? Number(attr(mark, "val")) : NaN;
	return Number.isFinite(markValue) && markValue > 0 ? markValue : fallback;
}

/** Column width in EMU from the body's last section. */
function resolveColumnEmu(doc: XMLDocument): number {
	const sections = Array.from(doc.getElementsByTagNameNS(W, "sectPr"));
	const section = sections[sections.length - 1] ?? null;
	const page = section ? firstOf(section, "pgSz") : null;
	const margin = section ? firstOf(section, "pgMar") : null;
	const width = page ? Number(attr(page, "w")) : NaN;
	const left = margin ? Number(attr(margin, "left")) : NaN;
	const right = margin ? Number(attr(margin, "right")) : NaN;
	// A4 with 2.54cm margins when the section is missing.
	const column = Number.isFinite(width) ? width : 11906;
	const inner = (Number.isFinite(left) ? left : 1440) + (Number.isFinite(right) ? right : 1440);
	return Math.max(914400, Math.round((column - inner) * 635));
}

/** First-line indent in twips for the paragraph holding a display equation. */
function firstLineIndentTwips(paragraph: Element | null, styles: Map<string, StyleInfo>, fontSizeHalfPoints: number): number {
	const sizeTwips = (fontSizeHalfPoints / 2) * 20;
	const fromChars = (value: string) => (Number(value) / 100) * sizeTwips;
	const properties = paragraph ? firstOf(paragraph, "pPr") : null;
	const ind = properties ? firstOf(properties, "ind") : null;
	if (ind) {
		const chars = attr(ind, "firstLineChars");
		if (chars) return Math.max(0, fromChars(chars));
		const twips = attr(ind, "firstLine");
		if (twips) return Math.max(0, Number(twips));
	}
	const fromStyle = styleChain(paragraphStyleId(paragraph), styles).map((info) => {
		if (info.firstLine == null) return null;
		return info.firstLine < 0 ? fromChars(String(-info.firstLine)) : info.firstLine;
	}).find((value) => value != null);
	return Math.max(0, fromStyle ?? 0);
}

function buildDrawing(doc: XMLDocument, imageId: number, image: { widthPx: number; heightPx: number }, mediaPath: string, relationshipId: string): Element {
	const node = (name: string, attrs: Record<string, string | number> = {}, kids: Element[] = []): Element => {
		const ns = name.startsWith("a:") ? A : name.startsWith("wp:") ? WP : name.startsWith("pic:") ? PIC : W;
		const element = doc.createElementNS(ns, name);
		for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
		element.append(...kids);
		return element;
	};
	const extent = { cx: Math.round(image.widthPx * 9525), cy: Math.round(image.heightPx * 9525) };
	const blip = doc.createElementNS(A, "a:blip");
	blip.setAttributeNS(R, "r:embed", relationshipId);
	const blipFill = node("pic:blipFill", {}, [blip, node("a:stretch", {}, [node("a:fillRect")])]);
	const spPr = node("pic:spPr", {}, [node("a:xfrm", {}, [node("a:off", { x: 0, y: 0 }), node("a:ext", extent)]), node("a:prstGeom", { prst: "rect" }, [node("a:avLst")])]);
	const picture = node("pic:pic", {}, [node("pic:nvPicPr", {}, [node("pic:cNvPr", { id: imageId, name: mediaPath.slice("word/media/".length) }), node("pic:cNvPicPr")]), blipFill, spPr]);
	const graphic = node("a:graphic", {}, [node("a:graphicData", { uri: `${A}/picture` }, [picture])]);
	return node("w:r", {}, [node("w:drawing", {}, [node("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 }, [
		node("wp:extent", extent),
		node("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 }),
		node("wp:docPr", { id: imageId, name: `InnoMath ${imageId}` }),
		node("wp:cNvGraphicFramePr"),
		graphic,
	])])]);
}

/**
 * Convert every equation in the package to a placeholder picture. Equations
 * that cannot be converted are left untouched — the engine round-trips their
 * OMML, so they degrade to the old plain-text view but never get lost.
 */
export async function createMathSession(buffer: Uint8Array): Promise<MathPreparation> {
	const filenames = new Set<string>();
	const selection = unzipSync(buffer, { filter: (file) => {
		filenames.add(file.name);
		return story.test(file.name) || /^word\/_rels\/[^/]+\.xml\.rels$/.test(file.name) || file.name === "[Content_Types].xml" || file.name === "word/styles.xml";
	} });
	const storyNames = Object.keys(selection).filter((name) => story.test(name));
	console.log("DEBUG selection keys:", Object.keys(selection), "storyNames:", storyNames);
	const hasMath = storyNames.some((name) => strFromU8(selection[name]).includes("oMath"));
	if (!hasMath) return { bytes: buffer, converted: 0, unsupported: 0, restore: (saved) => saved };

	const stylesDoc = selection["word/styles.xml"] ? parse(strFromU8(selection["word/styles.xml"])) : null;
	const styles = stylesDoc ? styleMap(stylesDoc) : new Map<string, StyleInfo>();
	const defaultSize = stylesDoc ? documentDefaultSize(stylesDoc) : 22;
	const columnEmu = storyNames.includes("word/document.xml") ? resolveColumnEmu(parse(strFromU8(selection["word/document.xml"]))) : 9360 * 635;

	const changed: Record<string, Uint8Array> = {};
	const placeholders: Placeholder[] = [];
	let converted = 0;
	let unsupported = 0;
	let mediaId = 0;

	for (const name of storyNames) {
		const xml = strFromU8(selection[name]);
		if (!xml.includes("oMath")) continue;
		const doc = parse(xml);
		const relPath = name.replace("word/", "word/_rels/") + ".rels";
		const rels = parse(selection[relPath] ? strFromU8(selection[relPath]) : `<Relationships xmlns="${RELS}"/>`);
		const relationshipIds = new Set(Array.from(rels.documentElement.children).map((e) => e.getAttribute("Id")));
		let imageId = Math.max(0, ...Array.from(doc.getElementsByTagNameNS(WP, "docPr")).map((e) => Number(attr(e, "id")) || 0));
		const replacements: Array<{ element: Element; drawing: Element; mediaPath: string; relationshipId: string }> = [];

		const candidates: Array<{ element: Element; display: boolean }> = [];
		console.log("DEBUG story", name, "oMathPara:", doc.getElementsByTagNameNS(M, "oMathPara").length, "oMath:", doc.getElementsByTagNameNS(M, "oMath").length);
		for (const para of Array.from(doc.getElementsByTagNameNS(M, "oMathPara"))) candidates.push({ element: para, display: true });
		for (const equation of Array.from(doc.getElementsByTagNameNS(M, "oMath"))) {
			let ancestor = equation.parentElement;
			while (ancestor && ancestor.namespaceURI === M && ancestor.localName !== "oMathPara") ancestor = ancestor.parentElement;
			if (ancestor && ancestor.localName === "oMathPara") continue;
			candidates.push({ element: equation, display: false });
		}
		for (const { element, display } of candidates) {
			try {
				const rows = convertOmml(element);
				const paragraph = element.parentElement && element.parentElement.namespaceURI === W && element.parentElement.localName === "p" ? element.parentElement : null;
				const fontSizeHalfPoints = resolveFontSize(element, paragraph, styles, defaultSize);
				const fontPx = fontPxForPoints(fontSizeHalfPoints / 2);
				let columnPx: number | undefined;
				if (display) {
					const indentEmu = firstLineIndentTwips(paragraph, styles, fontSizeHalfPoints) * 635;
					columnPx = Math.max(28.5, (columnEmu - indentEmu) / 9525);
				}
				const image = await typesetRows(rows, { display, fontPx, columnPx });
				if (!image || !(image.widthPx > 0) || !(image.heightPx > 0)) throw new Error("Math typesetting failed");
				let mediaPath: string, relationshipId: string;
				do { mediaId++; mediaPath = `word/media/inno-math-${mediaId}.svg`; relationshipId = `rIdInnoMath${mediaId}`; }
				while (filenames.has(mediaPath) || relationshipIds.has(relationshipId));
				imageId++;
				replacements.push({ element, drawing: buildDrawing(doc, imageId, image, mediaPath, relationshipId), mediaPath, relationshipId });
				placeholders.push({ part: name, mediaPath, relationshipId, svg: image.svg, widthPx: image.widthPx, heightPx: image.heightPx, omml: new XMLSerializer().serializeToString(element) });
			} catch (cause) {
				console.log("DEBUG convert failed:", cause);
				unsupported++;
			}
		}
		console.log("DEBUG candidates:", candidates.length, "replacements:", replacements.length);
		if (!replacements.length) continue;
		for (const { element, drawing } of replacements) outermostRun(element).replaceWith(drawing);
		for (const item of replacements) {
			changed[item.mediaPath] = new Uint8Array(strToU8(placeholders.find((p) => p.mediaPath === item.mediaPath)!.svg));
			const relationship = rels.createElementNS(RELS, "Relationship");
			relationship.setAttribute("Id", item.relationshipId);
			relationship.setAttribute("Type", `${R}/image`);
			relationship.setAttribute("Target", item.mediaPath.slice("word/".length));
			rels.documentElement.append(relationship);
		}
		changed[relPath] = serializeNode(rels);
		changed[name] = serializeNode(doc);
		converted += replacements.length;
	}
	if (!converted) return { bytes: buffer, converted, unsupported, restore: (saved) => saved };

	changed["[Content_Types].xml"] = withSvgOverrides(selection["[Content_Types].xml"] ? strFromU8(selection["[Content_Types].xml"]) : null, placeholders.map((p) => p.mediaPath));
	const parts = unzipSync(buffer) as Zippable;
	return { bytes: zipSync({ ...parts, ...changed }), converted, unsupported, restore: (saved) => restoreMath(saved, placeholders) };
}

/**
 * Equations must be replaced at paragraph level. Packages saved by earlier
 * builds can carry an OMML element inside a `w:r`; replacing just the equation
 * there would nest the picture run inside a run, so climb to the outermost
 * containing run like restore does.
 */
function outermostRun(element: Element): Element {
	let top = element;
	let ancestor = element.parentElement;
	while (ancestor && ancestor.namespaceURI === W && ancestor.localName === "r") {
		top = ancestor;
		ancestor = ancestor.parentElement;
	}
	return top;
}

function withSvgOverrides(contentTypesXml: string | null, mediaPaths: string[]): Uint8Array {
	const doc = contentTypesXml ? parse(contentTypesXml) : parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"/>`);
	for (const mediaPath of mediaPaths) {
		const override = doc.createElementNS(CT, "Override");
		override.setAttribute("PartName", `/${mediaPath}`);
		override.setAttribute("ContentType", "image/svg+xml");
		doc.documentElement.append(override);
	}
	return serializeNode(doc);
}

/** Collect drawings whose blip resolves to one of our media parts. */
function findPlaceholderDrawings(doc: XMLDocument, rels: XMLDocument, mediaPaths: Set<string>): Map<string, Element[]> {
	const targets = new Map<string, Element[]>();
	const resolve = (relationshipId: string | null): string | null => {
		if (!relationshipId) return null;
		for (const relationship of Array.from(rels.documentElement.children)) {
			if (relationship.getAttribute("Id") === relationshipId) {
				const target = relationship.getAttribute("Target") ?? "";
				return target.replace(/^\//, "").replace(/^\.\.\//, "").startsWith("word/") ? target.replace(/^\//, "").replace(/^\.\.\//, "") : `word/${target.replace(/^\//, "").replace(/^\.\.\//, "")}`;
			}
		}
		return null;
	};
	for (const drawing of Array.from(doc.getElementsByTagNameNS(W, "drawing"))) {
		for (const blip of Array.from(drawing.getElementsByTagNameNS(A, "blip"))) {
			const target = resolve(blip.getAttributeNS(R, "embed") || blip.getAttribute("r:embed"));
			if (target && mediaPaths.has(target)) {
				const list = targets.get(target) ?? [];
				list.push(drawing);
				targets.set(target, list);
			}
		}
	}
	return targets;
}

/**
 * The element a placeholder drawing is replaced by. OMML must sit directly in
 * the paragraph — the engine export keeps our picture inside a `w:r`, and
 * leaving that run in place would wrap the equation in a run, which Word and
 * this editor treat as invalid and drop on reopen. So climb to the
 * markup-compatibility wrapper when present, else to the outermost `w:r`.
 */
function replacementTarget(drawing: Element): Element {
	let ancestor = drawing.parentElement;
	let run: Element | null = null;
	while (ancestor) {
		if (ancestor.localName === "AlternateContent" && ancestor.namespaceURI === "http://schemas.openxmlformats.org/markup-compatibility/2006") return ancestor;
		if (ancestor.namespaceURI === W && ancestor.localName === "r") run = ancestor;
		if (ancestor.namespaceURI === W && ancestor.localName === "p") break;
		ancestor = ancestor.parentElement;
	}
	return run ?? drawing;
}

function restoreMath(saved: ArrayBuffer, placeholders: Placeholder[]): ArrayBuffer {
	const input = new Uint8Array(saved);
	const mediaPaths = new Set(placeholders.map((p) => p.mediaPath));
	const parts = unzipSync(input) as Zippable;
	const packaged = placeholders.filter((p) => parts[p.mediaPath]);
	if (!packaged.length) return saved;
	const changed: Zippable = {};
	const restoredMedia = new Set<string>();
	for (const part of new Set(packaged.map((p) => p.part))) {
		const bytes = parts[part];
		if (!bytes) continue;
		let doc: XMLDocument;
		try {
			doc = parse(strFromU8(bytes as Uint8Array));
		} catch {
			// The exported story is not parseable — keep the package unchanged and
			// let the validator decide; equations cannot be restored into it.
			return saved;
		}
		const relPath = part.replace("word/", "word/_rels/") + ".rels";
		const rels = parse(strFromU8((parts[relPath] ?? new TextEncoder().encode(`<Relationships xmlns="${RELS}"/>`)) as Uint8Array));
		const targets = findPlaceholderDrawings(doc, rels, mediaPaths);
		let touched = false;
		for (const [mediaPath, drawings] of targets) {
			const placeholder = placeholders.find((p) => p.mediaPath === mediaPath);
			if (!placeholder) continue;
			const owner = parser.parseFromString(`<w:root xmlns:w="${W}" xmlns:m="${M}">${placeholder.omml}</w:root>`, "application/xml");
			if (owner.getElementsByTagName("parsererror").length || !owner.documentElement.firstElementChild) throw new Error("Lost the original equation XML");
			const source = owner.documentElement.firstElementChild;
			const seen = new Set<Element>();
			for (const drawing of drawings) {
				const target = replacementTarget(drawing);
				if (seen.has(target)) continue;
				seen.add(target);
				target.replaceWith(doc.importNode(source.cloneNode(true), true));
				touched = true;
			}
			restoredMedia.add(mediaPath);
		}
		if (touched) changed[part] = serializeNode(doc);
	}
	// Remove every placeholder media part: restored ones are back as OMML, and
	// a leftover file with no drawing was deleted in the editor on purpose.
	for (const placeholder of packaged) delete parts[placeholder.mediaPath];
	const contentTypes = parse(strFromU8(parts["[Content_Types].xml"] as Uint8Array));
	let overridesRemoved = false;
	for (const override of Array.from(contentTypes.documentElement.getElementsByTagNameNS(CT, "Override"))) {
		if (mediaPaths.has((override.getAttribute("PartName") ?? "").replace(/^\//, ""))) {
			override.remove();
			overridesRemoved = true;
		}
	}
	if (overridesRemoved) changed["[Content_Types].xml"] = serializeNode(contentTypes);
	for (const part of new Set(packaged.map((p) => p.part))) {
		const relPath = part.replace("word/", "word/_rels/") + ".rels";
		if (!parts[relPath]) continue;
		const rels = parse(strFromU8(parts[relPath] as Uint8Array));
		let removed = false;
		for (const relationship of Array.from(rels.documentElement.children)) {
			const target = (relationship.getAttribute("Target") ?? "").replace(/^\//, "").replace(/^\.\.\//, "");
			const full = target.startsWith("word/") ? target : `word/${target}`;
			if (mediaPaths.has(full)) {
				relationship.remove();
				removed = true;
			}
		}
		if (removed) {
			changed[relPath] = serializeNode(rels);
		}
	}
	return zipSync({ ...parts, ...changed }).slice().buffer;
}
