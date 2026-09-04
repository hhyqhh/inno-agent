import { createContext, lazy, memo, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DragDropManager } from "dnd-core";
import { Tree, type NodeRendererProps, type TreeApi, type CreateHandler, type RenameHandler, type DeleteHandler, type MoveHandler } from "react-arborist";
import { RefreshCw, FileText, FileType, Globe, File, FolderOpen, Folder, Pencil, Save, X, PanelLeftClose, PanelLeftOpen, Sparkles, Download, FileCode2, Presentation, FileSpreadsheet, Copy, Check, ListChecks, Trash2 } from "lucide-react";
import { workspaceStore, type StreamingWorkspacePreview } from "../stores/workspace-store.js";
import { workspaceFileUrl, workspaceFolderZipUrl, triggerDownload } from "../api/workspace.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import { getSessionWorkspace } from "../api/workspaces.js";
import { RunButton } from "./terminal/RunButton.js";
import { LazyCodeEditor } from "./LazyCodeEditor.js";
import { LazyMarkdownEditor } from "./LazyMarkdownEditor.js";
import type { WorkspaceFileDetail, WorkspaceFileKind, WorkspaceOfficeFormat } from "../types/workspace.js";
import { type ArboristNode, toArboristNodes } from "../types/workspace.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { useStoreSnapshot } from "./hooks.js";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu.js";
import { FileName } from "./FileName.js";
import { buildDragFilePanel, hiddenDragImage } from "./chat/smart-input/drag-utils.js";
import { DEFAULT_UPLOAD_MAX_LABEL, getOversizedFiles } from "../utils/upload-limits.js";
import "@earendil-works/pi-web-ui";

// Heavy office renderers are lazy-loaded so docx-preview / xlsx stay off the
// critical path and only download when an office file is actually opened.
const PptxPreview = lazy(() => import("./office/PptxPreview.js"));
const DocxPreview = lazy(() => import("./office/DocxPreview.js"));
const XlsxPreview = lazy(() => import("./office/XlsxPreview.js"));

const MAX_STREAMING_MARKDOWN_FORMAT_CHARS = 160_000;
type PreviewFileHandler = (minimumWidth: number) => void | Promise<void>;
const TREE_PANE_WIDTH = 260;
const CONTENT_REVEAL_WIDTH = TREE_PANE_WIDTH + 150;
const DEFAULT_PREVIEW_PANEL_WIDTH = 560;

function streamingMarkdownInterval(contentLength: number): number {
	if (contentLength < 40_000) return 240;
	if (contentLength < 100_000) return 420;
	return 700;
}

function useStreamingMarkdownSnapshot(content: string, enabled: boolean): string {
	const [snapshot, setSnapshot] = useState(content);
	const latestContentRef = useRef(content);
	const timerRef = useRef<number | null>(null);
	const lastSnapshotAtRef = useRef(0);
	latestContentRef.current = content;

	useEffect(() => {
		if (!enabled) {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			timerRef.current = null;
			lastSnapshotAtRef.current = 0;
			return;
		}
		if (timerRef.current !== null) return;

		const elapsed = performance.now() - lastSnapshotAtRef.current;
		const delay = Math.max(0, streamingMarkdownInterval(content.length) - elapsed);
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			lastSnapshotAtRef.current = performance.now();
			const next = latestContentRef.current;
			setSnapshot((current) => current === next ? current : next);
		}, delay);
	}, [content, enabled]);

	useEffect(() => () => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	return enabled ? snapshot : content;
}

const MarkdownStreamSnapshot = memo(function MarkdownStreamSnapshot({ content, showCursor }: { content: string; showCursor: boolean }) {
	const normalizedContent = useMemo(() => normalizeMarkdownMath(content), [content]);
	return (
		<div className="px-4 py-3 text-[13px] leading-relaxed text-[var(--inno-text)] [overflow-wrap:anywhere]">
			<markdown-artifact content={normalizedContent} />
			{showCursor ? <span className="inno-stream-cursor" aria-hidden="true" /> : null}
		</div>
	);
});

/* ---------- helpers ---------- */

function formatSize(size = 0): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * OS file drags expose their files differently across browsers and drag
 * phases. During dragover, `dataTransfer.files` can be empty while the file
 * entries are still available through `dataTransfer.items`.
 */
function filesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
	if (!dataTransfer) return [];
	const files = Array.from(dataTransfer.files ?? []);
	if (files.length > 0) return files;
	return Array.from(dataTransfer.items ?? [])
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null);
}

function nodeIcon(name: string, isDir: boolean, isOpen: boolean) {
	if (isDir) return isOpen ? <FolderOpen size={14} /> : <Folder size={14} />;
	const lower = name.toLowerCase();
	if (lower.endsWith(".md")) return <FileText size={14} />;
	if (lower.endsWith(".pdf")) return <FileType size={14} />;
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return <Globe size={14} />;
	if (lower.endsWith(".pptx")) return <Presentation size={14} />;
	if (lower.endsWith(".xlsx")) return <FileSpreadsheet size={14} />;
	if (lower.endsWith(".docx")) return <FileText size={14} />;
	return <File size={14} />;
}

/** Derive the office format from a filename when the backend didn't supply it. */
function officeFormatFromName(name: string): WorkspaceOfficeFormat | undefined {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pptx")) return "pptx";
	if (lower.endsWith(".docx")) return "docx";
	if (lower.endsWith(".xlsx")) return "xlsx";
	return undefined;
}

/** Whether a file kind supports text editing */
function isEditable(kind: WorkspaceFileKind): boolean {
	return kind === "markdown" || kind === "text";
}

/** Derive a language hint from filename for code display */
function langFromName(name: string): string {
	const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
		".mjs": "javascript", ".cjs": "javascript",
		".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
		".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".cpp": "cpp", ".h": "c",
		".css": "css", ".scss": "scss", ".less": "less",
		".html": "html", ".htm": "html", ".xml": "xml", ".svg": "xml",
		".json": "json", ".jsonl": "json",
		".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
		".sh": "bash", ".bash": "bash", ".zsh": "bash",
		".sql": "sql", ".graphql": "graphql",
		".md": "markdown", ".markdown": "markdown",
		".txt": "plaintext", ".log": "plaintext", ".csv": "plaintext",
	};
	return map[ext] ?? "plaintext";
}

/* ---------- CSV / TSV parsing ---------- */

/** True for delimited-table files we render as a grid. */
function isCsvName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".csv") || lower.endsWith(".tsv");
}

/**
 * Parse delimited text into rows of cells. Handles quoted fields (RFC 4180):
 * double-quoted values may contain the delimiter, newlines, and escaped quotes
 * (`""`). Delimiter is auto-picked from the filename (.tsv → tab, else comma).
 */
function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else inQuotes = false;
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') { inQuotes = true; continue; }
		if (ch === delimiter) { row.push(field); field = ""; continue; }
		if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
		if (ch === "\r") continue;
		field += ch;
	}
	// Flush trailing field/row (unless the file ended on a clean newline).
	if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
	return rows;
}

/** Render CSV/TSV content as a scrollable table; first row is treated as a header. */
function CsvPreview({ name, content }: { name: string; content: string }) {
	const { t } = useTranslation();
	const rows = useMemo(() => {
		const delimiter = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
		return parseDelimited(content, delimiter);
	}, [name, content]);

	if (!rows.length) {
		return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.emptyTable", "Empty table")}</div>;
	}
	const [header, ...body] = rows;
	return (
		<div className="h-full overflow-auto bg-[var(--inno-surface)] p-3">
			<table className="w-full border-collapse text-xs">
				<thead className="sticky top-0 z-10">
					<tr>
						{header.map((cell, i) => (
							<th key={i} className="border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-left font-semibold text-[var(--inno-text)]">
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((r, ri) => (
						<tr key={ri} className="odd:bg-[var(--inno-surface)] even:bg-[var(--inno-surface-muted)]">
							{header.map((_, ci) => (
								<td key={ci} className="border border-[var(--inno-border)] px-2 py-1 align-top text-[var(--inno-text-muted)]">
									{r[ci] ?? ""}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			<div className="mt-2 text-[10px] text-[var(--inno-text-subtle)]">{t("preview.tableRows", "{{count}} rows", { count: body.length })}</div>
		</div>
	);
}

/* ---------- Office (docx/xlsx/pptx) preview ---------- */

interface OfficePreviewData {
	name: string;
	pageCount: number;
	text: string;
	pages: Array<{ pageNumber: number; text: string }>;
}

/** Fetch extracted text for an office document and render it page-by-page. */
function OfficePreview({ file }: { file: WorkspaceFileDetail }) {
	const { t } = useTranslation();
	const [data, setData] = useState<OfficePreviewData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!file.previewUrl) { setError(t("preview.officeUnavailable", "Preview unavailable")); setLoading(false); return; }
		let cancelled = false;
		setLoading(true);
		setError("");
		setData(null);
		fetch(file.previewUrl)
			.then(async (res) => {
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error((body as { error?: string }).error || res.statusText);
				}
				return res.json() as Promise<OfficePreviewData>;
			})
			.then((d) => { if (!cancelled) setData(d); })
			.catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to parse document"); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [file.previewUrl, file.path, t]);

	const downloadOriginal = useCallback(() => {
		if (file.url) triggerDownload(`${file.url}${file.url.includes("?") ? "&" : "?"}download=1`);
	}, [file.url]);

	if (loading) {
		return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.officeParsing", "Extracting document text...")}</div>;
	}
	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--inno-text-muted)]">
				<div className="font-medium text-[var(--inno-text)]">{file.name}</div>
				<div className="text-xs text-[var(--inno-danger)]">{error}</div>
				<button className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
		);
	}
	const pages = data?.pages?.length ? data.pages : (data ? [{ pageNumber: 1, text: data.text }] : []);
	return (
		<div className="workspace-scroll h-full overflow-auto bg-[var(--inno-surface-muted)] p-4">
			<div className="mb-3 flex items-center justify-between gap-2">
				<div className="text-xs text-[var(--inno-text-muted)]">
					{t("preview.officeNote", "Text extracted for preview · formatting may differ")} · {t("preview.pageCount", "{{count}} pages", { count: data?.pageCount ?? pages.length })}
				</div>
				<button className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
			<div className="space-y-3">
				{pages.map((p) => (
					<div key={p.pageNumber} className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
						{pages.length > 1 ? (
							<div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
								{t("preview.page", "Page")} {p.pageNumber}
							</div>
						) : null}
						<pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[var(--inno-text)]">{p.text}</pre>
					</div>
				))}
			</div>
		</div>
	);
}

/* ---------- HtmlPreview (separate component for React Rules of Hooks) ---------- */

function HtmlPreview({ file }: { file: WorkspaceFileDetail }) {
  const raw = file.content ?? "";

  const guardScript = `<script>(function(){\nfunction scrollToId(id){\n  if(!id){ window.scrollTo(0,0); return; }\n  var t=document.getElementById(id)||document.getElementsByName(id)[0];\n  if(t&&t.scrollIntoView) t.scrollIntoView({behavior:"smooth",block:"start"});\n}\ndocument.addEventListener("click",function(ev){\n  var a=ev.target&&ev.target.closest&&ev.target.closest("a[href]");\n  if(!a) return;\n  var href=a.getAttribute("href");\n  if(href&&(href==="#"||href.charAt(0)==="#")){ev.preventDefault();scrollToId(href.slice(1));return;}\n  if(!href||href===""||href.toLowerCase().indexOf("javascript:")===0){ev.preventDefault();return;}\n  ev.preventDefault();\n  try{window.open(a.href,"_blank","noopener");}catch(e){}\n},true);\ndocument.addEventListener("submit",function(ev){\n  var f=ev.target;if(!f) return;ev.preventDefault();\n  try{var url=(f.action&&f.action!=="")?f.action:null;if(url) window.open(url,"_blank","noopener");}catch(e){}\n},true);\n})();<\/script>`;

  const html = /<head[^>]*>/i.test(raw)
    ? raw.replace(/<head([^>]*)>/i, `<head$1>${guardScript}`)
    : `<!doctype html><html><head>${guardScript}</head><body>${raw}</body></html>`;

  return <iframe className="h-full w-full border-0 bg-[var(--inno-surface)]" sandbox="allow-scripts allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox" srcDoc={html} title={file.name} />;
}

/* ---------- Preview (read-only) ---------- */

function Preview({ file, isLoading }: { file: WorkspaceFileDetail; isLoading: boolean }) {
	const { t } = useTranslation();
	if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.loadingFile")}</div>;
	if (file.kind === "markdown") return <div className="workspace-scroll h-full overflow-y-auto p-5"><markdown-artifact content={normalizeMarkdownMath(file.content ?? "")} /></div>;
		if (file.kind === "html") return <HtmlPreview file={file} />;
	if (file.kind === "pdf") {
		// Default to fit-width so the PDF fills the preview panel horizontally.
		// `view=FitH` (PDF Open Params) + `zoom=page-width` covers Chromium and Firefox.
		// Users can still zoom in/out further via the native PDF viewer toolbar.
		const baseUrl = file.url ?? "";
		const pdfUrl = baseUrl
			? `${baseUrl}${baseUrl.includes("#") ? "&" : "#"}view=FitH&zoom=page-width`
			: "";
		return <iframe className="h-full w-full border-0 bg-[var(--inno-surface)]" src={pdfUrl} title={file.name} />;
	}
	if (file.kind === "image") {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-[var(--inno-surface-muted)] p-4">
				<img className="max-h-full max-w-full object-contain" src={file.url ?? ""} alt={file.name} />
			</div>
		);
	}
	if (file.kind === "office") {
		const fmt = file.format ?? officeFormatFromName(file.name);
		const fallback = (
			<div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">
				{t("preview.loadingFile")}
			</div>
		);
		if (fmt === "pptx") return <Suspense fallback={fallback}><PptxPreview file={file} /></Suspense>;
		if (fmt === "docx") return <Suspense fallback={fallback}><DocxPreview file={file} /></Suspense>;
		if (fmt === "xlsx") return <Suspense fallback={fallback}><XlsxPreview file={file} /></Suspense>;
		return <OfficePreview file={file} />;
	}
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--inno-text-muted)]">
				<div className="text-lg font-medium text-[var(--inno-text)]">{file.name}</div>
				<div>{t("preview.binaryFile")} · {formatSize(file.size)}</div>
				<button
					className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
					onClick={() => workspaceStore.openAsText()}
				>
					<FileCode2 size={14} />
					{t("preview.openAsText", "Open as Text")}
				</button>
			</div>
		);
	}
	// text / code — syntax-highlighted via CodeMirror (read-only)
	// CSV/TSV get a table grid instead of raw text.
	if (isCsvName(file.name)) {
		return <CsvPreview name={file.name} content={file.content ?? ""} />;
	}
	const lang = langFromName(file.name);
	return (
		<LazyCodeEditor
			value={file.content ?? ""}
			lang={lang}
			readOnly
		/>
	);
}

/* ---------- Markdown Editor ---------- */

function MarkdownEditorPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return <LazyMarkdownEditor value={value} onChange={onChange} />;
}

/* ---------- Code Editor (CodeMirror) ---------- */

function CodeEditorPane({ value, onChange, lang }: { value: string; onChange: (v: string) => void; lang: string }) {
	return <LazyCodeEditor value={value} lang={lang} onChange={onChange} />;
}

function StreamingPreviewPane({ preview, onToggleSidebar, sidebarOpen }: { preview: StreamingWorkspacePreview; onToggleSidebar: () => void; sidebarOpen: boolean }) {
	const { t } = useTranslation();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [copied, setCopied] = useState(false);
	const isStreaming = preview.status === "streaming";
	const isMarkdownPreview = isStreamingMarkdownPreview(preview);
	const shouldFormatMarkdown = isMarkdownPreview
		&& (!isStreaming || preview.content.length <= MAX_STREAMING_MARKDOWN_FORMAT_CHARS);
	const markdownSnapshot = useStreamingMarkdownSnapshot(
		preview.content,
		isStreaming && shouldFormatMarkdown,
	);
	const visibleContent = shouldFormatMarkdown ? markdownSnapshot : preview.content;
	const lineCount = useMemo(
		() => visibleContent ? visibleContent.split(/\r\n|\r|\n/).length : 0,
		[visibleContent],
	);
	const statusLabel = isStreaming
		? preview.stage ?? t("preview.streamingGenerating", "正在生成")
		: preview.status === "error"
			? t("preview.streamingError", "生成中断")
			: t("preview.streamingDone", "生成完成");

	useEffect(() => {
		if (!isStreaming) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [visibleContent, isStreaming]);

	const copyContent = useCallback(() => {
		if (!preview.content) return;
		void navigator.clipboard?.writeText(preview.content).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	}, [preview.content]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<button
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						onClick={onToggleSidebar}
						title={sidebarOpen ? t("common.collapseSidebar", "收起侧栏") : t("common.expandSidebar", "展开侧栏")}
					>
						{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
					</button>
					<span className={`inno-stream-status-dot ${isStreaming ? "is-streaming" : ""}`} />
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{preview.title}</div>
						<div className="truncate text-[10px] text-[var(--inno-text-muted)]">
							{statusLabel}
							{preview.path ? ` · ${preview.path}` : ""}
							{lineCount ? ` · ${lineCount} ${t("preview.streamingLines", "行")}` : ""}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<button
						disabled={!preview.content}
						className="flex h-7 items-center gap-1 rounded-md border border-[var(--inno-border)] px-2.5 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:cursor-not-allowed disabled:opacity-40"
						onClick={copyContent}
					>
						{copied ? <Check size={12} /> : <Copy size={12} />}
						{copied ? t("common.copied", "已复制") : t("common.copy", "复制")}
					</button>
					{isStreaming ? null : (
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							title={t("preview.streamingClose", "关闭生成预览")}
							onClick={() => workspaceStore.clearStreamingPreview(preview.id)}
						>
							<X size={14} />
						</button>
					)}
				</div>
			</div>
			<div ref={scrollRef} className="workspace-scroll min-h-0 flex-1 overflow-auto bg-[var(--inno-surface)]">
				<div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-4 py-2 text-[10px] text-[var(--inno-text-muted)]">
					<Sparkles size={12} className="shrink-0 text-[var(--inno-accent)]" />
					<span className="truncate">{t("preview.streamingHint", "长内容正在右侧生成，聊天区只保留摘要。")}</span>
				</div>
				{preview.content ? (
					shouldFormatMarkdown ? (
						<MarkdownStreamSnapshot content={visibleContent} showCursor={isStreaming} />
					) : (
						<pre className="min-h-full whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-[var(--inno-text)] [overflow-wrap:anywhere]">
							{preview.content}
							{isStreaming ? <span className="inno-stream-cursor" aria-hidden="true" /> : null}
						</pre>
					)
				) : (
					<div className="flex h-full items-center justify-center px-4 text-sm text-[var(--inno-text-muted)]">
						{t("preview.streamingWaiting", "等待模型开始输出…")}
					</div>
				)}
			</div>
		</div>
	);
}

function isStreamingMarkdownPreview(preview: StreamingWorkspacePreview): boolean {
	const name = `${preview.path ?? ""} ${preview.title}`.toLowerCase();
	return preview.language === "markdown" || name.includes(".md") || name.includes(".markdown");
}

/* ---------- File Content Pane (preview + edit) ---------- */

function FileContentPane({ onToggleSidebar, sidebarOpen }: { onToggleSidebar: () => void; sidebarOpen: boolean }) {
	const { t } = useTranslation();
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const state = useStoreSnapshot(workspaceStore, () => ({
		file: workspaceStore.currentFile,
		isLoadingFile: workspaceStore.isLoadingFile,
		isEditing: workspaceStore.isEditing,
		editBuffer: workspaceStore.editBuffer,
		isSaving: workspaceStore.isSaving,
		error: workspaceStore.error,
		streamingPreview: workspaceStore.streamingPreview,
	}));

	const canEdit = state.file != null && isEditable(state.file.kind);

	if (state.streamingPreview) {
		return <StreamingPreviewPane key={state.streamingPreview.id} preview={state.streamingPreview} onToggleSidebar={onToggleSidebar} sidebarOpen={sidebarOpen} />;
	}

	if (state.isEditing && state.file) {
		const isMd = state.file.kind === "markdown";
		return (
			<div className="flex h-full flex-col">
				{/* Editor toolbar */}
				<div className="flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
					<div className="min-w-0">
						<FileName name={state.file.name} className="text-sm font-medium" />
						<div className="truncate text-[10px] text-[var(--inno-text-muted)]">{t("files.editing", "Editing")} · {state.file.path}</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button
							disabled={state.isSaving}
							className="flex h-7 items-center gap-1 rounded-md inno-primary-button px-2.5 text-xs text-white disabled:opacity-50"
							onClick={() => void workspaceStore.saveFile()}
						>
							<Save size={12} />
							{t("common.save", "Save")}
						</button>
						<button
							disabled={state.isSaving}
							className="flex h-7 items-center gap-1 rounded-md border border-[var(--inno-border)] px-2.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
							onClick={() => workspaceStore.cancelEditing()}
						>
							<X size={12} />
							{t("common.cancel", "Cancel")}
						</button>
					</div>
				</div>
				{/* Editor body */}
				<div className="min-h-0 flex-1">
					{isMd ? (
						<MarkdownEditorPane value={state.editBuffer} onChange={(v) => workspaceStore.updateEditBuffer(v)} />
					) : (
						<CodeEditorPane value={state.editBuffer} onChange={(v) => workspaceStore.updateEditBuffer(v)} lang={langFromName(state.file.name)} />
					)}
				</div>
			</div>
		);
	}

	// Read-only view
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<button
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						onClick={onToggleSidebar}
						title={sidebarOpen ? t("common.collapseSidebar", "Collapse sidebar") : t("common.expandSidebar", "Expand sidebar")}
					>
						{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
					</button>
					<div className="min-w-0">
						{state.file ? <FileName name={state.file.name} className="text-sm font-medium" /> : <div className="text-sm font-medium">{t("preview.noFile", "No file selected")}</div>}
						<div className="truncate text-[10px] text-[var(--inno-text-muted)]">
							{state.file ? `${state.file.path} · ${formatSize(state.file.size)}` : t("preview.selectFile", "Select a file to preview")}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{state.file && !simpleMode ? <RunButton filePath={state.file.path} /> : null}
					{canEdit && (
						<button
							className="flex h-7 items-center gap-1 rounded-md border border-[var(--inno-border)] px-2.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							onClick={() => workspaceStore.startEditing()}
						>
							<Pencil size={12} />
							{t("common.edit", "Edit")}
						</button>
					)}
				</div>
			</div>
			<div className="workspace-scroll min-h-0 flex-1 overflow-auto">
				{state.error ? <div className="p-4 text-sm text-[var(--inno-danger)]">{state.error}</div> : null}
				{!state.error && state.file ? <Preview file={state.file} isLoading={state.isLoadingFile} /> : null}
				{!state.error && !state.file ? <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.noPreview", "Nothing to preview")}</div> : null}
			</div>
		</div>
	);
}

/* ---------- Custom Node Renderer ---------- */

interface WorkspaceDragItem {
	name: string;
	path: string;
	source: "workspace";
}

interface WorkspaceMultiSelectState {
	enabled: boolean;
	selectedIds: ReadonlySet<string>;
	selectedFiles: ReadonlyArray<WorkspaceDragItem>;
	toggleFile: (path: string) => void;
	addFile: (path: string) => void;
	exit: () => void;
}

const WorkspaceMultiSelectContext = createContext<WorkspaceMultiSelectState>({
	enabled: false,
	selectedIds: new Set(),
	selectedFiles: [],
	toggleFile: () => undefined,
	addFile: () => undefined,
	exit: () => undefined,
});

function collectSelectedWorkspaceFiles(nodes: ArboristNode[], selectedIds: ReadonlySet<string>, out: WorkspaceDragItem[] = []): WorkspaceDragItem[] {
	for (const node of nodes) {
		if (node.isLeaf && selectedIds.has(node.path)) {
			out.push({ name: node.name, path: node.path, source: "workspace" });
		}
		if (node.children) collectSelectedWorkspaceFiles(node.children, selectedIds, out);
	}
	return out;
}

function createWorkspaceDragImage(items: ReadonlyArray<WorkspaceDragItem>): HTMLElement {
	// Same shared panel the smart-input follower uses, so drags look identical
	// whether or not smart input is enabled.
	return buildDragFilePanel(items, true);
}

function Node({ node, style, dragHandle, onPreviewFile }: NodeRendererProps<ArboristNode> & { onPreviewFile?: PreviewFileHandler }) {
	const { t } = useTranslation();
	const isDir = !node.isLeaf;
	const isFileDragSource = node.isLeaf && !node.isEditing;
	const multiSelect = useContext(WorkspaceMultiSelectContext);
	const selected = multiSelect.enabled ? multiSelect.selectedIds.has(node.data.path) : node.isSelected;

	return (
		<div
			// Files use the native file-binding drag source below. Keeping the
			// arborist drag handle on the same element makes react-dnd treat the
			// file drag as a tree move and prevents the composer from receiving it.
			ref={isFileDragSource ? undefined : dragHandle}
			draggable={isFileDragSource}
			style={style}
			data-ws-path={node.data.path}
			className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer select-none ${
				selected
					? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
					: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
			} ${isFileDragSource ? "inno-smart-ws-drag-row" : ""}`}
			title={isFileDragSource ? t("chat.smartInput.dragToAttach", "拖到输入框添加到文件区") : undefined}
			onDragStart={(event) => {
				if (!isFileDragSource) return;
				event.stopPropagation();
				const item = { name: node.data.name, path: node.data.path, source: "workspace" as const };
				const items = multiSelect.enabled && multiSelect.selectedIds.has(node.data.path) && multiSelect.selectedFiles.length > 0
					? [...multiSelect.selectedFiles]
					: [item];
				const payload = items.length === 1 ? items[0] : { source: "workspace" as const, items };
				if (items.length > 1) event.currentTarget.dataset.multiDrag = "1";
				event.dataTransfer.setData("application/x-inno-file", JSON.stringify(payload));
				event.dataTransfer.setData("text/plain", `ws:${node.data.path}`);
				event.dataTransfer.effectAllowed = "copy";
				const dragImage = createWorkspaceDragImage(items);
				window.dispatchEvent(new CustomEvent("inno-smart-dragstart", { detail: { items } }));
				if (document.body.classList.contains("inno-smart-dragging")) {
					// Smart input renders its own live follower; hide the native snapshot.
					event.dataTransfer.setDragImage(hiddenDragImage(), 0, 0);
				} else {
					// Keep the drag preview above the pointer. The composer uses the area
					// under the pointer for attachment chips and smart-input feedback; a
					// centered preview would cover that target while dragging.
					event.dataTransfer.setDragImage(dragImage, 6, dragImage.offsetHeight + 2);
				}
				window.setTimeout(() => dragImage.remove(), 0);
			}}
			onDragEnd={(event) => {
				if (!isFileDragSource) return;
				event.stopPropagation();
				// A finished multi-file drag has served its purpose; leave
				// multi-select so the browser returns to its normal state.
				if (event.currentTarget.dataset.multiDrag === "1") {
					delete event.currentTarget.dataset.multiDrag;
					multiSelect.exit?.();
				}
				window.dispatchEvent(new CustomEvent("inno-smart-dragend"));
			}}
			onClick={(e) => {
				e.stopPropagation();
				if (isDir) node.toggle();
				else {
					if (multiSelect.enabled) {
						multiSelect.toggleFile(node.data.path);
						return;
					}
					if (node.isSelected) {
						node.deselect();
						if (onPreviewFile) {
							void onPreviewFile(DEFAULT_PREVIEW_PANEL_WIDTH);
							return;
						}
						return;
					}
					node.select();
					workspaceStore.clearStreamingPreview();
					if (onPreviewFile) void onPreviewFile(DEFAULT_PREVIEW_PANEL_WIDTH);
					else {
						if (appStore.workspaceWidth < CONTENT_REVEAL_WIDTH) {
							appStore.setWorkspaceWidth(DEFAULT_PREVIEW_PANEL_WIDTH);
						}
						if (appStore.workspaceMode === "quarter") {
							appStore.setWorkspaceMode("half");
						}
					}
					void workspaceStore.selectFile(node.data.path);
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (!isDir && !selected) {
					if (multiSelect.enabled) multiSelect.addFile(node.data.path);
					else node.select();
				}
				const ev = new CustomEvent("workspace-ctx", { detail: { x: e.clientX, y: e.clientY, node: node.data }, bubbles: true });
				e.currentTarget.dispatchEvent(ev);
			}}
		>
			{multiSelect.enabled && !isDir ? (
				<span
					className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
						selected
							? "border-[var(--inno-accent)] bg-[var(--inno-accent)] text-white"
							: "border-[var(--inno-border)] bg-[var(--inno-surface)]"
					}`}
					role="checkbox"
					aria-checked={selected}
					aria-label={node.data.name}
				>
					{selected ? <Check size={11} strokeWidth={3} /> : null}
				</span>
			) : null}
			<span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--inno-text-subtle)]">
				{nodeIcon(node.data.name, isDir, node.isOpen)}
			</span>
			{node.isEditing ? (
				<input
					autoFocus
					className="min-w-0 flex-1 rounded border border-[var(--inno-accent)] bg-[var(--inno-surface)] px-1 py-0.5 text-xs outline-none focus-visible:shadow-[var(--inno-ring)]"
					defaultValue={node.data.name}
					onFocus={(e) => {
						const val = e.currentTarget.value;
						const dotIdx = node.isLeaf ? val.lastIndexOf(".") : -1;
						e.currentTarget.setSelectionRange(0, dotIdx > 0 ? dotIdx : val.length);
					}}
					onBlur={() => node.reset()}
					onKeyDown={(e) => {
						if (e.key === "Escape") node.reset();
						if (e.key === "Enter") node.submit(e.currentTarget.value);
					}}
				/>
			) : (
				<>
					<FileName name={node.data.name} className="min-w-0 flex-1" />
					{node.isLeaf && <span className="text-[10px] opacity-50">{formatSize(node.data.size)}</span>}
				</>
			)}
		</div>
	);
}

/* ---------- Context Menu ---------- */

interface CtxMenuState {
	x: number;
	y: number;
	nodePath: string;
	nodeName: string;
	isDir: boolean;
	/** True when the menu was opened on empty tree space (create at root). */
	isRoot?: boolean;
}

function WorkspaceContextMenu({ state, onClose, treeRef, workspaceId }: { state: CtxMenuState; onClose: () => void; treeRef: React.RefObject<TreeApi<ArboristNode> | null>; workspaceId?: string }) {
	const { t } = useTranslation();
	const items: ContextMenuItem[] = state.isRoot
		? [
			{ label: t("files.newFile", "New File"), onSelect: () => { treeRef.current?.create({ parentId: null, type: "leaf" }); } },
			{ label: t("files.newFolder", "New Folder"), onSelect: () => { treeRef.current?.create({ parentId: null, type: "internal" }); } },
			{ label: t("files.downloadFolder", "Download as ZIP"), onSelect: () => { triggerDownload(workspaceFolderZipUrl("", workspaceId)); } },
		]
		: [
			{ label: t("files.rename", "Rename"), onSelect: () => { const n = treeRef.current?.get(state.nodePath); n?.edit(); } },
			...(state.isDir
				? [{ label: t("files.downloadFolder", "Download as ZIP"), onSelect: () => { triggerDownload(workspaceFolderZipUrl(state.nodePath, workspaceId)); } }]
				: [{ label: t("files.download", "Download"), onSelect: () => { triggerDownload(workspaceFileUrl(state.nodePath, workspaceId, true)); } }]),
			{ label: t("files.delete", "Delete"), danger: true, onSelect: () => { const n = treeRef.current?.get(state.nodePath); if (n) treeRef.current?.delete(n.id); } },
			...(state.isDir ? [
				{ label: t("files.newFileHere", "New File Here"), onSelect: () => { const n = treeRef.current?.get(state.nodePath); n?.open(); treeRef.current?.create({ parentId: state.nodePath, type: "leaf" }); } },
				{ label: t("files.newFolderHere", "New Folder Here"), onSelect: () => { const n = treeRef.current?.get(state.nodePath); n?.open(); treeRef.current?.create({ parentId: state.nodePath, type: "internal" }); } },
			] : []),
		];

	return <ContextMenu x={state.x} y={state.y} items={items} onClose={onClose} />;
}

/* ---------- Delete Confirmation ---------- */

function DeleteConfirm({ paths, onConfirm, onCancel }: { paths: string[]; onConfirm: () => void; onCancel: () => void }) {
	const { t } = useTranslation();
	const names = paths.map((p) => p.split("/").pop() || p);
	return (
		<>
			<div className="fixed inset-0 z-40 bg-black/20" onClick={onCancel} />
			<div className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-5 shadow-xl">
				<div className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("files.confirmDelete", "Delete?")}</div>
				<div className="mb-4 text-xs text-[var(--inno-text-muted)]">
					{names.length === 1 ? names[0] : `${names.length} items`}
				</div>
				<div className="flex justify-end gap-2">
					<button className="rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]" onClick={onCancel}>
						{t("common.cancel", "Cancel")}
					</button>
					<button className="rounded-md bg-[var(--inno-danger)] px-3 py-1.5 text-xs text-white hover:bg-[var(--inno-danger)]" onClick={onConfirm}>
						{t("common.delete", "Delete")}
					</button>
				</div>
			</div>
		</>
	);
}

/* ---------- Main Component ---------- */

export function WorkspaceBrowser({ onPreviewFile, dndManager }: { onPreviewFile?: PreviewFileHandler; dndManager: DragDropManager }) {
	const { t } = useTranslation();
	const treeRef = useRef<TreeApi<ArboristNode>>(null);
	const skillUploadRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const treeContainerRef = useRef<HTMLDivElement>(null);
	const [treeHeight, setTreeHeight] = useState(400);
	const [treeWidth, setTreeWidth] = useState(260);
	const [panelWidth, setPanelWidth] = useState(600);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[] } | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [uploadError, setUploadError] = useState("");
	const uploadErrorTimerRef = useRef<number | null>(null);
	const [multiSelectMode, setMultiSelectMode] = useState(false);
	const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

	const state = useStoreSnapshot(workspaceStore, () => ({
		tree: workspaceStore.tree,
		currentFilePath: workspaceStore.currentFile?.path ?? null,
		isLoadingTree: workspaceStore.isLoadingTree,
		isMutating: workspaceStore.isMutating,
		activeWorkspaceId: workspaceStore.activeWorkspaceId,
	}));
	const wsState = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));
	const sessState = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	// The file tree pane keeps a fixed width; the content preview pane appears
	// only once the panel is dragged wide enough to fit it beside the tree.
	const showContent = sidebarOpen ? panelWidth >= CONTENT_REVEAL_WIDTH : true;

	// Measure the panel width to decide whether the content pane fits.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) setPanelWidth(Math.floor(entry.contentRect.width));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Measure tree container size for react-window (required by react-arborist)
	useLayoutEffect(() => {
		const el = treeContainerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) {
				// The browser stays mounted while the outer panel is collapsed.
				// ResizeObserver reports 0 for a display:none ancestor; keep
				// react-arborist on a valid positive viewport until the panel is
				// visible and the observer reports its real size.
				setTreeHeight(Math.max(1, Math.floor(entry.contentRect.height)));
				setTreeWidth(Math.max(180, Math.floor(entry.contentRect.width)));
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Smart input linkage: highlight (and scroll to) tree rows whose paths the
	// composer panels are hovering.
	useEffect(() => {
		const onHighlight = (event: Event) => {
			const paths = (event as CustomEvent<string[] | null>).detail;
			const root = treeContainerRef.current ?? rootRef.current;
			if (!root) return;
			const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-ws-path]"));
			let first: HTMLElement | null = null;
			const active = Array.isArray(paths) ? paths : [];
			for (const row of rows) {
				const on = active.includes(row.dataset.wsPath ?? "");
				row.classList.toggle("inno-smart-ws-hl", on);
				if (on && !first) first = row;
			}
			if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
		};
		window.addEventListener("inno-smart-highlight", onHighlight);
		return () => window.removeEventListener("inno-smart-highlight", onHighlight);
	}, []);

	useEffect(() => {
		void workspaceStore.loadTree();
		if (wsState.list.length === 0) {
			void workspacesStore.load();
		}
	}, []);

	// Discover the workspace that the current session is bound to (read-only).
	const [boundWorkspaceId, setBoundWorkspaceId] = useState<string | null>(null);
	useEffect(() => {
		if (!sessState.currentSessionId) {
			setBoundWorkspaceId(null);
			return;
		}
		let cancelled = false;
		void getSessionWorkspace(sessState.currentSessionId)
			.then((info) => { if (!cancelled) setBoundWorkspaceId(info.workspaceId); })
			.catch(() => { if (!cancelled) setBoundWorkspaceId(null); });
		return () => { cancelled = true; };
	}, [sessState.currentSessionId]);

	// Default the panel view to the session's bound workspace once known.
	useEffect(() => {
		if (boundWorkspaceId && state.activeWorkspaceId == null) {
			void workspaceStore.setActiveWorkspace(boundWorkspaceId);
		}
	}, [boundWorkspaceId, state.activeWorkspaceId]);

	// The session is fixed to one workspace; show its name (no switcher).
	const activeWorkspaceName = useMemo(() => {
		const id = state.activeWorkspaceId ?? boundWorkspaceId;
		if (!id) return "";
		const ws = wsState.list.find((w) => w.id === id);
		return ws ? `${ws.isTemp ? "🗒 " : ""}${ws.name}` : id;
	}, [state.activeWorkspaceId, boundWorkspaceId, wsState.list]);

	// Listen for custom context-menu events from node renderer
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { x: number; y: number; node: ArboristNode };
			setCtxMenu({ x: detail.x, y: detail.y, nodePath: detail.node.id, nodeName: detail.node.name, isDir: !detail.node.isLeaf });
		};
		document.addEventListener("workspace-ctx", handler);
		return () => document.removeEventListener("workspace-ctx", handler);
	}, []);

	const arboristData = useMemo(() => {
		if (!state.tree?.children) return [];
		return toArboristNodes(state.tree.children);
	}, [state.tree]);

	// File previews can also be opened from the smart-input panel, bypassing
	// the tree node's click handler. Keep react-arborist's visual selection in
	// sync with the store so both entry points identify the same file.
	useEffect(() => {
		if (multiSelectMode || !state.currentFilePath) return;
		const node = treeRef.current?.get(state.currentFilePath);
		if (node && !node.isSelected) node.select();
	}, [multiSelectMode, state.currentFilePath, arboristData]);

	// One Set shared by the file collection and the context value; collecting
	// with an empty selection would still walk the whole tree, so short-circuit.
	const selectedFileIdSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
	const selectedFiles = useMemo(
		() => selectedFileIdSet.size === 0 ? [] : collectSelectedWorkspaceFiles(arboristData, selectedFileIdSet),
		[arboristData, selectedFileIdSet],
	);

	/* --- Tree handlers --- */

	const onCreate: CreateHandler<ArboristNode> = useCallback(async ({ parentId, type }) => {
		const parentPath = parentId ?? "";
		const isFile = type === "leaf";
		const defaultName = isFile ? "untitled.txt" : "new-folder";
		const itemPath = parentPath ? `${parentPath}/${defaultName}` : defaultName;
		try {
			await workspaceStore.createItem(parentPath, defaultName, isFile ? "file" : "directory");
			return { id: itemPath };
		} catch {
			return null;
		}
	}, []);

	const onRename: RenameHandler<ArboristNode> = useCallback(async ({ id, name }) => {
		await workspaceStore.renameItem(id, name);
	}, []);

	const onDelete: DeleteHandler<ArboristNode> = useCallback(async ({ ids }) => {
		setDeleteConfirm({ ids });
	}, []);

	const onMove: MoveHandler<ArboristNode> = useCallback(async ({ dragIds, parentId }) => {
		const targetDir = parentId ?? "";
		for (const sourceId of dragIds) {
			await workspaceStore.moveItem(sourceId, targetDir);
		}
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		if (!deleteConfirm) return;
		for (const id of deleteConfirm.ids) {
			await workspaceStore.deleteItem(id);
		}
		treeRef.current?.deselectAll();
		setSelectedFileIds([]);
		setMultiSelectMode(false);
		setDeleteConfirm(null);
	}, [deleteConfirm]);

	const toggleMultiSelectMode = useCallback(() => {
		const currentPath = workspaceStore.currentFile?.path;
		treeRef.current?.deselectAll();
		if (multiSelectMode) {
			setSelectedFileIds([]);
			if (currentPath) treeRef.current?.get(currentPath)?.select();
		} else {
			// Entering multi-select starts empty. The preview selection is not a
			// checked file and must not inflate the visible count or drag batch.
			setSelectedFileIds([]);
		}
		setMultiSelectMode((enabled) => !enabled);
	}, [multiSelectMode]);

	/** Leave multi-select after a completed multi-file drag. */
	const exitMultiSelect = useCallback(() => {
		setSelectedFileIds([]);
		setMultiSelectMode(false);
	}, []);

	const toggleSelectedFile = useCallback((path: string) => {		setSelectedFileIds((current) => current.includes(path)
			? current.filter((id) => id !== path)
			: [...current, path]);
	}, []);

	const addSelectedFile = useCallback((path: string) => {
		setSelectedFileIds((current) => current.includes(path) ? current : [...current, path]);
	}, []);

	const multiSelectState = useMemo<WorkspaceMultiSelectState>(() => ({
		enabled: multiSelectMode,
		selectedIds: selectedFileIdSet,
		selectedFiles,
		toggleFile: toggleSelectedFile,
		addFile: addSelectedFile,
		exit: exitMultiSelect,
	}), [multiSelectMode, selectedFileIdSet, selectedFiles, toggleSelectedFile, addSelectedFile, exitMultiSelect]);

	useEffect(() => () => {
		if (uploadErrorTimerRef.current !== null) window.clearTimeout(uploadErrorTimerRef.current);
	}, []);

	/* --- Upload handlers --- */
	const showUploadError = useCallback((message: string) => {
		if (uploadErrorTimerRef.current !== null) window.clearTimeout(uploadErrorTimerRef.current);
		setUploadError(message);
		uploadErrorTimerRef.current = window.setTimeout(() => {
			uploadErrorTimerRef.current = null;
			setUploadError("");
		}, 2200);
	}, []);

	const clearUploadError = useCallback(() => {
		if (uploadErrorTimerRef.current !== null) {
			window.clearTimeout(uploadErrorTimerRef.current);
			uploadErrorTimerRef.current = null;
		}
		setUploadError("");
	}, []);

	const filterUploadFiles = useCallback((files: File[]): File[] => {
		const oversized = getOversizedFiles(files);
		if (oversized.length > 0) {
			showUploadError(t("files.uploadTooLarge", "有 {{count}} 个文件超过 {{limit}} 上限，未上传。", {
				count: oversized.length,
				limit: DEFAULT_UPLOAD_MAX_LABEL,
			}));
		} else {
			clearUploadError();
		}
		return files.filter((file) => !oversized.includes(file));
	}, [clearUploadError, showUploadError, t]);

	const selectedParentPath = useCallback(() => {
		const sel = treeRef.current?.selectedNodes?.[0];
		if (!sel) return "";
		return sel.isLeaf ? (sel.parent?.id ?? "") : sel.id;
	}, []);

	const handleSkillUploadChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files?.length) {
			for (const file of filterUploadFiles(Array.from(files))) {
				void workspaceStore.uploadSkillPackage(file);
			}
			e.target.value = "";
		}
	}, [filterUploadFiles]);

	/** Only true when dragging files from OS (not internal react-dnd tree drags) */
	const isExternalFileDrag = useCallback((e: DragEvent) => {
		return Array.from(e.dataTransfer?.types ?? []).includes("Files")
			|| Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === "file");
	}, []);

	const handleDragOver = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		const oversized = getOversizedFiles(filesFromDataTransfer(e.dataTransfer));
		if (oversized.length > 0) {
			if (uploadErrorTimerRef.current !== null) {
				window.clearTimeout(uploadErrorTimerRef.current);
				uploadErrorTimerRef.current = null;
			}
			setUploadError(t("files.uploadTooLarge", "有 {{count}} 个文件超过 {{limit}} 上限，未上传。", {
				count: oversized.length,
				limit: DEFAULT_UPLOAD_MAX_LABEL,
			}));
		} else if (uploadError) {
			clearUploadError();
		}
		setIsDragOver(true);
	}, [clearUploadError, isExternalFileDrag, t, uploadError]);

	const handleDragLeave = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		setIsDragOver(false);
		clearUploadError();
	}, [clearUploadError, isExternalFileDrag]);

	const handleDrop = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
		const droppedFiles = filesFromDataTransfer(e.dataTransfer);
		if (droppedFiles.length > 0) {
			const files = filterUploadFiles(droppedFiles);
			if (files.length > 0) void workspaceStore.uploadFiles(selectedParentPath(), files);
		} else {
			clearUploadError();
		}
	}, [clearUploadError, selectedParentPath, isExternalFileDrag, filterUploadFiles]);

	/* --- Toolbar button helpers --- */
	const busy = state.isMutating || state.isLoadingTree;

	return (
		<div ref={rootRef} className={`grid h-full min-h-0 gap-3 bg-transparent p-3 transition-[grid-template-columns] duration-200 ${showContent ? (sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]") : "grid-cols-[minmax(0,1fr)]"}`}>
			{/* --- Tree pane --- */}
			<aside
				className={`inno-workspace-card relative flex min-h-0 flex-col overflow-hidden rounded-lg transition-opacity duration-200 ${isDragOver ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : ""} ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDropCapture={handleDrop}
			>
				{/* Toolbar */}
				<div className="flex h-10 items-center gap-1 border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2">
					<div className="min-w-0 flex-1">
						<span className="block max-w-[220px] truncate px-1 text-xs font-medium text-[var(--inno-text)]" title={activeWorkspaceName}>
							{activeWorkspaceName || t("workspace.title")}
						</span>
					</div>
					<button
						disabled={busy}
						className={`flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 ${
							multiSelectMode
								? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
								: "text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)]"
						}`}
						title={multiSelectMode ? t("files.exitMultiSelect", "Exit multi-select") : t("files.multiSelect", "Select multiple files")}
						aria-label={multiSelectMode ? t("files.exitMultiSelect", "Exit multi-select") : t("files.multiSelect", "Select multiple files")}
						aria-pressed={multiSelectMode}
						onClick={toggleMultiSelectMode}
					>
						<ListChecks size={14} />
					</button>
					<button disabled={busy} className="flex h-6 w-6 items-center justify-center rounded text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)] disabled:opacity-40" title={t("files.uploadSkill", "Upload skill package (.zip/.md) to .skills")} onClick={() => skillUploadRef.current?.click()}>
						<Sparkles size={14} />
					</button>
					<button disabled={busy} className="flex h-6 w-6 items-center justify-center rounded text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-40" title={t("preview.refresh", "Refresh")} onClick={() => void workspaceStore.loadTree()}>
						<RefreshCw size={14} />
					</button>
					<input ref={skillUploadRef} type="file" multiple accept=".zip,application/zip,.md,text/markdown" className="hidden" onChange={handleSkillUploadChange} />
				</div>
				{uploadError ? <div className="border-b border-[var(--inno-border)] bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]" role="alert">{uploadError}</div> : null}

				{multiSelectMode ? (
					<div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-accent-soft)] px-2">
						<span className="min-w-0 flex-1 truncate text-[11px] text-[var(--inno-accent)]">
							{selectedFileIds.length
								? t("files.selectedCount", "Selected {{count}} files", { count: selectedFileIds.length })
								: t("files.fileSelectionOnly", "Select files (folders cannot be selected)")}
						</span>
						<button
							disabled={selectedFileIds.length === 0 || busy}
							className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--inno-danger)] transition-colors hover:bg-[var(--inno-surface)] disabled:cursor-not-allowed disabled:opacity-40"
							title={t("files.deleteSelected", "Delete selected files")}
							onClick={() => setDeleteConfirm({ ids: selectedFileIds })}
						>
							<Trash2 size={12} />
							{t("common.delete", "Delete")}
						</button>
					</div>
				) : null}

				{/* Tree */}
				<div
					ref={treeContainerRef}
					className="workspace-scroll relative min-h-0 flex-1 overflow-hidden"
					onContextMenu={(e) => {
						// Right-click on empty space → create at workspace root.
						e.preventDefault();
						setCtxMenu({ x: e.clientX, y: e.clientY, nodePath: "", nodeName: "", isDir: true, isRoot: true });
					}}
				>
					{state.isLoadingTree && !arboristData.length ? (
						<div className="p-3 text-xs text-[var(--inno-text-muted)]">{t("preview.loading", "Loading...")}</div>
					) : (
						<>
							{/* Always mount the Tree (even when empty) so treeRef is available
							    for root-level create actions from the context menu. */}
							<WorkspaceMultiSelectContext.Provider value={multiSelectState}>
								<Tree<ArboristNode>
									ref={treeRef}
									data={arboristData}
									width={treeWidth}
									height={treeHeight}
									dndManager={dndManager}
									indent={16}
									rowHeight={28}
									openByDefault={false}
									disableSelect={(node) => !node.isLeaf}
									disableDrag={busy}
									disableDrop={busy}
									onCreate={onCreate}
									onRename={onRename}
									onDelete={onDelete}
									onMove={onMove}
								>
									{(nodeProps) => <Node {...nodeProps} onPreviewFile={onPreviewFile} />}
								</Tree>
							</WorkspaceMultiSelectContext.Provider>
							{!arboristData.length && (
								<div className="pointer-events-none absolute left-0 top-0 p-3 text-xs text-[var(--inno-text-muted)]">
									{t("preview.empty", "Empty workspace")}
								</div>
							)}
						</>
					)}
				</div>

				{/* Drag overlay */}
				{isDragOver && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-[var(--inno-accent-soft)]">
						<div className={`rounded-lg bg-[var(--inno-surface)] px-4 py-2 text-xs font-medium shadow-sm ${uploadError ? "text-[var(--inno-danger)]" : "text-[var(--inno-accent)]"}`}>
							{uploadError || t("files.dropToUpload", "Drop files to upload")}
						</div>
					</div>
				)}
			</aside>

			{/* --- Preview / Edit pane --- */}
			{showContent ? (
				<section className="inno-workspace-card flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg">
					<div className="flex min-h-0 flex-1 flex-col">
						<FileContentPane onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
					</div>
				</section>
			) : null}

			{/* Context Menu */}
			{ctxMenu && <WorkspaceContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} treeRef={treeRef} workspaceId={state.activeWorkspaceId ?? undefined} />}

			{/* Delete Confirmation */}
			{deleteConfirm && <DeleteConfirm paths={deleteConfirm.ids} onConfirm={() => void handleConfirmDelete()} onCancel={() => setDeleteConfirm(null)} />}
		</div>
	);
}
