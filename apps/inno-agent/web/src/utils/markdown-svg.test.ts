import { describe, expect, it } from "vitest";
import { wrapRawSvgBlocks } from "./markdown-svg.js";

const CHART_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">',
	'  <defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/></linearGradient></defs>',
	'  <rect x="0" y="0" width="100" height="40" fill="url(#g)"/>',
	'  <text x="10" y="20">hello</text>',
	"</svg>",
].join("\n");

describe("wrapRawSvgBlocks", () => {
	it("wraps a bare svg block into an svg fence", () => {
		const source = `这是本周天气：\n\n${CHART_SVG}\n\n以上。`;
		const result = wrapRawSvgBlocks(source);
		expect(result).toContain(`\`\`\`svg\n${CHART_SVG}\n\`\`\``);
		expect(result).toContain("这是本周天气：");
		expect(result).toContain("以上。");
	});

	it("wraps an svg that shares its lines with surrounding text", () => {
		const source = `前缀 <svg viewBox="0 0 1 1"><path d="M0 0h1"/></svg> 后缀`;
		const result = wrapRawSvgBlocks(source);
		expect(result).toContain('```svg\n<svg viewBox="0 0 1 1"><path d="M0 0h1"/></svg>\n```');
	});

	it("wraps multiple svg blocks", () => {
		const source = `${CHART_SVG}\n\n中间\n\n${CHART_SVG}`;
		const result = wrapRawSvgBlocks(source);
		expect(result.match(/```svg/g)).toHaveLength(2);
	});

	it("leaves svg inside an existing fence untouched", () => {
		const source = `\`\`\`svg\n${CHART_SVG}\n\`\`\``;
		expect(wrapRawSvgBlocks(source)).toBe(source);
	});

	it("leaves svg inside an html fence untouched", () => {
		const source = `\`\`\`html\n<div>${CHART_SVG}</div>\n\`\`\``;
		expect(wrapRawSvgBlocks(source)).toBe(source);
	});

	it("leaves svg inside an unclosed (streaming) fence untouched", () => {
		const source = `\`\`\`html\n${CHART_SVG}`;
		expect(wrapRawSvgBlocks(source)).toBe(source);
	});

	it("still wraps svg after a closed fence", () => {
		const source = `\`\`\`js\nconsole.log(1)\n\`\`\`\n\n${CHART_SVG}`;
		const result = wrapRawSvgBlocks(source);
		expect(result).toContain("```js\nconsole.log(1)\n```");
		expect(result).toContain(`\`\`\`svg\n${CHART_SVG}\n\`\`\``);
	});

	it("ignores an unclosed svg tag", () => {
		const source = "看这里 <svg viewBox=\"0 0 1 1\"><path d=\"M0 0h1\"/>";
		expect(wrapRawSvgBlocks(source)).toBe(source);
	});

	it("returns content without svg unchanged", () => {
		const source = "普通 **markdown** 文本";
		expect(wrapRawSvgBlocks(source)).toBe(source);
	});

	it("handles CRLF line endings", () => {
		const source = `介绍\r\n\r\n${CHART_SVG.replace(/\n/g, "\r\n")}`;
		const result = wrapRawSvgBlocks(source);
		expect(result).toContain("```svg\n<svg");
	});
});
