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

function normalizeDelimitedMath(source: string): string {
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

		if (source[index] === "$" && !source.startsWith("$$", index) && !isEscaped(source, index)) {
			const end = findClosingDollar(source, index + 1);
			if (end !== -1) {
				output += `$${normalizeMathExpression(source.slice(index + 1, end))}$`;
				index = end + 1;
				continue;
			}
		}

		if ((source.startsWith("\\(", index) || source.startsWith("\\[", index)) && !isEscaped(source, index)) {
			const close = source[index + 1] === "(" ? "\\)" : "\\]";
			const end = source.indexOf(close, index + 2);
			if (end !== -1) {
				output += `${source.slice(index, index + 2)}${normalizeMathExpression(source.slice(index + 2, end))}${close}`;
				index = end + 2;
				continue;
			}
		}

		output += source[index];
		index += 1;
	}

	return output;
}

function normalizeOutsideFencedCode(content: string): string {
	const lines = content.split(/(\n)/);
	let inFence = false;
	let fenceMarker = "";
	let output = "";
	let pending = "";

	const flushPending = () => {
		if (pending) {
			output += normalizeDelimitedMath(pending);
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

export function normalizeMarkdownMath(content: string): string {
	if (!content || !/[<&$\\]/.test(content)) return content;
	return normalizeOutsideFencedCode(content);
}
