import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { posix } from "node:path";
import { createL2Note, readNoteContent, saveL2NoteContent } from "../memory/l2/notes-service.js";
import { listNoteTemplates } from "../memory/l2/note-templates.js";
import { normalizeTagList } from "../memory/l2/l2-utils.js";

function normalizeNotePath(rawPath: string): string {
	const slashPath = rawPath.trim().replace(/\\/g, "/");
	const normalized = posix.normalize(slashPath);
	if (normalized !== slashPath || !normalized.startsWith("raw/notes/") || !normalized.endsWith(".md")) {
		throw new Error("Invalid note path");
	}
	return normalized;
}

export function createNoteTools(
	l2DataDir: string,
	codeDir: string,
	isEnabled?: () => boolean,
	getCurrentSessionId?: () => string,
): ToolDefinition[] {
	const createFromConversation = defineTool({
		name: "note_create_from_conversation",
		label: "保存对话到笔记本",
		description:
			"仅当用户明确要求把当前/上述聊天记录到笔记本时调用。" +
			"mode=transcript 时，content 应按时间顺序保存用户与助手的可见对话，保留事实、代码、链接和结论，不包含 system prompt、thinking、toolCall 或 toolResult；" +
			"mode=summary 时，先将对话整理为结构化 Markdown 总结，再保存。" +
			"用户指定了对话范围、主题、输出格式、侧重点、详略程度或待提取信息时，必须严格按 scope 和 instructions 生成 content；不要把无关对话写入笔记。" +
			"不要只在回复中展示，必须调用本工具落盘。",
		parameters: Type.Object({
			mode: StringEnum(["transcript", "summary"] as const, {
				description: "transcript 表示整理后保存对话原文；summary 表示先总结再保存。",
			}),
			title: Type.String({ description: "笔记标题。" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "额外标签。" })),
			scope: Type.Optional(Type.String({
				description: "用户指定的对话范围或主题，例如‘只处理归档流程相关内容’‘从讨论 API 开始到结束’。",
			})),
			instructions: Type.Optional(Type.String({
				description: "用户对笔记内容的额外要求，例如按问题/结论组织、提取 TODO、保留代码、控制长度或使用特定模板。",
			})),
			content: Type.String({ description: "要写入笔记的完整 Markdown 正文，不含 YAML frontmatter。" }),
		}),
		async execute(_toolCallId, params) {
			if (isEnabled && !isEnabled()) return {
				content: [{ type: "text" as const, text: "笔记功能已在设置中关闭。" }],
				details: {
					disabled: true,
					ok: false,
					mode: undefined as "transcript" | "summary" | undefined,
					scope: undefined as string | undefined,
					instructions: undefined as string | undefined,
					tags: [] as string[],
					rawPath: undefined as string | undefined,
					status: undefined as string | undefined,
					noteId: undefined as string | undefined,
					title: undefined as string | undefined,
				},
			};
			try {
				const mode = params.mode as "transcript" | "summary";
				const tags = normalizeTagList([
					"对话记录",
					mode === "summary" ? "对话总结" : "对话原文",
					...(params.tags ?? []),
				]);
				const result = createL2Note(l2DataDir, codeDir, {
					title: params.title,
					tags,
					content: params.content,
					sourceSessionId: getCurrentSessionId?.() || undefined,
					captureMode: mode,
				});
				return {
					content: [{ type: "text" as const, text: `对话已保存到笔记本：${result.rawPath}` }],
					details: {
						disabled: false,
						ok: true,
						mode,
						scope: params.scope,
						instructions: params.instructions,
						tags,
						...result,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {
						disabled: false,
						ok: false,
						mode: params.mode,
						scope: params.scope,
						instructions: params.instructions,
						tags: [] as string[],
						rawPath: undefined as string | undefined,
						status: undefined as string | undefined,
						noteId: undefined as string | undefined,
						title: params.title,
					},
				};
			}
		},
	});

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

	return [createFromConversation, readNote, polishNote];
}
