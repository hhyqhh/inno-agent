/**
 * Models sometimes answer with a raw <svg>...</svg> block directly in the
 * Markdown body instead of an ```svg fence. The sanitize schema only keeps
 * svg/path with a handful of attributes (meant for small inline icons), so
 * a real chart — defs, gradients, rect/text/g — is stripped to an empty box.
 * Wrap bare SVG blocks into ```svg fences so they take the SvgArtifactRenderer
 * path (DOMParser validation, pan/zoom, fullscreen, download) instead of
 * widening the sanitize whitelist.
 *
 * Only fenced-code regions are protected: an <svg> already inside any fence
 * (```svg, ```html, ...) keeps its original semantics. An <svg> inside an
 * inline code span is a documented limitation — the wrapper does not track
 * backtick spans.
 */

const SVG_BLOCK_PATTERN = /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi;
const SVG_PROBE = /<svg[\s>]/i;

interface MarkdownFence {
	marker: string;
}

function parseFenceLine(line: string): MarkdownFence | null {
	const match = /^ {0,3}([`~]{3,})/.exec(line);
	if (!match) return null;
	return { marker: match[1]! };
}

function isClosingFence(line: string, openingMarker: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith(openingMarker[0]!)) return false;
	let markerLength = 0;
	while (markerLength < trimmed.length && trimmed[markerLength] === openingMarker[0]) markerLength += 1;
	return markerLength >= openingMarker.length && trimmed.slice(markerLength).trim().length === 0;
}

function wrapInText(text: string): string {
	SVG_BLOCK_PATTERN.lastIndex = 0;
	return text.replace(SVG_BLOCK_PATTERN, (match) => `\n\n\`\`\`svg\n${match.trim()}\n\`\`\`\n\n`);
}

export function wrapRawSvgBlocks(source: string): string {
	if (!SVG_PROBE.test(source)) return source;
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const parts: string[] = [];
	let textBuffer: string[] = [];
	let fenceMarker: string | null = null;
	const flushText = () => {
		if (textBuffer.length === 0) return;
		parts.push(wrapInText(textBuffer.join("\n")));
		textBuffer = [];
	};
	for (const line of lines) {
		if (fenceMarker === null) {
			const fence = parseFenceLine(line);
			if (fence) {
				flushText();
				fenceMarker = fence.marker;
				parts.push(line);
			} else {
				textBuffer.push(line);
			}
		} else {
			parts.push(line);
			if (isClosingFence(line, fenceMarker)) fenceMarker = null;
		}
	}
	flushText();
	return parts.join("\n");
}
