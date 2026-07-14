import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { posix } from "node:path";
import { readNoteContent, saveL2NoteContent } from "../memory/l2/notes-service.js";
import { listNoteTemplates } from "../memory/l2/note-templates.js";

function normalizeNotePath(rawPath: string): string {
	const slashPath = rawPath.trim().replace(/\\/g, "/");
	const normalized = posix.normalize(slashPath);
	if (normalized !== slashPath || !normalized.startsWith("raw/notes/") || !normalized.endsWith(".md")) {
		throw new Error("Invalid note path");
	}
	return normalized;
}

export function createNoteTools(l2DataDir: string, codeDir: string, isEnabled?: () => boolean): ToolDefinition[] {
	const readNote = defineTool({
		name: "note_read",
		label: "读取笔记",
		description: "读取笔记区 raw/notes/ 下的一篇笔记。用于用户明确要求通过对话查看、整理或润色当前笔记时。",
		parameters: Type.Object({
			rawPath: Type.String({ description: "笔记相对路径，必须以 raw/notes/ 开头。" }),
		}),
		async execute(_toolCallId, params) {
			if (isEnabled && !isEnabled()) return {
				content: [{ type: "text" as const, text: "笔记功能已在设置中关闭。" }],
				details: { disabled: true, ok: false, rawPath: params.rawPath },
			};
			try {
				const rawPath = normalizeNotePath(params.rawPath as string);
				const note = readNoteContent(l2DataDir, rawPath);
				const polishTemplates = listNoteTemplates(codeDir)
					.filter((template) => !template.hidden && template.id !== "blank")
					.map(({ id, label, description, body }) => ({ id, label, description, body }));
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ note, polishTemplates }, null, 2) }],
					details: { disabled: false, ok: true, rawPath: note.rawPath },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { disabled: false, ok: false, rawPath: params.rawPath },
				};
			}
		},
	});

	const polishNote = defineTool({
		name: "note_polish",
		label: "AI 润色笔记",
		description:
			"当用户要求对某篇笔记进行 AI 润色时使用。先调用 note_read 读取笔记及可用模板；若无法确定模板，必须先调用 ask_user_question 让用户选择或说明要求。确认后生成完整 Markdown 正文并调用本工具写回，不要只在回复中展示结果。必须保留事实、数字、链接和任务状态；已归档笔记仍为只读。",
		parameters: Type.Object({
			rawPath: Type.String({ description: "笔记相对路径，必须以 raw/notes/ 开头。" }),
			templateId: Type.Optional(Type.String({ description: "采用的润色模板 ID；用户要求通用整理时可不传。" })),
			title: Type.String({ description: "笔记标题。" }),
			tags: Type.Array(Type.String(), { description: "完整标签列表。" }),
			recordDate: Type.Optional(Type.String({ description: "记录日期，格式 YYYY-MM-DD。" })),
			content: Type.String({ description: "更新后的完整 Markdown 正文，不含 YAML frontmatter。" }),
		}),
		async execute(_toolCallId, params) {
			if (isEnabled && !isEnabled()) return {
				content: [{ type: "text" as const, text: "笔记功能已在设置中关闭。" }],
				details: { disabled: true, ok: false, rawPath: params.rawPath, templateId: params.templateId, status: undefined as string | undefined },
			};
			try {
				const typed = params as {
					rawPath: string;
					templateId?: string;
					title: string;
					tags: string[];
					recordDate?: string;
					content: string;
				};
				const rawPath = normalizeNotePath(typed.rawPath);
				const result = saveL2NoteContent(l2DataDir, rawPath, {
					title: typed.title,
					tags: typed.tags,
					recordDate: typed.recordDate,
					content: typed.content,
				});
				return {
					content: [{ type: "text" as const, text: `笔记已完成 AI 润色：${result.rawPath}` }],
					details: { disabled: false, ok: true, ...result, templateId: typed.templateId, status: result.status as string | undefined },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { disabled: false, ok: false, rawPath: params.rawPath, templateId: params.templateId, status: undefined as string | undefined },
				};
			}
		},
	});

	return [readNote, polishNote];
}
