const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function normalizeMathExpression(source: string): string {
	// MarkdownBlock escapes raw "<" before KaTeX runs, so use TeX relations.
	return source
		.replace(/&amp;(lt|gt|le|ge|ne|times|divide|plusmn|minus|nbsp);/gi, "&$1;")
		.replace(/&#0*60;|&#x0*3c;/gi, "\\lt ")
		.replace(/&#0*62;|&#x0*3e;/gi, "\\gt ")
		.replace(/&lt;/gi, "\\lt ")
		.replace(/&gt;/gi, "\\gt ")
		.replace(/&le;|&leq;/gi, "\\le ")
		.replace(/&ge;|&geq;/gi, "\\ge ")
		.replace(/&ne;|&neq;/gi, "\\ne ")
		.replace(/&times;/gi, "\\times ")
		.replace(/&divide;/gi, "\\div ")
		.replace(/&plusmn;/gi, "\\pm ")
		.replace(/&minus;/gi, "-")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/</g, "\\lt ");
}

function isEscaped(source: string, index: number): boolean {
	let slashCount = 0;
	for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) slashCount += 1;
	return slashCount % 2 === 1;
}

function findClosingDollar(source: string, start: number): number {
	for (let i = start; i < source.length; i += 1) {
		if (source[i] === "\n") return -1;
		if (source[i] === "$" && !isEscaped(source, i)) return i;
	}
	return -1;
}

interface DelimitedMathOptions {
	/**
	 * "preserve" keeps the model-friendly `\(...\)` / `\[...\]` delimiters for
	 * renderers that understand them (mini-lit MarkdownBlock / pi-web-ui).
	 * "streamdown" translates them to remark-math's canonical dollar form:
	 * inline `\(...\)` becomes single-line `$$...$$` (parsed as inline math even
	 * when ambiguous single-dollar math is disabled), display `\[...\]` becomes
	 * a `$$`-fenced block so it keeps display semantics and multi-line content.
	 */
	delimiters: "preserve" | "streamdown";
	/**
	 * Whether the target renderer parses `$...$` as math. When false (Streamdown
	 * with the single-dollar toggle off), `$...$` spans are plain text — e.g.
	 * prices and `$a < $b` comparisons — and must pass through untouched so a
	 * raw `<` is not rewritten to `\lt`.
	 */
	singleDollar: boolean;
}

function normalizeDelimitedMath(source: string, options: DelimitedMathOptions): string {
	let output = "";
	let index = 0;

	while (index < source.length) {
		if (source[index] === "`") {
			const match = /^`+/.exec(source.slice(index));
			const fence = match?.[0] ?? "`";
			const end = source.indexOf(fence, index + fence.length);
			if (end === -1) {
				output += source.slice(index);
				break;
			}
			output += source.slice(index, end + fence.length);
			index = end + fence.length;
			continue;
		}

		if (source.startsWith("$$", index) && !isEscaped(source, index)) {
			const end = source.indexOf("$$", index + 2);
			if (end !== -1) {
				output += `$$${normalizeMathExpression(source.slice(index + 2, end))}$$`;
				index = end + 2;
				continue;
			}
		}

		if (options.singleDollar && source[index] === "$" && !source.startsWith("$$", index) && !isEscaped(source, index)) {
			const end = findClosingDollar(source, index + 1);
			if (end !== -1) {
				output += `$${normalizeMathExpression(source.slice(index + 1, end))}$`;
				index = end + 1;
				continue;
			}
		}

		if ((source.startsWith("\\(", index) || source.startsWith("\\[", index)) && !isEscaped(source, index)) {
			const inline = source[index + 1] === "(";
			const close = inline ? "\\)" : "\\]";
			const end = source.indexOf(close, index + 2);
			if (end !== -1) {
				const expression = normalizeMathExpression(source.slice(index + 2, end));
				if (options.delimiters === "preserve") {
					output += `${source.slice(index, index + 2)}${expression}${close}`;
				} else if (inline) {
					// Inline math must stay on one line for remark-math.
					output += `$$${expression.replace(/\s*\n\s*/g, " ")}$$`;
				} else {
					// remark-math only treats `$$` on its own lines as display math,
					// and a blank line would split the paragraph and leak raw `$$`.
					const body = expression.replace(/\n[ \t]*\n+/g, "\n").trim();
					output += `$$\n${body}\n$$`;
				}
				index = end + 2;
				continue;
			}
		}

		output += source[index];
		index += 1;
	}

	return output;
}

function normalizeOutsideFencedCode(content: string, options: DelimitedMathOptions): string {
	const lines = content.split(/(\n)/);
	let inFence = false;
	let fenceMarker = "";
	let output = "";
	let pending = "";

	const flushPending = () => {
		if (pending) {
			output += normalizeDelimitedMath(pending, options);
			pending = "";
		}
	};

	for (let i = 0; i < lines.length; i += 1) {
		const part = lines[i];
		const isLine = part !== "\n";
		if (!isLine) {
			if (inFence) output += part;
			else pending += part;
			continue;
		}

		const fenceMatch = FENCE_RE.exec(part);
		if (fenceMatch && (!inFence || fenceMatch[1][0] === fenceMarker[0])) {
			if (!inFence) {
				flushPending();
				inFence = true;
				fenceMarker = fenceMatch[1];
			} else if (fenceMatch[1].length >= fenceMarker.length) {
				inFence = false;
				fenceMarker = "";
			}
			output += part;
			continue;
		}

		if (inFence) output += part;
		else pending += part;
	}

	flushPending();
	return output;
}

/**
 * Normalizes math for the mini-lit / pi-web-ui renderers, which parse
 * `$...$`, `\(...\)` (inline) and `$$...$$`, `\[...\]` (display) natively.
 * Delimiters are preserved; only the expressions inside are normalized.
 */
export function normalizeMarkdownMath(content: string): string {
	if (!content || !/[<&$\\]/.test(content)) return content;
	return normalizeOutsideFencedCode(content, { delimiters: "preserve", singleDollar: true });
}

/**
 * Normalizes math for the Streamdown runtime. remark-math only understands
 * dollar delimiters, so LaTeX delimiters are translated: `\(...\)` to
 * single-line `$$...$$` (inline) and `\[...\]` to a `$$` block (display).
 * Pass `singleDollar: false` when the user's inline-`$` toggle is off so
 * prices and plain-text comparisons are left untouched.
 */
export function normalizeMarkdownMathForStreamdown(content: string, options?: { singleDollar?: boolean }): string {
	if (!content || !/[<&$\\]/.test(content)) return content;
	return normalizeOutsideFencedCode(content, {
		delimiters: "streamdown",
		singleDollar: options?.singleDollar ?? true,
	});
}
