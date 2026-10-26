/** Spreadsheet/presentation tools backed by the shared LibreOffice bridge.
 * Handles belong to this tool instance and their opening workspace. Word
 * editing is intentionally excluded from this change.
 */

import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { logger } from "../logger.js";
import { getOfficeEngine, type OfficeEngine } from "../office/engine-locator.js";
import { getUnoSidecar, type UnoCallResult } from "../office/uno-sidecar.js";

const OP_VOCABULARY = [
	"sheet（Excel）: list_sheets{}、get_range{sheet?,range}、set_cell{sheet?,cell,value}、",
	"  append_row{sheet?,values[]}、insert_rows{sheet?,index,count}",
	"slide（PPT）: list_slides{}、add_slide{index?,title?,body?}、",
	"  set_slide_text{slide,shape,text}、delete_slide{index}",
].join("\n");

const PPTX_DSL_CONTRACT = [
	"pptx 的幻灯片 DSL（16:9 画布，引擎按版式自动排版，不要手写坐标）：",
	'- {"layout":"title","title":"主标题","subtitle":"副标题"} — 封面页',
	'- {"layout":"section","title":"章节名"} — 章节分隔页（色块底）',
	'- {"layout":"bullets","title":"页标题","bullets":["要点1","要点2",...],"notes":"演讲者备注"}',
	'- {"layout":"two_column","title":"页标题","left":["左列要点"],"right":["右列要点"],"notes":"..."}',
	"- 每页要点 ≤5 条、每条 ≤30 字；accent 字段可指定主题色（#RRGGBB）。",
].join("\n");

function textResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details: (details ?? {}) as Record<string, unknown>,
	};
}

function formatFailure(step: string, res: UnoCallResult): string {
	return `Office 引擎调用失败（${step}）：${res.error ?? "未知错误"}`;
}

export function createOfficeTools(getWorkspaceDir: () => string): ToolDefinition[] {
	async function resolveWorkspacePath(filePath: string): Promise<{ path: string } | { error: string }> {
		const workspaceDir = getWorkspaceDir();
		const resolvedPath = filePath.trim() ? await resolveContainedPathAsync(workspaceDir, filePath) : null;
		if (!resolvedPath) {
			return {
				error:
					`路径不在当前工作区内，已拒绝：${filePath}。` +
					"请使用当前工作区内的相对路径或工作区内的绝对路径。",
			};
		}
		return { path: resolvedPath };
	}

	const owned = new Map<string, { workspace: string; path: string }>();
	async function checkHandle(docId: string): Promise<boolean> {
		const entry = owned.get(docId);
		return !!entry && entry.workspace === getWorkspaceDir()
			&& !!(await resolveContainedPathAsync(entry.workspace, entry.path));
	}
	function handleRejected() {
		return textResult("文档句柄不属于当前会话/工作区，请在当前工作区重新打开文档。", { error: "handle_rejected" });
	}

	const engineStatus = defineTool({
		name: "office_engine_status",
		label: "Office 引擎状态",
		description:
			"检查 LibreOffice 文档引擎是否可用（随包内置或系统安装），返回版本与来源。" +
			"在处理 Excel/PPT 文档前可先调用以确认能力；不可用时会给出安装指引。",
		parameters: Type.Object({}),
		async execute() {
			let engine: OfficeEngine;
			try {
				engine = await getOfficeEngine();
			} catch (err) {
				const code = err instanceof Error ? err.message : String(err);
				if (code === "WORD_ENGINE_INCOMPATIBLE") {
					return textResult(
						"检测到 LibreOffice 26.8.0，该版本存在中文行距回归（tdf#171275，26.8.1 修复），" +
						"文档引擎拒绝使用。请升级 LibreOffice 至 26.8.1 或更高版本后重试。",
						{ available: false, reason: "engine_incompatible" },
					);
				}
				return textResult(
					"未找到 LibreOffice 引擎。桌面安装包已内置；当前环境请安装 LibreOffice" +
					"（macOS: brew install --cask libreoffice，Ubuntu: apt-get install libreoffice）" +
					"或设置 INNO_LIBREOFFICE_PATH 指向 soffice。",
					{ available: false },
				);
			}
			return textResult(
				`LibreOffice 可用：${engine.version ?? "版本未知"}（路径：${engine.path}）`,
				{ available: true, sofficePath: engine.path, version: engine.version },
			);
		},
	});

	const createDocument = defineTool({
		name: "office_create_document",
		label: "生成 Office 文档",
		description:
			"从零生成一份新的 PPT/Excel 文档到工作区。模型只写受限中间格式，OOXML 由引擎生成：\n" +
			PPTX_DSL_CONTRACT + "\n" +
			'xlsx：sheets 数组 [{"name":"表名","rows":[[首行表头...],[数据行...]]}]，首行自动加粗。\n' +
			"生成后建议用 office_render_document 渲染成 PDF/PNG 做版式回检，发现问题用本工具重新生成或 office_edit_document 微调。",
		parameters: Type.Object({
			path: Type.String({ description: "目标文件（工作区内，扩展名决定类型：.pptx/.xlsx/.odp/.ods）" }),
			slides: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description: "pptx：幻灯片 DSL 数组",
			})),
			accent: Type.Optional(Type.String({ description: "pptx：主题色 #RRGGBB（默认 #2563EB）" })),
			sheets: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description: "xlsx：[{name, rows}]",
			})),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, slides, accent, sheets } = params as {
				path: string; slides?: Record<string, unknown>[];
				accent?: string; sheets?: Record<string, unknown>[];
			};
			const resolved = await resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
			const ext = /\.([a-z]+)$/i.exec(resolved.path)?.[1]?.toLowerCase() ?? "";
			let spec: Record<string, unknown>;
			if (ext === "pptx" || ext === "odp") {
				if (!Array.isArray(slides) || slides.length === 0) {
					return textResult("生成 pptx 需要 slides 参数（幻灯片 DSL 数组）。", { error: "missing_slides" });
				}
				spec = { slides, ...(accent ? { accent } : {}) };
			} else if (ext === "xlsx" || ext === "ods") {
				if (!Array.isArray(sheets) || sheets.length === 0) {
					return textResult("生成 xlsx 需要 sheets 参数（[{name, rows}]）。", { error: "missing_sheets" });
				}
				spec = { sheets };
			} else {
				return textResult(`不支持的目标格式 .${ext}（支持 pptx/xlsx/odp/ods）。`, { error: "bad_ext" });
			}
			const sidecar = getUnoSidecar();
			const created = await sidecar.call<{ created: string; kind: string }>(
				"create", { path: resolved.path, spec });
			if (!created.ok) return textResult(formatFailure("create", created), { error: created.error });
			logger.info({ kind: created.result!.kind }, "office_create_document: created");
			return textResult(
				`已生成 ${created.result!.kind} 文档：${rawPath}。` +
				"如需校验版式，调用 office_render_document 渲染为 PDF 或 PNG。",
				{ created: created.result!.created, kind: created.result!.kind },
			);
		},
	});

	const openDocument = defineTool({
		name: "office_open_document",
		label: "打开 Office 文档",
		description:
			"用 LibreOffice 引擎打开工作区内的 xlsx/pptx（也支持 ods/odp）文档，" +
			"返回 docId、文档类型和结构大纲（工作表列表 / 幻灯片列表）。" +
			"之后用 office_edit_document 基于 docId 做原子编辑，用 office_close_document 关闭。",
		parameters: Type.Object({
			path: Type.String({ description: "工作区内文档路径（相对或绝对）" }),
			readOnly: Type.Optional(Type.Boolean({ description: "只读打开（默认 false）" })),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, readOnly } = params as { path: string; readOnly?: boolean };
			const resolved = await resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
			if (![".xlsx", ".ods", ".pptx", ".odp"].includes(extname(resolved.path).toLowerCase())) return textResult("仅支持表格和演示文稿。", { error: "bad_ext" });
			const workspace = getWorkspaceDir();
			const sidecar = getUnoSidecar();
			const opened = await sidecar.call<{ docId: string; kind: string; path: string }>(
				"open", { path: resolved.path, readOnly: readOnly === true });
			if (!opened.ok) return textResult(formatFailure("open", opened), { error: opened.error });
			const outline = await sidecar.call("inspect", { docId: opened.result!.docId });
			if (!outline.ok) {
				await sidecar.call("close", { docId: opened.result!.docId });
				return textResult(formatFailure("inspect", outline), { error: outline.error });
			}
			const { docId, kind } = opened.result!;
			owned.set(docId, { workspace, path: resolved.path });
			logger.info({ docId, kind }, "office_open_document: opened");
			return textResult(
				`已打开 ${kind} 文档（docId: ${docId}）。结构大纲：\n` +
				JSON.stringify(outline.result, null, 2),
				{ docId, kind, outline: outline.result },
			);
		},
	});

	const editDocument = defineTool({
		name: "office_edit_document",
		label: "编辑 Office 文档",
		description:
			"对已打开的文档执行一批原子编辑操作（按顺序执行，单个失败不中断后续），" +
			"可选择保存。先用 office_open_document 拿到 docId 和结构大纲再编辑。\n" +
			"支持的操作：\n" + OP_VOCABULARY,
		parameters: Type.Object({
			docId: Type.String({ description: "office_open_document 返回的 docId" }),
			ops: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description: "原子操作列表，如 [{\"op\":\"set_cell\",\"cell\":\"A1\",\"value\":\"新\"}]",
			}),
			save: Type.Optional(Type.Boolean({ description: "编辑后保存到原文件（默认 false）" })),
			saveAs: Type.Optional(Type.String({ description: "另存为工作区内路径（优先于 save）" })),
		}),
		async execute(_toolCallId, params) {
			const { docId, ops, save, saveAs } = params as {
				docId: string; ops: Record<string, unknown>[]; save?: boolean; saveAs?: string;
			};
			if (!docId) return textResult("缺少 docId。", { error: "missing_doc_id" });
			if (!(await checkHandle(docId))) return handleRejected();
			if (!Array.isArray(ops) || ops.length === 0) {
				return textResult("ops 为空：至少需要一个原子操作。", { error: "empty_ops" });
			}
			if (ops.length > 100) {
				return textResult("单次最多 100 个操作，请分批提交。", { error: "too_many_ops" });
			}
			let target: string | undefined;
			if (saveAs) {
				const resolved = await resolveWorkspacePath(saveAs);
				if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
				target = resolved.path;
			}
			const sidecar = getUnoSidecar();
			const edited = await sidecar.call<{ results: { op: string; ok: boolean; error?: string }[] }>(
				"exec", { docId, ops });
			if (!edited.ok) return textResult(formatFailure("exec", edited), { error: edited.error });

			const results = edited.result!.results;
			const failed = results.filter((r) => !r.ok);

			let saveNote = "";
			if (failed.length === 0 && (save === true || saveAs)) {
				const saved = await sidecar.call("save", target ? { docId, path: target } : { docId });
				if (saved.ok && target) owned.get(docId)!.path = target;
				saveNote = saved.ok
					? `\n已保存：${(saved.result as { saved: string }).saved}`
					: `\n保存失败：${saved.error}`;
			} else if (failed.length > 0 && (save === true || saveAs)) {
				saveNote = "\n存在失败操作，已跳过保存（修正后可再次保存）。";
			}

			const lines = results.map((r, i) =>
				r.ok ? `✓ #${i + 1} ${r.op}` : `✗ #${i + 1} ${r.op}：${r.error}`);
			return textResult(
				`执行 ${results.length} 个操作，成功 ${results.length - failed.length}，失败 ${failed.length}：\n` +
				lines.join("\n") + saveNote,
				{ results, saved: saveNote.includes("已保存") },
			);
		},
	});

	const renderDocument = defineTool({
		name: "office_render_document",
		label: "渲染 Office 文档",
		description:
			"把工作区内的 Office 文档渲染成 PDF，format=\"png\" 时再把每页栅格化为 PNG" +
			"（供支持视觉的模型 read 查看，做生成/编辑后的版式回检：溢出、错位、空白页）。" +
			"输出到工作区的 .inno-previews/ 目录。",
		parameters: Type.Object({
			path: Type.String({ description: "工作区内文档路径（相对或绝对）" }),
			format: Type.Optional(Type.Union([Type.Literal("pdf"), Type.Literal("png")], {
				description: "输出格式，默认 pdf",
			})),
			maxPages: Type.Optional(Type.Number({ description: "png 模式最多渲染页数，默认 5" })),
			outDir: Type.Optional(Type.String({ description: "输出目录（工作区内，默认 .inno-previews）" })),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, format, maxPages, outDir } = params as {
				path: string; format?: "pdf" | "png"; maxPages?: number; outDir?: string;
			};
			const resolved = await resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
			const dirResolved = await resolveWorkspacePath(outDir?.trim() || ".inno-previews");
			if ("error" in dirResolved) return textResult(dirResolved.error, { error: "path_rejected" });
			await mkdir(dirResolved.path, { recursive: true });
			const sidecar = getUnoSidecar();
			const converted = await sidecar.call<{ output: string }>(
				"convert", { path: resolved.path, to: "pdf", outDir: dirResolved.path });
			if (!converted.ok) return textResult(formatFailure("convert", converted), { error: converted.error });
			const pdfPath = converted.result!.output;
			if (format !== "png") {
				return textResult(`已渲染 PDF：${pdfPath}`, { output: pdfPath });
			}
			try {
				const { renderPdfToPngs } = await import("../office/pdf-render.js");
				const pngs = await renderPdfToPngs(pdfPath, dirResolved.path, {
					maxPages: maxPages && maxPages > 0 ? Math.min(maxPages, 20) : 5,
				});
				return textResult(
					`已渲染 PDF：${pdfPath}\nPNG 页面（可用 read 查看做版式回检）：\n${pngs.join("\n")}`,
					{ output: pdfPath, pages: pngs },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return textResult(`PDF 已生成（${pdfPath}），但 PNG 栅格化失败：${msg}`, {
					output: pdfPath, error: msg,
				});
			}
		},
	});

	const closeDocument = defineTool({
		name: "office_close_document",
		label: "关闭 Office 文档",
		description:
			"关闭 office_open_document 打开的文档句柄，释放 LibreOffice 内存。" +
			"编辑任务结束后调用；未保存的修改会丢失（需要保存请用 office_edit_document 的 save/saveAs）。",
		parameters: Type.Object({
			docId: Type.String({ description: "要关闭的 docId" }),
		}),
		async execute(_toolCallId, params) {
			const { docId } = params as { docId: string };
			if (!docId) return textResult("缺少 docId。", { error: "missing_doc_id" });
			if (!(await checkHandle(docId))) return handleRejected();
			const sidecar = getUnoSidecar();
			const closed = await sidecar.call("close", { docId });
			if (!closed.ok) return textResult(formatFailure("close", closed), { error: closed.error });
			owned.delete(docId);
			return textResult(`已关闭文档 ${docId}。`, { closed: docId });
		},
	});

	return [engineStatus, createDocument, openDocument, editDocument, renderDocument, closeDocument];
}
