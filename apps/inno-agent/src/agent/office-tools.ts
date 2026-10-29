/**
 * Office document tools (Office 文档引擎工具) — LibreOffice UNO backend.
 *
 * Exposes a small, schema-on-demand surface instead of one tool per atomic
 * operation (WorkBuddy's editor_sdk ships 37/51/77+ tools; we keep the tool
 * count low and let the model pull structure on demand):
 *
 *   office_engine_status   — is the bundled/system LibreOffice usable?
 *   office_create_document — generate a NEW docx/pptx/xlsx from a
 *                            constrained intermediate form (HTML subset for
 *                            docx, a slide DSL for pptx, row arrays for
 *                            xlsx). The model never writes OOXML directly.
 *   office_open_document   — open docx/xlsx/pptx (+odt/ods/odp), returns
 *                            docId, kind and a structural outline.
 *   office_edit_document   — apply a batch of atomic ops (see OPS below),
 *                            then optionally save in place or save-as.
 *   office_render_document — render an open doc or a file to PDF (visual
 *                            render-check loop / preview asset), optionally
 *                            rasterize pages to PNG for vision inspection.
 *   office_close_document  — release the document handle.
 *
 * All file access is constrained to the active workspace via
 * checkWorkspaceMutationPath.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { logger } from "../logger.js";
import { checkWorkspaceMutationPath } from "./workspace-path-guard.js";
import { getOfficeEngine, type OfficeEngine } from "../office/engine-locator.js";
import { getUnoSidecar, type UnoCallResult } from "../office/uno-sidecar.js";

const OP_VOCABULARY = [
	"doc（Word）: replace_text{find,replace,all?}、set_paragraph{index,text}、",
	"  insert_paragraph{text,style?,index?}（index 表示插到该段落之前，缺省追加到文末）、",
	"  delete_paragraph{index}、insert_table{rows:[[...]],index?}、list_paragraphs{}",
	"sheet（Excel）: list_sheets{}、get_range{sheet?,range}、set_cell{sheet?,cell,value}、",
	"  append_row{sheet?,values[]}、insert_rows{sheet?,index,count}",
	"slide（PPT）: list_slides{}、add_slide{index?,title?,body?}、",
	"  set_slide_text{slide,shape,text}、delete_slide{index}",
].join("\n");

const DOCX_HTML_CONTRACT = [
	"docx 的 HTML 契约（LibreOffice 会映射成真正的 Word 样式）：",
	"- 只使用这些标签：<h1>~<h4>（标题层级）、<p>（正文）、<ul>/<ol>/<li>（列表）、",
	"  <table>/<tr>/<th>/<td>（表格，必须带 border 属性如 <table border=\"1\">）、",
	"  <strong>/<em>、<blockquote>（引用）、<hr>（分页/分隔）。",
	"- 内联样式仅允许：color、font-size（pt）、text-align；不要写 <style> 块、",
	"  class、布局 CSS（浮动/flex/grid）——转换器会忽略或破坏版式。",
	"- 中文字体自动匹配，不需要 font-family。",
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
	function resolveWorkspacePath(filePath: string): { path: string } | { error: string } {
		const workspaceDir = getWorkspaceDir();
		const check = checkWorkspaceMutationPath(workspaceDir, filePath);
		if (!check.allowed || !check.resolvedPath) {
			return {
				error:
					`路径不在当前工作区内，已拒绝：${filePath}。` +
					"请使用当前工作区内的相对路径或工作区内的绝对路径。",
			};
		}
		return { path: check.resolvedPath };
	}

	const engineStatus = defineTool({
		name: "office_engine_status",
		label: "Office 引擎状态",
		description:
			"检查 LibreOffice 文档引擎是否可用（随包内置或系统安装），返回版本与来源。" +
			"在处理 Word/Excel/PPT 文档前可先调用以确认能力；不可用时会给出安装指引。",
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
			"从零生成一份新的 Word/PPT/Excel 文档到工作区。模型只写受限中间格式，OOXML 由引擎生成：\n" +
			DOCX_HTML_CONTRACT + "\n" + PPTX_DSL_CONTRACT + "\n" +
			'xlsx：sheets 数组 [{"name":"表名","rows":[[首行表头...],[数据行...]]}]，首行自动加粗。\n' +
			"生成后用 office_render_document 的默认 check 模式检查排版，临时图片不落入工作区；完成后只交付目标文档卡片。",
		parameters: Type.Object({
			path: Type.String({ description: "目标文件（工作区内，扩展名决定类型：.docx/.pptx/.xlsx/.odt/.odp/.ods）" }),
			html: Type.Optional(Type.String({ description: "docx：完整 HTML 文档（受限标签集）" })),
			slides: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description: "pptx：幻灯片 DSL 数组",
			})),
			accent: Type.Optional(Type.String({ description: "pptx：主题色 #RRGGBB（默认 #2563EB）" })),
			sheets: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description: "xlsx：[{name, rows}]",
			})),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, html, slides, accent, sheets } = params as {
				path: string; html?: string; slides?: Record<string, unknown>[];
				accent?: string; sheets?: Record<string, unknown>[];
			};
			const resolved = resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
			const ext = /\.([a-z]+)$/i.exec(resolved.path)?.[1]?.toLowerCase() ?? "";
			let spec: Record<string, unknown>;
			if (ext === "docx" || ext === "odt") {
				if (!html?.trim()) {
					return textResult("生成 docx 需要 html 参数（受限 HTML 文档）。", { error: "missing_html" });
				}
				spec = { html };
			} else if (ext === "pptx" || ext === "odp") {
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
				return textResult(`不支持的目标格式 .${ext}（支持 docx/pptx/xlsx/odt/odp/ods）。`, { error: "bad_ext" });
			}
			const sidecar = getUnoSidecar();
			const created = await sidecar.call<{ created: string; kind: string }>(
				"create", { path: resolved.path, spec });
			if (!created.ok) return textResult(formatFailure("create", created), { error: created.error });
			logger.info({ path: resolved.path, kind: created.result!.kind }, "office_create_document: created");
			return textResult(
				`已生成 ${created.result!.kind} 文档：${rawPath}。`,
				{ created: created.result!.created, kind: created.result!.kind },
			);
		},
	});

	const openDocument = defineTool({
		name: "office_open_document",
		label: "打开 Office 文档",
		description:
			"用 LibreOffice 引擎打开工作区内的 docx/xlsx/pptx（也支持 odt/ods/odp）文档，" +
			"返回 docId、文档类型和结构大纲（段落列表 / 工作表列表 / 幻灯片列表）。" +
			"之后用 office_edit_document 基于 docId 做原子编辑，用 office_close_document 关闭。",
		parameters: Type.Object({
			path: Type.String({ description: "工作区内文档路径（相对或绝对）" }),
			readOnly: Type.Optional(Type.Boolean({ description: "只读打开（默认 false）" })),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, readOnly } = params as { path: string; readOnly?: boolean };
			const resolved = resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
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
			logger.info({ docId, kind, path: resolved.path }, "office_open_document: opened");
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
				description: "原子操作列表，如 [{\"op\":\"replace_text\",\"find\":\"旧\",\"replace\":\"新\"}]",
			}),
			save: Type.Optional(Type.Boolean({ description: "编辑后保存到原文件（默认 false）" })),
			saveAs: Type.Optional(Type.String({ description: "另存为工作区内路径（优先于 save）" })),
		}),
		async execute(_toolCallId, params) {
			const { docId, ops, save, saveAs } = params as {
				docId: string; ops: Record<string, unknown>[]; save?: boolean; saveAs?: string;
			};
			if (!docId) return textResult("缺少 docId。", { error: "missing_doc_id" });
			if (!Array.isArray(ops) || ops.length === 0) {
				return textResult("ops 为空：至少需要一个原子操作。", { error: "empty_ops" });
			}
			if (ops.length > 100) {
				return textResult("单次最多 100 个操作，请分批提交。", { error: "too_many_ops" });
			}
			const sidecar = getUnoSidecar();
			const edited = await sidecar.call<{ results: { op: string; ok: boolean; error?: string }[] }>(
				"exec", { docId, ops });
			if (!edited.ok) return textResult(formatFailure("exec", edited), { error: edited.error });

			const results = edited.result!.results;
			const failed = results.filter((r) => !r.ok);

			let saveNote = "";
			if (failed.length === 0 && (save === true || saveAs)) {
				let target: string | undefined;
				if (saveAs) {
					const resolved = resolveWorkspacePath(String(saveAs));
					if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
					target = resolved.path;
				}
				const saved = await sidecar.call("save", target ? { docId, path: target } : { docId });
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
			"生成或编辑 Office 文档后检查排版。默认 mode=check：在系统临时目录渲染，直接返回页面图片供模型检查，" +
			"返回后自动清理 PDF/PNG，不在工作区留下预览文件，也无需 read。按 nextPage 分批检查到末页。" +
			"只有用户明确要求导出 PDF 或页面图片文件时才用 mode=export，将文件保存到工作区。",
		parameters: Type.Object({
			path: Type.String({ description: "工作区内文档路径（相对或绝对）" }),
			mode: Type.Optional(Type.Union([Type.Literal("check"), Type.Literal("export")], { description: "默认 check 临时排版检查；export 显式导出文件" })),
			format: Type.Optional(Type.Union([Type.Literal("pdf"), Type.Literal("png")], {
				description: "export 模式的输出格式，默认 pdf；check 模式始终返回页面图片",
			})),
			maxPages: Type.Optional(Type.Number({ description: "每批最多渲染页数，默认 5，上限 20" })),
			startPage: Type.Optional(Type.Number({ description: "起始页码，从 1 开始；按返回的 nextPage 继续检查" })),
			outDir: Type.Optional(Type.String({ description: "仅 export 模式使用，工作区内输出目录，默认工作区根目录" })),
		}),
		async execute(_toolCallId, params) {
			const { path: rawPath, mode, format, maxPages, startPage, outDir } = params as {
				path: string; mode?: "check" | "export"; format?: "pdf" | "png"; maxPages?: number; startPage?: number; outDir?: string;
			};
			const resolved = resolveWorkspacePath(String(rawPath ?? ""));
			if ("error" in resolved) return textResult(resolved.error, { error: "path_rejected" });
			const checking = mode !== "export";
			let temporaryDir: string | undefined;
			try {
				let outputDir: string;
				if (checking) {
					// Watching workspace renders used to open both DOCX and PDF tabs.
					// Keep check assets outside the workspace and return images inline
					// so they can be deleted before the tool response is delivered.
					const prefix = await resolveContainedPathAsync(tmpdir(), "inno-office-check-");
					if (!prefix) throw new Error("无法创建排版检查临时目录");
					outputDir = temporaryDir = await mkdtemp(prefix);
				} else {
					const dir = resolveWorkspacePath(outDir?.trim() || ".");
					if ("error" in dir) return textResult(dir.error, { error: "path_rejected" });
					outputDir = dir.path;
					await mkdir(outputDir, { recursive: true });
				}
				if (!checking && format === "png") {
					const prefix = await resolveContainedPathAsync(tmpdir(), "inno-office-check-");
					if (!prefix) throw new Error("无法创建页面转换临时目录");
					temporaryDir = await mkdtemp(prefix);
				}
				const converted = await getUnoSidecar().call<{ output: string }>(
					"convert", { path: resolved.path, to: "pdf", outDir: temporaryDir ?? outputDir });
				if (!converted.ok) return textResult(formatFailure("convert", converted), { error: converted.error });
				const pdfPath = await resolveContainedPathAsync(temporaryDir ?? outputDir, converted.result!.output);
				if (!pdfPath) throw new Error("渲染 PDF 超出输出目录");
				if (!checking && format !== "png") return textResult(`已导出 PDF：${pdfPath}`, { output: pdfPath });
				const { renderPdfToPngs } = await import("../office/pdf-render.js");
				const firstPage = startPage && Number.isFinite(startPage) ? Math.max(1, Math.floor(startPage)) : 1;
				const { paths: pngs, totalPages } = await renderPdfToPngs(pdfPath, outputDir, {
					maxPages: maxPages && Number.isFinite(maxPages) ? Math.min(Math.max(1, Math.floor(maxPages)), 20) : 5,
					startPage: firstPage,
				});
				const nextPage = firstPage + pngs.length <= totalPages ? firstPage + pngs.length : undefined;
				if (!checking) return textResult(`已导出页面图片：\n${pngs.join("\n")}`, { pages: pngs, totalPages, nextPage });
				const images = await Promise.all(pngs.map(async (path) => {
					const contained = await resolveContainedPathAsync(outputDir, path);
					if (!contained) throw new Error("排版检查图片超出临时目录");
					return { type: "image" as const, data: (await readFile(contained)).toString("base64"), mimeType: "image/png" };
				}));
				return {
					content: [{ type: "text" as const, text: `文档共 ${totalPages} 页，本批返回 ${images.length} 页（从第 ${firstPage} 页开始）。请检查排版，发现问题后修正并复检。${nextPage ? `继续用 startPage=${nextPage} 检查后续页面。` : ""}临时预览文件已清理，不要另存或交付这些检查图片。` }, ...images],
					details: { mode: "check", totalPages, startPage: firstPage, renderedPages: images.length, nextPage },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return textResult(`文档${checking ? "排版检查" : "导出"}失败：${msg}`, { error: msg });
			} finally {
				if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
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
			const sidecar = getUnoSidecar();
			const closed = await sidecar.call("close", { docId });
			if (!closed.ok) return textResult(formatFailure("close", closed), { error: closed.error });
			return textResult(`已关闭文档 ${docId}。`, { closed: docId });
		},
	});

	return [engineStatus, createDocument, openDocument, editDocument, renderDocument, closeDocument];
}
