/**
 * OMML (Office Math Markup Language) → MathML conversion for the browser editor.
 *
 * BetterOffice 0.4.3 round-trips `m:oMath` verbatim but only paints the plain
 * text, so fractions, subscripts and equation numbers collapse into one line.
 * This module converts the equation structures that appear in real documents
 * into MathML; render-math.ts then typesets the MathML to SVG. The original
 * OMML stays in the package and is put back before saving (prepare-math.ts).
 */

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MML = "http://www.w3.org/1998/Math/MathML";

export class UnsupportedMathError extends Error {
	constructor(public readonly element: string) { super(`Unsupported math element: ${element}`); }
}

export interface MathRow {
	/** Inner MathML for the row content (no <math> root). */
	mathml: string;
	/**
	 * Word's `#(number)` equation-number convention: content after a top-level
	 * `#` run is flushed right by Word. Converted separately so the renderer can
	 * place it at the line edge like Word does.
	 */
	number: string | null;
}

const serializer = new XMLSerializer();
const mathDocument = document.implementation.createDocument(MML, "math");

function build(name: string, attrs: Record<string, string> = {}, text?: string): Element {
	const node = mathDocument.createElementNS(MML, name);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	if (text != null) node.textContent = text;
	return node;
}

function serialize(node: Element): string {
	return serializer.serializeToString(node);
}

function isM(node: Node, local: string): boolean {
	return node.nodeType === 1 && (node as Element).namespaceURI === M && (node as Element).localName === local;
}

function childrenOf(source: Element, local?: string): Element[] {
	const all = Array.from(source.children);
	return local ? all.filter((child) => isM(child, local)) : all;
}

function firstChild(source: Element, local: string): Element | null {
	return childrenOf(source, local)[0] ?? null;
}

/** m:val attribute with OOXML's on/off/1/0 semantics; absent means the default. */
function boolProp(holder: Element | null, local: string, fallback: boolean): boolean {
	const node = holder ? firstChild(holder, local) : null;
	if (!node) return fallback;
	const value = node.getAttributeNS(M, "val") || node.getAttribute("m:val");
	if (!value) return fallback;
	return !/^(?:f|false|0)$/i.test(value);
}

function valProp(holder: Element | null, local: string): string | null {
	const node = holder ? firstChild(holder, local) : null;
	if (!node) return null;
	return node.getAttributeNS(M, "val") || node.getAttribute("m:val") || null;
}

function variantAttrs(variant: "auto" | "normal" | "bold"): Record<string, string> {
	if (variant === "normal") return { mathvariant: "normal" };
	if (variant === "bold") return { mathvariant: "bold" };
	return {};
}

const LETTER = /[\p{L}]/u;
const OPERATOR = /^[[\]{}(\-+=<>,;.:!|/×÷≈≠≤≥±·∂∇∞′″°]$/u;

/**
 * Split run text into MathML tokens. OMML has no per-character markup; Word
 * renders letters italic and digits/operators upright by its math font rules.
 */
function appendTokens(target: Element, text: string, variant: "auto" | "normal" | "bold"): void {
	let run = "";
	let kind: "digit" | "letter" | "space" | "other" | null = null;
	const flush = () => {
		if (!run || !kind) return;
		if (kind === "space") {
			// MathML collapses plain spaces inside token elements; NBSP keeps the
			// authored spacing of runs like "RI = 1.26".
			target.append(build("mtext", {}, "\u00A0".repeat(run.length)));
		} else if (kind === "digit") {
			target.append(build("mn", variantAttrs(variant), run));
		} else if (kind === "letter") {
			target.append(build("mi", variantAttrs(variant), run));
		} else {
			target.append(build([...run].every((ch) => OPERATOR.test(ch)) ? "mo" : "mtext", variantAttrs(variant), run));
		}
		run = "";
		kind = null;
	};
	for (const ch of text) {
		const next: "digit" | "letter" | "space" | "other" = /[0-9.]/.test(ch) ? "digit" : /\s/.test(ch) ? "space" : LETTER.test(ch) ? "letter" : "other";
		if (kind !== next && !(kind === "other" && next === "other")) flush();
		kind = next;
		run += ch;
	}
	flush();
}

/** Convert `m:r`; `m:ctrlPr` and `w:rPr` font formatting is intentionally ignored. */
function convertRun(run: Element): Element {
	const target = build("mrow");
	const properties = firstChild(run, "rPr");
	const style = valProp(properties, "sty");
	const variant = style === "p" || style === "lit" || boolProp(properties, "nor", false) ? "normal" : style === "b" || style === "bi" ? "bold" : "auto";
	for (const text of childrenOf(run, "t")) appendTokens(target, text.textContent ?? "", variant);
	return target;
}

/** Property elements (`m:*Pr`, `m:ctrlPr`) never carry display content. */
function isPropertyElement(node: Element): boolean {
	const local = node.localName ?? "";
	return local === "ctrlPr" || (local.endsWith("Pr") && local !== "Pr");
}

function convertGroup(source: Element | null): Element {
	const row = build("mrow");
	if (source) for (const child of childrenOf(source)) if (!isPropertyElement(child)) row.append(convertNode(child));
	return row;
}

/** Convert one structural OMML element to its MathML counterpart. */
function convertNode(node: Element): Element {
	switch (node.localName) {
		case "r": return convertRun(node);
		case "f": {
			const fraction = build("mfrac");
			fraction.append(convertGroup(firstChild(node, "num")), convertGroup(firstChild(node, "den")));
			return fraction;
		}
		case "sSub": {
			const base = build("msub");
			base.append(convertGroup(firstChild(node, "e")), convertGroup(firstChild(node, "sub")));
			return base;
		}
		case "sSup": {
			const base = build("msup");
			base.append(convertGroup(firstChild(node, "e")), convertGroup(firstChild(node, "sup")));
			return base;
		}
		case "sSubSup": {
			const base = build("msubsup");
			base.append(convertGroup(firstChild(node, "e")), convertGroup(firstChild(node, "sub")), convertGroup(firstChild(node, "sup")));
			return base;
		}
		case "d": {
			const properties = firstChild(node, "dPr");
			const open = valProp(properties, "begChr") ?? "(";
			const close = valProp(properties, "endChr") ?? ")";
			const separator = valProp(properties, "sepChr") ?? "|";
			const row = build("mrow");
			row.append(build("mo", { fence: "true" }, open || "\u200A"));
			const groups = childrenOf(node, "e");
			groups.forEach((group, index) => {
				if (index > 0) row.append(build("mo", {}, separator || "\u200A"));
				row.append(convertGroup(group));
			});
			row.append(build("mo", { fence: "true" }, close || "\u200A"));
			return row;
		}
		case "nary": {
			const properties = firstChild(node, "naryPr");
			const hasSub = !boolProp(properties, "subHide", false) && firstChild(node, "sub") != null;
			const hasSup = !boolProp(properties, "supHide", false) && firstChild(node, "sup") != null;
			const limits = (valProp(properties, "limLoc") ?? "undOvr") === "undOvr";
			let core: Element = build("mo", { stretchy: "true" }, valProp(properties, "chr") ?? "\u222B");
			if (hasSub && hasSup) {
				const combination = build(limits ? "munderover" : "msubsup");
				combination.append(core, convertGroup(firstChild(node, "sub")), convertGroup(firstChild(node, "sup")));
				core = combination;
			} else if (hasSub) {
				const combination = build(limits ? "munder" : "msub");
				combination.append(core, convertGroup(firstChild(node, "sub")));
				core = combination;
			} else if (hasSup) {
				const combination = build(limits ? "mover" : "msup");
				combination.append(core, convertGroup(firstChild(node, "sup")));
				core = combination;
			}
			const base = firstChild(node, "e");
			if (!base || !childrenOf(base).length) return core;
			const row = build("mrow");
			row.append(core, convertGroup(base));
			return row;
		}
		case "rad": {
			const degree = firstChild(node, "deg");
			const hideDegree = boolProp(firstChild(node, "radPr"), "degHide", false) || !degree || !childrenOf(degree).length;
			if (hideDegree) {
				const root = build("msqrt");
				root.append(convertGroup(firstChild(node, "e")));
				return root;
			}
			const root = build("mroot");
			root.append(convertGroup(firstChild(node, "e")), convertGroup(degree));
			return root;
		}
		case "func": {
			const row = build("mrow");
			row.append(convertGroup(firstChild(node, "fName")), convertGroup(firstChild(node, "e")));
			return row;
		}
		case "acc": {
			const over = build("mover");
			over.append(convertGroup(firstChild(node, "e")), build("mo", { stretchy: "true" }, valProp(firstChild(node, "accPr"), "chr") ?? "\u0302"));
			return over;
		}
		case "bar": {
			const position = valProp(firstChild(node, "barPr"), "pos") ?? "top";
			const lined = build(position === "bot" ? "munder" : "mover");
			lined.append(convertGroup(firstChild(node, "e")), build("mo", {}, "\u00AF"));
			return lined;
		}
		case "m": {
			// Matrix: column alignment comes from m:mcs/m:mc/m:mcPr/m:mcJc.
			const properties = firstChild(node, "mPr");
			const scheme = properties ? firstChild(properties, "mcs") : null;
			const alignment = scheme ? childrenOf(scheme, "mc").map((column) => valProp(firstChild(column, "mcPr"), "mcJc") ?? "center") : [];
			const table = build("mtable");
			if (alignment.length) table.setAttribute("columnalign", alignment.join(" "));
			for (const matrixRow of childrenOf(node, "mr")) {
				const row = build("mtr");
				childrenOf(matrixRow, "e").forEach((cell, index) => {
					const cellNode = build("mtd", alignment[index] && alignment[index] !== "center" ? { columnalign: alignment[index] } : {});
					cellNode.append(convertGroup(cell));
					row.append(cellNode);
				});
				table.append(row);
			}
			return table;
		}
		case "limLow": {
			const under = build("munder");
			under.append(convertGroup(firstChild(node, "e")), convertGroup(firstChild(node, "lim")));
			return under;
		}
		case "limUpp": {
			const over = build("mover");
			over.append(convertGroup(firstChild(node, "e")), convertGroup(firstChild(node, "lim")));
			return over;
		}
		case "eqArr": {
			// Nested equation array inside a row: stack its entries as a table.
			const table = build("mtable");
			for (const entry of childrenOf(node, "e")) {
				const row = build("mtr");
				const cell = build("mtd");
				cell.append(convertGroup(entry));
				row.append(cell);
				table.append(row);
			}
			return table;
		}
		case "box":
		case "e":
		case "num":
		case "den":
		case "sub":
		case "sup":
		case "deg":
		case "fName":
		case "lim":
		case "mr":
			return convertGroup(node);
		default:
			throw new UnsupportedMathError(node.localName ?? "unknown");
	}
}

/**
 * Word's equation-number convention: a run whose text contains `#` at the top
 * level of an equation row starts the right-flushed number part. Content before
 * the marker stays with the equation, content after becomes the number.
 */
function splitEquationNumber(nodes: Element[]): { content: Element[]; number: Element[] | null } {
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (!isM(node, "r") || isPropertyElement(node)) continue;
		const text = node.textContent ?? "";
		const marker = text.indexOf("#");
		if (marker < 0) continue;
		const content = nodes.slice(0, index);
		const cloneWithText = (value: string) => {
			const clone = node.cloneNode(true) as Element;
			for (const target of Array.from(clone.getElementsByTagNameNS(M, "t"))) target.textContent = value;
			return clone;
		};
		if (text.slice(0, marker)) content.push(cloneWithText(text.slice(0, marker)));
		const number = nodes.slice(index + 1);
		if (text.slice(marker + 1)) number.unshift(cloneWithText(text.slice(marker + 1)));
		return { content, number };
	}
	return { content: nodes, number: null };
}

function rowToMathml(nodes: Element[]): MathRow {
	const { content, number } = splitEquationNumber(nodes.filter((node) => !isPropertyElement(node)));
	const row = build("mrow");
	for (const node of content) row.append(convertNode(node));
	let numberMathml: string | null = null;
	if (number) {
		const holder = build("mrow");
		for (const node of number) holder.append(convertNode(node));
		numberMathml = serialize(holder);
	}
	return { mathml: serialize(row), number: numberMathml };
}

/** Rows of one equation; an equation array (m:eqArr) yields multiple rows. */
function convertEquation(oMath: Element): MathRow[] {
	const arrays = childrenOf(oMath, "eqArr");
	if (!arrays.length) return [rowToMathml(childrenOf(oMath))];
	const rows: MathRow[] = [];
	for (const array of arrays) {
		for (const entry of childrenOf(array, "e")) rows.push(rowToMathml(childrenOf(entry)));
	}
	return rows;
}

/** Convert an `m:oMath` or `m:oMathPara` element into renderable rows. */
export function convertOmml(source: Element): MathRow[] {
	if (source.namespaceURI !== M) throw new UnsupportedMathError(source.localName ?? "non-omml");
	if (source.localName === "oMathPara") {
		const rows: MathRow[] = [];
		for (const equation of childrenOf(source, "oMath")) rows.push(...convertEquation(equation));
		return rows.length ? rows : [{ mathml: serialize(build("mrow")), number: null }];
	}
	if (source.localName === "oMath") return convertEquation(source);
	throw new UnsupportedMathError(source.localName ?? "unknown");
}
