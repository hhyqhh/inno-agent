import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";
import { listNoteTemplates } from "./note-templates.js";

export interface PolishNoteRequest {
	title: string;
	tags: string[];
	content: string;
}

export interface PolishNoteResult {
	content: string;
	templateId: string | null;
	templateLabel: string | null;
}

export type PolishPromptRunner = (prompt: string, maxTokens: number, timeoutMs: number) => Promise<string>;

export async function polishNoteContent(
	codeDir: string,
	request: PolishNoteRequest,
	runPrompt: PolishPromptRunner,
): Promise<PolishNoteResult> {
	const title = request.title.trim();
	const content = request.content.trim();
	if (!title || !content) throw new Error("Missing note title or content");

	const templates = listNoteTemplates(codeDir).filter((template) => !template.hidden && template.id !== "blank");
	const sourceExcerpt = content.slice(0, 60_000);
	let matchedTemplate = undefined as (typeof templates)[number] | undefined;
	if (templates.length > 0) {
		const catalog = templates.map((template) => [
			`ID: ${template.id}`,
			`名称: ${template.label}`,
			`用途: ${template.description}`,
			`结构示例:\n${template.body.slice(0, 3_000)}`,
		].join("\n")).join("\n\n---\n\n");
		const classification = await runPrompt(
			`你是笔记模板分类器。判断笔记是否明确符合某个模板。\n\n` +
			`标题：${title}\n标签：${request.tags.join(", ") || "无"}\n内容：\n---\n${sourceExcerpt}\n---\n\n` +
			`可选模板：\n${catalog}\n\n只输出一个模板 ID；没有明显匹配时输出 none。`,
			64,
			45_000,
		);
		const selectedId = classification.trim().toLocaleLowerCase().split(/[^a-z0-9_-]+/)[0];
		matchedTemplate = templates.find((template) => template.id.toLocaleLowerCase() === selectedId);
	}

	const structureInstruction = matchedTemplate
		? `按照“${matchedTemplate.label}”模板的章节与组织方式润色：\n---\n${matchedTemplate.body}\n---`
		: "保留原有信息，根据内容选择清晰、自然的 Markdown 结构。";
	const polished = await runPrompt(
		`你是严谨的中文笔记编辑。请润色下面的笔记。\n\n${structureInstruction}\n\n` +
		`要求：\n` +
		`1. 保留全部事实、数字、专有名词、链接、任务状态和重要细节，不得虚构。\n` +
		`2. 改善标题层级、段落、列表、表格和表达；可删除明显重复，但不要过度摘要。\n` +
		`3. 原文缺失的信息不得猜测。\n` +
		`4. 使用“${title}”作为一级标题，不输出 YAML frontmatter。\n` +
		`5. 只输出 Markdown 正文，不要解释或用代码围栏包裹全文。\n\n` +
		`原始笔记：\n---\n${sourceExcerpt}\n---`,
		8_192,
		120_000,
	);
	if (!polished.trim()) throw new Error("Text model did not return polished content");
	return {
		content: normalizeMarkdownForMilkdown(polished),
		templateId: matchedTemplate?.id ?? null,
		templateLabel: matchedTemplate?.label ?? null,
	};
}
