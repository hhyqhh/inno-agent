import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseVmlPath, vmlFormulaResolver, vmlNumbers } from "./vml-path.js";

const V = "urn:schemas-microsoft-com:vml";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const SVG = "http://www.w3.org/2000/svg";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const story = /^word\/(?:document|header[^/]*|footer[^/]*)\.xml$/;
const off = (value: string | null) => /^(?:f|false|0)$/i.test(value ?? "");
const finite = (value: number) => { if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error("Invalid VML number"); return value; };

/** Convert authored lengths to EMUs, without evaluating style/CSS in the browser. */
function length(value = "0"): number {
	const match = /^([+-]?(?:\d*\.\d+|\d+))(pt|px|in|cm|mm|pc)?$/i.exec(value.trim());
	if (!match) throw new Error("Unsupported VML length");
	const factor: Record<string, number> = { pt: 12700, px: 9525, in: 914400, cm: 360000, mm: 36000, pc: 152400 };
	return Math.round(finite(Number(match[1]) * factor[match[2]?.toLowerCase() ?? "px"]));
}

function styles(shape: Element): Record<string, string> {
	return Object.fromEntries((shape.getAttribute("style") ?? "").split(";").filter((s) => s.includes(":")).map((s) => { const i = s.indexOf(":"); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; }));
}
function color(value: string | null, fallback: string): string {
	const named: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", blue: "0000FF", green: "008000", yellow: "FFFF00", gray: "808080", silver: "C0C0C0", navy: "000080", maroon: "800000", purple: "800080", teal: "008080", lime: "00FF00", aqua: "00FFFF", fuchsia: "FF00FF", olive: "808000" };
	const s = (value ?? fallback).trim().toLowerCase();
	if (named[s]) return named[s];
	if (/^#?[a-f\d]{6}$/i.test(s)) return s.replace("#", "").toUpperCase();
	if (/^#[a-f\d]{3}$/i.test(s)) return s.slice(1).split("").map((c) => c + c).join("").toUpperCase();
	throw new Error("Unsupported VML color");
}

function drawing(shape: Element, types: Map<string, Element>, id: number, relationshipId: string): { drawing: Element; svg: Uint8Array } {
	const doc = shape.ownerDocument;
	const node = (name: string, attrs: Record<string, string | number> = {}, children: Element[] = []): Element => {
		const ns = name.startsWith("a:") ? A : name.startsWith("wp:") ? WP : name.startsWith("pic:") ? PIC : W;
		const element = doc.createElementNS(ns, name);
		for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
		element.append(...children); return element;
	};
	const type = types.get(shape.getAttribute("type")?.replace(/^#/, "") ?? "");
	const attr = (name: string) => shape.getAttribute(name) ?? type?.getAttribute(name) ?? null;
	const child = (name: string) => Array.from(shape.children).find((e) => e.namespaceURI === V && e.localName === name)
		?? Array.from(type?.children ?? []).find((e) => e.namespaceURI === V && e.localName === name);
	// BetterOffice 0.4.3 imports VML pictures but drops vector-only w:pict.
	// Its shape serializer also discards custom paths. Use SVG picture media so
	// both rendering and saving preserve the vector, retaining VML at import.
	if (!['shape', 'rect', 'roundrect', 'oval', 'line', 'polyline'].includes(shape.localName)) throw new Error("Unsupported VML shape");
	if (shape.getElementsByTagNameNS(V, "textbox").length || child("textpath") || child("imagedata")) throw new Error("Complex VML shape");
	for (const name of ["shadow", "extrusion"]) {
		const detail = child(name);
		if (detail && !off(detail.getAttribute("on"))) throw new Error("Unsupported VML paint");
	}
	const strokeDetail = child("stroke"), fillDetail = child("fill");
	if (strokeDetail && Array.from(strokeDetail.attributes).some((a) => !["on", "joinstyle", "color", "weight"].includes(a.localName))) throw new Error("Unsupported VML stroke");
	if (fillDetail && Array.from(fillDetail.attributes).some((a) => !["on", "color", "type"].includes(a.localName))) throw new Error("Unsupported VML fill");
	if (fillDetail?.getAttribute("type") && fillDetail.getAttribute("type") !== "solid") throw new Error("Unsupported VML fill");
	const style = styles(shape);
	if (style.visibility === "hidden" || style.display === "none") throw new Error("Hidden VML shape");
	let width = length(style.width), height = length(style.height);
	let x = length(style["margin-left"] ?? style.left), y = length(style["margin-top"] ?? style.top);
	let pathSource = child("path")?.getAttribute("v") ?? attr("path");
	let coordsize = vmlNumbers(attr("coordsize") ?? "21600,21600", Number);
	if (shape.localName === "line") {
		const from = (shape.getAttribute("from") ?? "0,0").split(",").map((s) => length(s));
		const to = (shape.getAttribute("to") ?? "0,0").split(",").map((s) => length(s));
		if (from.length !== 2 || to.length !== 2) throw new Error("Invalid VML line");
		x += Math.min(from[0], to[0]); y += Math.min(from[1], to[1]);
		width = Math.max(1, Math.abs(to[0] - from[0])); height = Math.max(1, Math.abs(to[1] - from[1]));
		pathSource = `m${from[0] <= to[0] ? 0 : 21600},${from[1] <= to[1] ? 0 : 21600}l${from[0] <= to[0] ? 21600 : 0},${from[1] <= to[1] ? 21600 : 0}e`;
		coordsize = [21600, 21600];
	}
	if (shape.localName === "polyline") pathSource = `m${attr("points") ?? ""}e`;
	if (width <= 0 || height <= 0 || coordsize.length !== 2 || coordsize.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("Invalid VML dimensions");
	const image = doc.createElementNS(SVG, "svg");
	const svgNode = (name: string, attrs: Record<string, string | number>) => {
		const element = doc.createElementNS(SVG, name);
		for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
		image.append(element); return element;
	};
	const pxWidth = width / 9525, pxHeight = height / 9525;
	if (pathSource) {
		const origin = vmlNumbers(attr("coordorigin") ?? "0,0", Number);
		if (origin.length !== 2 || origin.some((n) => !Number.isFinite(n))) throw new Error("Invalid VML origin");
		const equations = Array.from(child("formulas")?.children ?? []).map((e) => e.getAttribute("eqn") ?? "");
		const resolve = vmlFormulaResolver(equations, attr("adj") ?? "", coordsize[0], coordsize[1]);
		const paths = parseVmlPath(pathSource, resolve);
		const names = { moveTo: "M", lnTo: "L", cubicBezTo: "C", quadBezTo: "Q", close: "Z" };
		for (const path of paths) svgNode("path", {
			d: path.commands.map((command) => names[command.kind] + command.points.map(([px, py]) => `${finite((px - origin[0]) / coordsize[0] * pxWidth)},${finite((py - origin[1]) / coordsize[1] * pxHeight)}`).join(" ")).join(" "),
			...(path.fill ? {} : { fill: "none" }), ...(path.stroke ? {} : { stroke: "none" }),
		});
	} else {
		if (shape.localName === "oval") svgNode("ellipse", { cx: pxWidth / 2, cy: pxHeight / 2, rx: pxWidth / 2, ry: pxHeight / 2 });
		else if (shape.localName === "rect" || shape.localName === "roundrect") {
			const raw = attr("arcsize") ?? "20%";
			const radius = shape.localName === "rect" ? 0 : Math.min(pxWidth, pxHeight) * Math.max(0, Math.min(1, finite(Number(raw.replace("%", "")) / (raw.endsWith("%") ? 100 : 1)))) / 2;
			svgNode("rect", { width: pxWidth, height: pxHeight, rx: radius, ry: radius });
		} else throw new Error("VML shape has no geometry");
	}
	const filled = !off(attr("filled")) && !off(fillDetail?.getAttribute("on") ?? null) && shape.localName !== "line" && shape.localName !== "polyline";
	const stroked = !off(attr("stroked")) && !off(strokeDetail?.getAttribute("on") ?? null);
	const strokeWidth = Math.max(0, length(strokeDetail?.getAttribute("weight") ?? attr("strokeweight") ?? "1pt"));
	const join = strokeDetail?.getAttribute("joinstyle") ?? "round";
	if (!["miter", "round", "bevel"].includes(join)) throw new Error("Unsupported VML join");
	image.setAttribute("fill", filled ? `#${color(fillDetail?.getAttribute("color") ?? attr("fillcolor"), "white")}` : "none");
	image.setAttribute("stroke", stroked ? `#${color(strokeDetail?.getAttribute("color") ?? attr("strokecolor"), "black")}` : "none");
	image.setAttribute("stroke-width", String(strokeWidth / 9525)); image.setAttribute("stroke-linejoin", join);
	// Reserve ink outside the shape bounds, so strokes at x/y=0 are not clipped
	// by the replaced image viewport. Keep the authored anchor/content position.
	const padding = stroked ? Math.ceil(strokeWidth * (join === "miter" ? 2 : 1)) : 0;
	image.setAttribute("width", String((width + 2 * padding) / 9525)); image.setAttribute("height", String((height + 2 * padding) / 9525));
	image.setAttribute("viewBox", `${-padding / 9525} ${-padding / 9525} ${(width + 2 * padding) / 9525} ${(height + 2 * padding) / 9525}`);
	width += 2 * padding; height += 2 * padding; x -= padding; y -= padding;
	const transform = node("a:xfrm", { rot: Math.round(finite(Number(style.rotation ?? 0)) * 60000), flipH: /x/i.test(style.flip ?? "") ? "1" : "0", flipV: /y/i.test(style.flip ?? "") ? "1" : "0" }, [node("a:off", { x: 0, y: 0 }), node("a:ext", { cx: width, cy: height })]);
	const blip = node("a:blip"); blip.setAttributeNS(R, "r:embed", relationshipId);
	const picture = node("pic:pic", {}, [
		node("pic:nvPicPr", {}, [node("pic:cNvPr", { id, name: shape.getAttribute("id") ?? `VML ${id}` }), node("pic:cNvPicPr")]),
		node("pic:blipFill", {}, [blip, node("a:stretch", {}, [node("a:fillRect")])]),
		node("pic:spPr", {}, [transform, node("a:prstGeom", { prst: "rect" }, [node("a:avLst")])]),
	]);
	const graphic = node("a:graphic", {}, [node("a:graphicData", { uri: PIC }, [picture])]);
	const floating = style.position === "absolute";
	const common = [node("wp:extent", { cx: width, cy: height }), node("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 })];
	const properties = node("wp:docPr", { id, name: shape.getAttribute("id") ?? `VML ${id}` });
	const position = (axis: "H" | "V", offset: number) => {
		const raw = style[`mso-position-${axis === "H" ? "horizontal" : "vertical"}-relative`];
		const allowed = axis === "H" ? ["page", "margin", "column", "character"] : ["page", "margin", "paragraph", "line"];
		const relativeFrom = raw ?? (axis === "H" ? "column" : "paragraph");
		if (!allowed.includes(relativeFrom)) throw new Error("Unsupported VML anchor");
		const pos = node("wp:posOffset"); pos.textContent = String(offset);
		return node(`wp:position${axis}`, { relativeFrom }, [pos]);
	};
	const wrap = Array.from(shape.children).find((e) => e.localName === "wrap");
	const wrapType = wrap?.getAttribute("type") ?? "none";
	if (!["none", "square", "topAndBottom"].includes(wrapType)) throw new Error("Unsupported VML wrap");
	const anchor = floating ? node("wp:anchor", { distT: 0, distB: 0, distL: 0, distR: 0, simplePos: 0, relativeHeight: Math.max(0, Math.min(4294967295, Number(style["z-index"]) || id)), behindDoc: Number(style["z-index"]) < 0 ? "1" : "0", locked: 0, layoutInCell: 1, allowOverlap: 1 }, [node("wp:simplePos", { x: 0, y: 0 }), position("H", x), position("V", y), ...common, node(wrapType === "square" ? "wp:wrapSquare" : wrapType === "topAndBottom" ? "wp:wrapTopAndBottom" : "wp:wrapNone", wrapType === "square" ? { wrapText: "bothSides" } : {}), properties, node("wp:cNvGraphicFramePr"), graphic])
		: node("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 }, [...common, properties, node("wp:cNvGraphicFramePr"), graphic]);
	return { drawing: node("w:drawing", {}, [anchor]), svg: new Uint8Array(strToU8(new XMLSerializer().serializeToString(image))) };
}

export interface PreparedVml { bytes: Uint8Array; converted: number; unsupported: number }

/** Import-only compatibility adapter. The editor remains the sole document state owner. */
export function prepareVml(buffer: Uint8Array): PreparedVml {
	let expanded = 0;
	const filenames = new Set<string>();
	const stories = unzipSync(buffer, { filter: (file) => {
		filenames.add(file.name);
		if (!story.test(file.name) && !/^word\/_rels\/[^/]+\.xml\.rels$/.test(file.name) && file.name !== "[Content_Types].xml") return false;
		expanded += file.originalSize;
		if (expanded > 32 * 1024 * 1024) throw new Error("Word XML too large");
		return true;
	} });
	const changed: Record<string, Uint8Array> = {};
	let converted = 0, unsupported = 0;
	let mediaId = 0;
	const parse = (xml: string) => {
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid Word XML");
		return doc;
	};
	const serialize = (doc: XMLDocument) => new Uint8Array(strToU8(new XMLSerializer().serializeToString(doc)));
	for (const [name, data] of Object.entries(stories)) {
		if (!story.test(name)) continue;
		const xml = strFromU8(data);
		if (!xml.includes(V)) continue;
		const doc = parse(xml);
		const relPath = name.replace("word/", "word/_rels/") + ".rels";
		const rels = parse(stories[relPath] ? strFromU8(stories[relPath]) : `<Relationships xmlns="${RELS}"/>`);
		const relationshipIds = new Set(Array.from(rels.documentElement.children).map((e) => e.getAttribute("Id")));
		const types = new Map(Array.from(doc.getElementsByTagNameNS(V, "shapetype")).map((e) => [e.getAttribute("id") ?? "", e]));
		let id = Math.max(0, ...Array.from(doc.getElementsByTagNameNS(WP, "docPr")).map((e) => Number(e.getAttribute("id")) || 0));
		let count = 0;
		for (const pict of Array.from(doc.getElementsByTagNameNS(W, "pict"))) {
			// Existing modern representations must render once, through their Choice.
			if (pict.parentElement?.namespaceURI === MC) continue;
			const shapes = Array.from(pict.children).filter((e) => e.namespaceURI === V && e.localName !== "shapetype");
			if (!shapes.length) continue;
			// Leave image-only VML to BetterOffice's existing relationship/media importer.
			if (shapes.every((e) => e.localName !== "group" && Array.from(e.children).some((child) => child.namespaceURI === V && child.localName === "imagedata"))) continue;
			try {
				const drawings = shapes.map((shape) => {
					let mediaPath: string, relationshipId: string;
					do { mediaId++; mediaPath = `word/media/inno-vml-${mediaId}.svg`; relationshipId = `rIdInnoVml${mediaId}`; }
					while (filenames.has(mediaPath) || relationshipIds.has(relationshipId));
					return { ...drawing(shape, types, ++id, relationshipId), mediaPath, relationshipId };
				});
				const alternate = doc.createElementNS(MC, "mc:AlternateContent");
				const choice = doc.createElementNS(MC, "mc:Choice");
				choice.setAttributeNS(XMLNS, "xmlns:pic", PIC); choice.setAttribute("Requires", "pic"); choice.append(...drawings.map((d) => d.drawing));
				const fallback = doc.createElementNS(MC, "mc:Fallback");
				pict.replaceWith(alternate); fallback.append(pict); alternate.append(choice, fallback);
				for (const item of drawings) {
					changed[item.mediaPath] = item.svg; filenames.add(item.mediaPath); relationshipIds.add(item.relationshipId);
					const relationship = rels.createElementNS(RELS, "Relationship");
					relationship.setAttribute("Id", item.relationshipId); relationship.setAttribute("Type", `${R}/image`); relationship.setAttribute("Target", item.mediaPath.slice("word/".length));
					rels.documentElement.append(relationship);
				}
				count += shapes.length;
			} catch { unsupported += shapes.length; }
		}
		if (count) { changed[name] = serialize(doc); changed[relPath] = serialize(rels); converted += count; }
	}
	if (!converted) return { bytes: buffer, converted, unsupported };
	if (!stories["[Content_Types].xml"]) throw new Error("Missing Word content types");
	const contentTypes = parse(strFromU8(stories["[Content_Types].xml"]));
	// Per-part overrides also work when a package has an unrelated SVG default.
	for (const name of Object.keys(changed).filter((name) => name.endsWith(".svg"))) {
		const override = contentTypes.createElementNS(CT, "Override");
		override.setAttribute("PartName", `/${name}`); override.setAttribute("ContentType", "image/svg+xml"); contentTypes.documentElement.append(override);
	}
	changed["[Content_Types].xml"] = serialize(contentTypes);
	expanded = 0;
	const parts = unzipSync(buffer, { filter: (file) => {
		expanded += file.originalSize;
		if (expanded > 128 * 1024 * 1024) throw new Error("Word package too large");
		return true;
	} });
	return { bytes: zipSync({ ...parts, ...changed }), converted, unsupported };
}
