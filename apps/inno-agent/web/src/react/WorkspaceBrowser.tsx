import { createContext, lazy, memo, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DragDropManager } from "dnd-core";
import { Tree, type NodeRendererProps, type TreeApi, type CreateHandler, type RenameHandler, type DeleteHandler, type MoveHandler } from "react-arborist";
import { RefreshCw, FileText, FileType, Globe, File, FolderOpen, Folder, Pencil, Save, X, PanelLeftClose, PanelLeftOpen, Sparkles, Download, ExternalLink, FileCode2, Presentation, FileSpreadsheet, Copy, Check, ListChecks, Trash2, Search, ChevronRight } from "lucide-react";
import { workspaceStore, isStartTabKey, previewTabKey, type StreamingWorkspacePreview } from "../stores/workspace-store.js";
import { WorkspaceStartPage } from "./WorkspaceStartPage.js";
import { workspaceFileUrl, workspaceFolderZipUrl, triggerDownload } from "../api/workspace.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { appStore } from "../stores/app-store.js";
import { getSessionWorkspace } from "../api/workspaces.js";
import { RunButton } from "./terminal/RunButton.js";
import { LazyCodeEditor } from "./LazyCodeEditor.js";
import { LazyMarkdownEditor } from "./LazyMarkdownEditor.js";
import type { WorkspaceFileDetail, WorkspaceFileKind, WorkspaceOfficeFormat } from "../types/workspace.js";
import { type ArboristNode, toArboristNodes } from "../types/workspace.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { useStoreSnapshot } from "./hooks.js";
import {
	ContextMenu,
	type ContextMenuItem,
	Button,
	Dialog,
	IconButton,
	Input,
	Tooltip,
	Spinner,
} from "./ui/index.js";
import { getLongPressHandlers } from "./ui/long-press.js";
import { FileName } from "./FileName.js";
import { WorkspaceFileBar } from "./WorkspaceFileBar.js";
import type { WordEditorHandle } from "./office/WordEditor.js";
import { buildDragFilePanel, hiddenDragImage } from "./chat/smart-input/drag-utils.js";
import { DEFAULT_UPLOAD_MAX_LABEL, getOversizedFiles } from "../utils/upload-limits.js";
import "@earendil-works/pi-web-ui";

// Heavy office renderers are lazy-loaded so docx-preview / xlsx stay off the
// critical path and only download when an office file is actually opened.
const PptxPreview = lazy(() => import("./office/PptxPreview.js"));
const DocxPreview = lazy(() => import("./office/DocxPreview.js"));
const XlsxPreview = lazy(() => import("./office/XlsxPreview.js"));
const WordEditor = lazy(() => import("./office/WordEditor.js"));

const MAX_STREAMING_MARKDOWN_FORMAT_CHARS = 160_000;
type PreviewFileHandler = (minimumWidth: number) => void | Promise<void>;
const TREE_PANE_WIDTH = 260;
const PREVIEW_MIN_WIDTH = 150;
const WORKSPACE_BROWSER_GAP = 12;
const WORKSPACE_BROWSER_PADDING = 12;
// The browser uses `p-3` and `gap-3` in split mode. Include those tracks in
// the threshold so the preview is only mounted when it can actually keep its
// minimum width. This also prevents a split/single-pane feedback loop while
// the panel is being resized.
const CONTENT_REVEAL_WIDTH = TREE_PANE_WIDTH
	+ PREVIEW_MIN_WIDTH
	+ WORKSPACE_BROWSER_GAP
	+ WORKSPACE_BROWSER_PADDING * 2;
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
	if (lower.endsWith(".doc") || lower.endsWith(".docx")) return <FileText size={14} />;
	return <File size={14} />;
}

/** Derive the office format from a filename when the backend didn't supply it. */
function officeFormatFromName(name: string): WorkspaceOfficeFormat | undefined {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pptx")) return "pptx";
	if (lower.endsWith(".docx")) return "docx";
	if (lower.endsWith(".doc")) return "doc";
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

/* ---------- Artifact type filters (design mockup ap-tabs) ---------- */

type ArtifactFilter = "all" | "docs" | "sheets" | "images";

const FILTER_ORDER: ArtifactFilter[] = ["all", "docs", "sheets", "images"];

const FILTER_EXTS: Record<Exclude<ArtifactFilter, "all">, string[]> = {
	docs: [".md", ".markdown", ".txt", ".pdf", ".doc", ".docx", ".html", ".htm"],
	sheets: [".csv", ".tsv", ".xlsx"],
	images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"],
};

function collectFilesByExtension(nodes: ArboristNode[], exts?: string[], out: ArboristNode[] = []): ArboristNode[] {
	for (const node of nodes) {
		if (node.isLeaf) {
			const lower = node.name.toLowerCase();
			if (!exts || exts.some((ext) => lower.endsWith(ext))) out.push(node);
		} else if (node.children) {
			collectFilesByExtension(node.children, exts, out);
		}
	}
	return out;
}

/** Semantic tone per file kind for the artifact icon chips / preview card. */
function artifactTone(file: { kind: WorkspaceFileKind; format?: WorkspaceOfficeFormat }): { bg: string; fg: string } {
	if (file.kind === "office") return { bg: "var(--inno-accent-soft)", fg: "var(--inno-accent)" };
	if (file.kind === "pdf") return { bg: "var(--inno-danger-bg)", fg: "var(--inno-danger)" };
	if (file.kind === "image") return { bg: "var(--inno-success-bg)", fg: "var(--inno-success)" };
	return { bg: "var(--inno-chip-bg)", fg: "var(--inno-text-subtle)" };
}

/** Semantic tone by filename for flat filtered rows (no kind info in tree nodes). */
function artifactToneForName(name: string): { bg: string; fg: string } {
	const lower = name.toLowerCase();
	if (FILTER_EXTS.images.some((ext) => lower.endsWith(ext))) return { bg: "var(--inno-success-bg)", fg: "var(--inno-success)" };
	if (lower.endsWith(".pdf")) return { bg: "var(--inno-danger-bg)", fg: "var(--inno-danger)" };
	if (lower.endsWith(".pptx") || lower.endsWith(".docx") || lower.endsWith(".xlsx")) {
		return { bg: "var(--inno-accent-soft)", fg: "var(--inno-accent)" };
	}
	return { bg: "var(--inno-chip-bg)", fg: "var(--inno-text-subtle)" };
}

function artifactIcon(name: string, kind?: WorkspaceFileKind) {
	const lower = name.toLowerCase();
	if (kind === "image") return <FileType size={17} />;
	if (lower.endsWith(".pptx")) return <Presentation size={17} />;
	if (lower.endsWith(".xlsx") || isCsvName(lower)) return <FileSpreadsheet size={17} />;
	if (lower.endsWith(".pdf")) return <FileType size={17} />;
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return <Globe size={17} />;
	if (lower.endsWith(".docx") || lower.endsWith(".md") || lower.endsWith(".markdown")) return <FileText size={17} />;
	return <File size={17} />;
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
				<Button variant="secondary" size="xs" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</Button>
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
				<Button variant="secondary" size="xs" className="shrink-0" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</Button>
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
		if (fmt === "doc" || fmt === "docx") return <Suspense fallback={fallback}><DocxPreview file={file} /></Suspense>;
		if (fmt === "xlsx") return <Suspense fallback={fallback}><XlsxPreview file={file} /></Suspense>;
		return <OfficePreview file={file} />;
	}
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--inno-text-muted)]">
				<div className="text-lg font-medium text-[var(--inno-text)]">{file.name}</div>
				<div>{t("preview.binaryFile")} · {formatSize(file.size)}</div>
				<Button
					variant="secondary"
					size="xs"
					className="mt-2"
					onClick={() => workspaceStore.openAsText()}
				>
					<FileCode2 size={14} />
					{t("preview.openAsText", "Open as Text")}
				</Button>
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

function StreamingPreviewPane({ preview, onToggleSidebar, sidebarOpen }: { preview: StreamingWorkspacePreview; onToggleSidebar?: () => void; sidebarOpen: boolean }) {
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
			<div className="inno-workspace-content-toolbar flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					{onToggleSidebar ? <IconButton
						size="xs"
						className="inno-workspace-pane-toggle shrink-0"
						onClick={onToggleSidebar}
						title={sidebarOpen ? t("common.collapseSidebar", "收起侧栏") : t("common.expandSidebar", "展开侧栏")}
						aria-label={sidebarOpen ? t("common.collapseSidebar", "收起侧栏") : t("common.expandSidebar", "展开侧栏")}
					>
						{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
					</IconButton> : null}
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
					<Button
						variant="secondary"
						size="xs"
						disabled={!preview.content}
						onClick={copyContent}
					>
						{copied ? <Check size={12} /> : <Copy size={12} />}
						{copied ? t("common.copied", "已复制") : t("common.copy", "复制")}
					</Button>
					{isStreaming ? null : (
						<IconButton
							size="xs"
							title={t("preview.streamingClose", "关闭生成预览")}
							aria-label={t("preview.streamingClose", "关闭生成预览")}
							onClick={() => workspaceStore.clearStreamingPreview(preview.id)}
						>
							<X size={14} />
						</IconButton>
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

interface WordEditingSession {
	file: WorkspaceFileDetail;
	workspaceId: string | null;
}

function FileContentPane({ onToggleSidebar, sidebarOpen, emptyWhenUnselected = false, wordEditing, onEditWord }: { onToggleSidebar?: () => void; sidebarOpen: boolean; emptyWhenUnselected?: boolean; wordEditing: WordEditingSession | null; onEditWord(file: WorkspaceFileDetail, workspaceId: string | null): void }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(workspaceStore, () => ({
		file: workspaceStore.currentFile,
		isLoadingFile: workspaceStore.isLoadingFile,
		isEditing: workspaceStore.isEditing,
		editBuffer: workspaceStore.editBuffer,
		isSaving: workspaceStore.isSaving,
		error: workspaceStore.previewError || workspaceStore.error,
		streamingPreview: workspaceStore.streamingPreview,
		activePreviewPath: workspaceStore.activePreviewPath,
		fileWorkspaceId: workspaceStore.currentFileWorkspaceId,
		workspaceId: workspaceStore.activeWorkspaceId,
	}));

	const canEdit = state.file != null && isEditable(state.file.kind);

	if (state.streamingPreview) {
		return <StreamingPreviewPane key={state.streamingPreview.id} preview={state.streamingPreview} onToggleSidebar={onToggleSidebar} sidebarOpen={sidebarOpen} />;
	}
	if (isStartTabKey(state.activePreviewPath)) return <WorkspaceStartPage />;
	if (emptyWhenUnselected && !state.activePreviewPath && !state.file) return null;
	// While the inline DOCX editor owns this tab it also renders the shared file
	// bar; a second bar underneath would duplicate the title and actions.
	if (wordEditing) return null;

	if (state.isEditing && state.file) {
		const isMd = state.file.kind === "markdown";
		return (
			<div className="flex h-full flex-col">
				<WorkspaceFileBar name={state.file.name} path={state.file.path} onToggleSidebar={onToggleSidebar} sidebarOpen={sidebarOpen}>
					<Button
						size="xs"
						variant="primary"
						aria-label={t("common.save", "Save")}
						disabled={state.isSaving}
						onClick={() => void workspaceStore.saveFile()}
					>
						<Save size={14} />
						<span className="inno-filebar-action-label">{t("common.save", "Save")}</span>
					</Button>
					<Button
						size="xs"
						variant="secondary"
						aria-label={t("common.cancel", "Cancel")}
						disabled={state.isSaving}
						onClick={() => workspaceStore.cancelEditing()}
					>
						<X size={14} />
						<span className="inno-filebar-action-label">{t("common.cancel", "Cancel")}</span>
					</Button>
				</WorkspaceFileBar>
				{/* Reusing CodeMirror across file tabs merges their undo histories.
				    Remount both editor kinds per path; drafts remain owned by the store. */}
				<div key={state.activePreviewPath} className="min-h-0 flex-1">
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
			<WorkspaceFileBar name={state.file?.name ?? t("preview.noFile", "No file selected")} path={state.file?.path} onToggleSidebar={onToggleSidebar} sidebarOpen={sidebarOpen}>
				{state.file && state.fileWorkspaceId === state.workspaceId ? <RunButton filePath={state.file.path} /> : null}
				{state.file?.format === "docx" ? <Button variant="ghost" size="xs" aria-label={t("common.edit", "Edit")} title={t("common.edit", "Edit")} disabled={state.isLoadingFile} onClick={() => onEditWord(state.file!, state.fileWorkspaceId)}>
					<Pencil size={14} /><span className="inno-filebar-action-label">{t("common.edit", "Edit")}</span>
				</Button> : null}
				{canEdit && (
					<Button
						variant="secondary"
						size="xs"
						onClick={() => workspaceStore.startEditing()}
					>
						<Pencil size={12} />
						<span className="inno-filebar-action-label">{t("common.edit", "Edit")}</span>
					</Button>
				)}
			</WorkspaceFileBar>
			<div className="workspace-scroll min-h-0 flex-1 overflow-auto">
				{state.error ? <div className="p-4 text-sm text-[var(--inno-danger)]">{state.error}</div> : null}
				{!state.error && state.file ? <Preview file={state.file} isLoading={state.isLoadingFile} /> : null}
				{!state.error && !state.file ? <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{state.isLoadingFile ? <Spinner size={18} /> : t("preview.noPreview", "Nothing to preview")}</div> : null}
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

/** Reveal a file nested below closed folders before applying arborist selection. */
function revealAndSelectTreeFile(tree: TreeApi<ArboristNode> | null, path: string): void {
	if (!tree || !path) return;
	tree.openParents(path);

	const selectVisibleNode = () => {
		const node = tree.get(path);
		if (!node) return false;
		if (!node.isSelected) node.select();
		tree.scrollTo(path);
		return true;
	};

	// openParents updates the visible virtualized rows on the next render. Try
	// immediately for an already-visible file, then once more after that render.
	if (!selectVisibleNode()) window.requestAnimationFrame(selectVisibleNode);
}

function createWorkspaceDragImage(items: ReadonlyArray<WorkspaceDragItem>): HTMLElement {
	// Same shared panel the smart-input follower uses, so drags look identical
	// whether or not smart input is enabled.
	return buildDragFilePanel(items, true);
}

function Node({ node, style, dragHandle, onPreviewFile, isSidebar = false }: NodeRendererProps<ArboristNode> & { onPreviewFile?: PreviewFileHandler; isSidebar?: boolean }) {
	const rowRef = useRef<HTMLDivElement>(null);
	const isDir = !node.isLeaf;
	const isFileDragSource = node.isLeaf && !node.isEditing;
	const multiSelect = useContext(WorkspaceMultiSelectContext);
	const selected = multiSelect.enabled ? multiSelect.selectedIds.has(node.data.path) : !isSidebar && node.isSelected;

	const row = (
		<div
			// Files use the native file-binding drag source below. Keeping the
			// arborist drag handle on the same element makes react-dnd treat the
			// file drag as a tree move and prevents the composer from receiving it.
			ref={(element) => {
				rowRef.current = element;
				if (!isFileDragSource) dragHandle?.(element);
			}}
			draggable={isFileDragSource}
			style={style}
			data-ws-path={node.data.path}
			data-selected={selected}
			className={isSidebar ? `inno-sidebar-file-row group text-sm${isFileDragSource ? " inno-smart-ws-drag-row" : ""}` : `group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer select-none ${
				selected
					? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
					: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
			} ${isFileDragSource ? "inno-smart-ws-drag-row" : ""}`}
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
					if (!isSidebar && node.isSelected) {
						node.deselect();
						if (onPreviewFile) {
							void onPreviewFile(DEFAULT_PREVIEW_PANEL_WIDTH);
							return;
						}
						return;
					}
					if (isSidebar) node.deselect();
					else node.select();
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
			{...getLongPressHandlers((x, y) => {
				if (!isDir && !selected) {
					if (multiSelect.enabled) multiSelect.addFile(node.data.path);
					else node.select();
				}
				rowRef.current?.dispatchEvent(new CustomEvent("workspace-ctx", { detail: { x, y, node: node.data }, bubbles: true }));
			})}
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
			{isSidebar ? <ChevronRight size={12} className={`inno-sidebar-file-chevron${isDir ? "" : " is-file"}${node.isOpen ? " is-open" : ""}`} aria-hidden="true" /> : null}
			<span className="inno-workspace-file-icon flex h-4 w-4 shrink-0 items-center justify-center text-[var(--inno-text-subtle)]">
				{nodeIcon(node.data.name, isDir, node.isOpen)}
			</span>
			{node.isEditing ? (
				<Input
					size="sm"
					autoFocus
					className="min-w-0 flex-1 rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-1 py-0.5 text-xs outline-none"
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
					{node.isLeaf && <span className={isSidebar ? "inno-sidebar-file-size text-xs" : "text-[10px] opacity-50"}>{formatSize(node.data.size)}</span>}
				</>
			)}
		</div>
	);
	return row;
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
					<Button variant="secondary" size="xs" onClick={onCancel}>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button variant="danger" size="xs" onClick={onConfirm}>
						{t("common.delete", "Delete")}
					</Button>
				</div>
			</div>
		</>
	);
}

/* ---------- Main Component ---------- */

/**
 * Selected-file summary card (design mockup ap-preview) shown above the file
 * list while the panel is too narrow for the side-by-side content pane. Its
 * "open" action widens the panel so the real preview pane appears.
 */
function ArtifactPreviewCard({ file, workspaceId, onOpen }: { file: WorkspaceFileDetail; workspaceId?: string; onOpen: () => void }) {
	const { t } = useTranslation();
	const tone = artifactTone(file);
	const kindLabel = file.kind === "office" && file.format ? file.format.toUpperCase() : t(`workspace.kind.${file.kind}`, file.kind);
	const selectedLabel = t("files.selectedFile", "已选中{{name}}", { name: file.name });
	const updated = file.updatedAt
		? new Date(file.updatedAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
		: "";
	return (
			<div className="inno-workspace-selection-card relative flex shrink-0 items-start gap-2.5 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2.5">
				<Tooltip label={selectedLabel}>
					<span className="absolute right-2 top-2 rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--inno-accent)]">
						{t("files.selected", "已选中")}
					</span>
				</Tooltip>
			<div
				className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--inno-border)]"
				style={{ background: tone.bg, color: tone.fg }}
				aria-hidden="true"
			>
				{artifactIcon(file.name, file.kind)}
			</div>
			<div className="min-w-0 flex-1 pr-1">
				<Tooltip label={file.name}>
					<div className="truncate text-[12.5px] font-semibold text-[var(--inno-text)]">{file.name}</div>
				</Tooltip>
				<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[10.5px] text-[var(--inno-text-subtle)]">
					<span className="shrink-0 whitespace-nowrap">{kindLabel}</span>
					{file.size !== undefined ? <span aria-hidden="true">·</span> : null}
					<span className="shrink-0 whitespace-nowrap">{formatSize(file.size)}</span>
					{updated ? (
						<>
							<span aria-hidden="true">·</span>
							<Tooltip label={file.updatedAt ?? updated}>
								<time className="shrink-0 whitespace-nowrap" dateTime={file.updatedAt}>{updated}</time>
							</Tooltip>
						</>
					) : null}
				</div>
			</div>
			<div className="mt-4 flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="xs"
					className="inno-workspace-selection-action"
					title={t("common.open", "打开")}
					aria-label={t("common.open", "打开")}
					onClick={onOpen}
				>
					<ExternalLink size={12} />
					{t("common.open", "打开")}
				</Button>
				<IconButton
					size="xs"
					className="inno-workspace-selection-action"
					title={t("common.download", "下载")}
					aria-label={t("common.download", "下载")}
					onClick={() => triggerDownload(workspaceFileUrl(file.path, workspaceId, true))}
				>
					<Download size={13} />
				</IconButton>
			</div>
		</div>
	);
}

export function WorkspaceBrowser({ onPreviewFile, dndManager, variant = "workspace" }: { onPreviewFile?: PreviewFileHandler; dndManager: DragDropManager; variant?: "workspace" | "sidebar" | "preview" }) {
	const { t } = useTranslation();
	const isSidebar = variant === "sidebar";
	const isPreview = variant === "preview";
	const treeRef = useRef<TreeApi<ArboristNode>>(null);
	const skillUploadRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const treeContainerRef = useRef<HTMLDivElement>(null);
	const [treeHeight, setTreeHeight] = useState(400);
	const [treeWidth, setTreeWidth] = useState(260);
	const [panelWidth, setPanelWidth] = useState(600);
	const [sidebarOpen, setSidebarOpen] = useState(
		() => typeof window === "undefined" || !window.matchMedia("(max-width: 767px)").matches,
	);
	const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[] } | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [uploadError, setUploadError] = useState("");
	// Width changes unmount FileContentPane. Own the editor sessions here so
	// resizing cannot discard an active document draft, and keep each file/
	// workspace owner fixed. Every open document gets its own mounted editor
	// instance keyed by tab key, so parallel drafts, undo histories and edit
	// positions survive tab switches. Editors render inline in the preview pane.
	const [wordSessions, setWordSessions] = useState<WordEditingSession[]>([]);
	const wordSessionsRef = useRef<WordEditingSession[]>([]);
	const wordEditorRefs = useRef(new Map<string, WordEditorHandle>());
	// Closing a session's tab while it holds unsaved work routes through this
	// confirmation instead of losing the draft. Switching tabs never closes a
	// session, so tab activation alone never triggers it.
	const [wordLeaveConfirm, setWordLeaveConfirm] = useState<null | { tabKey: string; name: string }>(null);
	const [wordSaving, setWordSaving] = useState(false);
	const uploadErrorTimerRef = useRef<number | null>(null);
	const [multiSelectMode, setMultiSelectMode] = useState(false);
	const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
	const [typeFilter, setTypeFilter] = useState<ArtifactFilter>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const showFlatList = typeFilter !== "all" || (isSidebar && searchQuery.trim().length > 0);

	const state = useStoreSnapshot(workspaceStore, () => ({
		tree: workspaceStore.tree,
		currentFilePath: workspaceStore.currentFile?.path ?? null,
		currentFile: workspaceStore.currentFile,
		isLoadingTree: workspaceStore.isLoadingTree,
		isMutating: workspaceStore.isMutating,
		activeWorkspaceId: workspaceStore.activeWorkspaceId,
		fileWorkspaceId: workspaceStore.currentFileWorkspaceId,
		activePreviewPath: workspaceStore.activePreviewPath,
	}));
	const wsState = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));
	const sessState = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	// Desktop file management lives in the left sidebar. Its right preview must
	// stay visible at every width instead of reserving space for a duplicate tree.
	// Any active DOCX session pins the pane open: unmounting it would discard the draft.
	const hasWordSessions = wordSessions.length > 0;
	const showContent = !isSidebar && (isPreview || !sidebarOpen || panelWidth >= CONTENT_REVEAL_WIDTH || hasWordSessions);

	// Each editor is visible only while its own tab is active; switching tabs
	// keeps every session mounted (hidden, inert) so drafts survive round trips.
	const activeWordSession = wordSessions.find((session) => previewTabKey({ path: session.file.path, workspaceId: session.workspaceId }) === state.activePreviewPath) ?? null;

	// Every session mutation goes through these helpers so the ref mirror and
	// the state stay in lockstep; the close guard reads the synchronous mirror.
	const openWordSession = useCallback((session: WordEditingSession) => {
		const key = previewTabKey({ path: session.file.path, workspaceId: session.workspaceId });
		if (wordSessionsRef.current.some((current) => previewTabKey({ path: current.file.path, workspaceId: current.workspaceId }) === key)) return;
		wordSessionsRef.current = [...wordSessionsRef.current, session];
		setWordSessions(wordSessionsRef.current);
	}, []);
	const closeWordSession = useCallback((key: string) => {
		const session = wordSessionsRef.current.find((current) => previewTabKey({ path: current.file.path, workspaceId: current.workspaceId }) === key);
		if (!session) return;
		wordSessionsRef.current = wordSessionsRef.current.filter((current) => current !== session);
		setWordSessions(wordSessionsRef.current);
		return session;
	}, []);

	const openEditWord = useCallback((file: WorkspaceFileDetail, workspaceId: string | null) => {
		const key = previewTabKey({ path: file.path, workspaceId });
		// Reopening a file reuses its running session and tab; a new document
		// joins the existing sessions without touching their drafts.
		openWordSession({ file, workspaceId });
		if (workspaceStore.activePreviewPath !== key) workspaceStore.activatePreview(key);
	}, [openWordSession]);

	const closeWordEditor = useCallback((key: string) => {
		const session = closeWordSession(key);
		if (!session) return;
		void workspaceStore.selectFile(session.file.path, () => true, session.workspaceId);
	}, [closeWordSession]);

	// One guard for the whole close family (closePreview/closeOther/toRight/all/
	// deleteItem). A dirty session vetoes its own tab and raises the shared
	// confirmation; clean sessions may close, and the unmount watcher ends them.
	useEffect(() => {
		if (!hasWordSessions) return;
		workspaceStore.wordEditCloseGuard = (tabKey) => {
			const session = wordSessionsRef.current.find((current) => previewTabKey({ path: current.file.path, workspaceId: current.workspaceId }) === tabKey);
			if (!session || !wordEditorRefs.current.get(tabKey)?.isDirty()) return false;
			setWordLeaveConfirm({ tabKey, name: session.file.name });
			return true;
		};
		return () => { workspaceStore.wordEditCloseGuard = null; };
	}, [hasWordSessions]);

	// A clean session's tab can close without the guard (dirty closes are
	// vetoed). When a tab disappears, end its session so the hidden editor
	// does not linger for a file the user already closed.
	useEffect(() => {
		if (!hasWordSessions) return;
		const endOrphanedSessions = () => {
			let changed = false;
			wordSessionsRef.current = wordSessionsRef.current.filter((session) => {
				const orphaned = !workspaceStore.previewTabs.some((tab) => previewTabKey(tab) === previewTabKey({ path: session.file.path, workspaceId: session.workspaceId }));
				changed = changed || orphaned;
				return !orphaned;
			});
			if (changed) setWordSessions(wordSessionsRef.current);
		};
		endOrphanedSessions();
		return workspaceStore.on("change", endOrphanedSessions);
	}, [hasWordSessions]);

	const finishWordLeave = useCallback(async (mode: "discard" | "save", tabKey: string) => {
		if (mode === "save") {
			setWordSaving(true);
			let clean = false;
			try { clean = (await wordEditorRefs.current.get(tabKey)?.save()) ?? false; } finally { setWordSaving(false); }
			if (!clean) { setWordLeaveConfirm(null); return; }
		}
		// The session must leave the mirror before the close so the guard
		// re-runs against a session that no longer exists and lets it through.
		closeWordSession(tabKey);
		setWordLeaveConfirm(null);
		workspaceStore.closePreview(tabKey);
		// Closing the last file tab returns to a start page instead of an empty
		// pane — the same fallback the tab strip's close button applies.
		if (!workspaceStore.previewTabs.length && !workspaceStore.streamingPreview) workspaceStore.openStartPage();
	}, [closeWordSession]);

	// Measure the panel width to decide whether the content pane fits.
	useLayoutEffect(() => {
		if (isPreview) return;
		const el = rootRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (!entry) return;
			// `contentRect.width` changes when the single-pane class removes the
			// root padding. Read the border box instead so this measurement stays
			// independent of the layout branch it controls.
			setPanelWidth(Math.floor(el.getBoundingClientRect().width));
		});
		ro.observe(el);
		setPanelWidth(Math.floor(el.getBoundingClientRect().width));
		return () => ro.disconnect();
	}, [isPreview]);

	// On narrow screens the tree becomes an overlay; collapse it when crossing
	// into the narrow breakpoint so it never squeezes the content pane.
	useEffect(() => {
		if (isSidebar || isPreview) return;
		const narrowScreen = window.matchMedia("(max-width: 767px)");
		const closeSidebarOnNarrowScreen = (event: MediaQueryListEvent) => {
			if (event.matches) setSidebarOpen(false);
		};
		narrowScreen.addEventListener("change", closeSidebarOnNarrowScreen);
		return () => narrowScreen.removeEventListener("change", closeSidebarOnNarrowScreen);
	}, [isSidebar, isPreview]);

	// Measure tree container size for react-window (required by react-arborist).
	// Filtering unmounts the virtualized tree; observe its new container on return.
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
	}, [showFlatList, state.isLoadingTree]);

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
		// Both sidebar and workspace browsers share this store and its current load.
		if (!workspaceStore.tree && !workspaceStore.isLoadingTree) void workspaceStore.loadTree();
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
		return ws?.name ?? id;
	}, [state.activeWorkspaceId, boundWorkspaceId, wsState.list]);

	// Scope events to this browser: sidebar and right-panel trees may coexist,
	// and a document listener would open two menus for the same file operation.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { x: number; y: number; node: ArboristNode };
			setCtxMenu({ x: detail.x, y: detail.y, nodePath: detail.node.id, nodeName: detail.node.name, isDir: !detail.node.isLeaf });
		};
		root.addEventListener("workspace-ctx", handler);
		return () => root.removeEventListener("workspace-ctx", handler);
	}, []);

	const arboristData = useMemo(() => {
		if (!state.tree?.children) return [];
		return toArboristNodes(state.tree.children);
	}, [state.tree]);

	// Type filter tabs flatten the tree to matching files (read-only browsing;
	// create/rename/move stay available in the unfiltered tree view).
	const allFiles = useMemo(() => collectFilesByExtension(arboristData), [arboristData]);
	const filteredFiles = useMemo(() => {
		const query = isSidebar ? searchQuery.trim().toLocaleLowerCase() : "";
		return allFiles.filter((file) => (
			(typeFilter === "all" || FILTER_EXTS[typeFilter].some((ext) => file.name.toLowerCase().endsWith(ext)))
			&& (!query || file.name.toLocaleLowerCase().includes(query))
		));
	}, [typeFilter, allFiles, isSidebar, searchQuery]);

	/** Open a file from the flat filtered list (mirrors the tree row click). */
	const openArtifactFile = useCallback((path: string) => {
		treeRef.current?.deselectAll();
		if (!isSidebar) revealAndSelectTreeFile(treeRef.current, path);
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
		void workspaceStore.selectFile(path);
	}, [isSidebar, onPreviewFile]);

	// File previews can also be opened from the smart-input panel, bypassing
	// the tree node's click handler. Keep react-arborist's visual selection in
	// sync with the store so both entry points identify the same file.
	useEffect(() => {
		if (isSidebar || multiSelectMode || !state.currentFilePath || state.fileWorkspaceId !== state.activeWorkspaceId) return;
		revealAndSelectTreeFile(treeRef.current, state.currentFilePath);
	}, [isSidebar, multiSelectMode, state.currentFilePath, state.fileWorkspaceId, state.activeWorkspaceId, arboristData]);

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
			if (!isSidebar && currentPath) treeRef.current?.get(currentPath)?.select();
		} else {
			// Entering multi-select starts empty. The preview selection is not a
			// checked file and must not inflate the visible count or drag batch.
			setSelectedFileIds([]);
		}
		setMultiSelectMode((enabled) => !enabled);
	}, [isSidebar, multiSelectMode]);

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
		<div ref={rootRef} className={isSidebar ? "inno-workspace-browser inno-workspace-browser--sidebar" : isPreview ? "inno-workspace-browser inno-workspace-browser--single-pane relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)] bg-transparent" : `inno-workspace-browser relative grid h-full min-h-0 gap-3 bg-transparent p-3 transition-[grid-template-columns] duration-200 max-md:grid-cols-[minmax(0,1fr)] ${showContent ? "inno-workspace-browser--split" : "inno-workspace-browser--single-pane"} ${showContent ? (sidebarOpen ? "grid-cols-[260px_minmax(150px,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]") : "grid-cols-[minmax(0,1fr)]"}`}>
			{/* --- Tree pane — absolute overlay on phones --- */}
			{!isPreview ? <aside
				className={isSidebar ? "inno-workspace-tree-pane relative flex min-h-0 flex-col overflow-hidden" : `inno-workspace-card inno-workspace-pane inno-workspace-tree-pane relative flex min-h-0 flex-col overflow-hidden rounded-xl transition-opacity duration-200 max-md:absolute max-md:inset-3 max-md:z-20 max-md:bg-[var(--inno-surface)] ${isDragOver ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : ""} ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0 max-md:hidden"}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDropCapture={handleDrop}
			>
				{isSidebar ? (
					<div className="inno-sidebar-header px-3 pb-1 pt-2.5">
						{/* Match the Inno Agent header's 28px action row; a bare 24px title sits 2px too high. */}
						<div className="flex min-h-7 items-center">
							<h1 className="truncate text-base font-semibold tracking-tight text-[var(--inno-text)]">{t("nav.files")}</h1>
						</div>
					</div>
				) : null}
				{/* Toolbar */}
				<div className="inno-workspace-subheader inno-workspace-tree-toolbar flex h-10 items-center gap-1 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5">
					<div className="min-w-0 flex-1">
						<Tooltip label={activeWorkspaceName || t("workspace.title")}>
							<span className="flex max-w-[220px] items-center gap-1.5 truncate px-1 text-xs font-medium text-[var(--inno-text)]">
								<FolderOpen size={14} className="shrink-0 text-[var(--inno-text-subtle)]" aria-hidden="true" />
								{activeWorkspaceName || t("workspace.title")}
							</span>
						</Tooltip>
					</div>
				<IconButton
					variant="ghost"
					size="xs"
					className="inno-workspace-selection-action"
					disabled={busy}
					title={multiSelectMode ? t("files.exitMultiSelect", "Exit multi-select") : t("files.multiSelect", "Select multiple files")}
					aria-label={multiSelectMode ? t("files.exitMultiSelect", "Exit multi-select") : t("files.multiSelect", "Select multiple files")}
					aria-pressed={multiSelectMode}
					onClick={toggleMultiSelectMode}
				>
					<ListChecks size={14} />
				</IconButton>
				<IconButton size="xs" disabled={busy} aria-label={t("files.uploadSkill", "Upload skill package (.zip/.md) to .skills")} title={t("files.uploadSkill", "Upload skill package (.zip/.md) to .skills")} onClick={() => skillUploadRef.current?.click()}>
					<Sparkles size={14} />
				</IconButton>
				<IconButton size="xs" disabled={busy} aria-label={t("preview.refresh", "Refresh")} title={t("preview.refresh", "Refresh")} onClick={() => void workspaceStore.loadTree()}>
					<RefreshCw size={14} />
				</IconButton>
					<input ref={skillUploadRef} type="file" multiple accept=".zip,application/zip,.md,text/markdown" className="hidden" onChange={handleSkillUploadChange} />
				</div>

				{isSidebar ? (
					<div className="inno-sidebar-file-search relative">
						<Search size={14} className="inno-ui-input-leading-adornment" aria-hidden="true" />
						<Input size="sm" hasLeadingAdornment value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-label={t("files.searchFiles")} placeholder={t("files.searchFiles")} />
					</div>
				) : null}

				{/* Type filter tabs (design mockup ap-tabs). */}
				<div className="inno-workspace-filter-bar flex shrink-0 flex-wrap gap-1.5 border-b border-[var(--inno-border)] px-2.5 py-2">
					{FILTER_ORDER.map((filter) => {
						const active = typeFilter === filter;
						return (
							<Button
								key={filter}
								variant={active ? "primary" : "secondary"}
								size="xs"
								shape="pill"
								className="inno-filter-button"
								aria-pressed={active}
								onClick={() => setTypeFilter(filter)}
							>
								{t(`workspace.filters.${filter}`)}
							</Button>
						);
					})}
				</div>

				{/* Selected-file preview card (mockup ap-preview). Only useful while the
				    panel is too narrow for the side-by-side content pane — once the
				    preview pane is visible it is the preview. */}
				{!isSidebar && !showContent && state.currentFile ? (
					<ArtifactPreviewCard
						file={state.currentFile}
						workspaceId={state.fileWorkspaceId ?? undefined}
						onOpen={() => {
							if (onPreviewFile) void onPreviewFile(DEFAULT_PREVIEW_PANEL_WIDTH);
							else appStore.setWorkspaceWidth(DEFAULT_PREVIEW_PANEL_WIDTH);
						}}
					/>
				) : null}

				{uploadError ? <div className="border-b border-[var(--inno-border)] bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]" role="alert">{uploadError}</div> : null}

				{multiSelectMode ? (
					<div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-accent-soft)] px-2">
						<span className="min-w-0 flex-1 truncate text-[11px] text-[var(--inno-accent)]">
							{selectedFileIds.length
								? t("files.selectedCount", "Selected {{count}} files", { count: selectedFileIds.length })
								: t("files.fileSelectionOnly", "Select files (folders cannot be selected)")}
						</span>
						<Button
							variant="danger"
							size="xs"
							disabled={selectedFileIds.length === 0 || busy}
							title={t("files.deleteSelected", "Delete selected files")}
							onClick={() => setDeleteConfirm({ ids: selectedFileIds })}
						>
							<Trash2 size={12} />
							{t("common.delete", "Delete")}
						</Button>
					</div>
				) : null}

				{/* Tree (unfiltered) or flat type-filtered file list */}
				{showFlatList ? (
					<div className="workspace-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
						{filteredFiles.length === 0 ? (
							<div className="inno-sidebar-files-empty p-3 text-xs text-[var(--inno-text-muted)]">{t(searchQuery.trim() ? "files.noResults" : "preview.empty")}</div>
						) : (
							filteredFiles.map((node) => {
								const tone = artifactToneForName(node.name);
							const selected = !isSidebar && state.fileWorkspaceId === state.activeWorkspaceId && state.currentFilePath === node.path;
								return (
									<Button
										variant="ghost"
										size="sm"
										key={node.path}
										type="button"
										data-ws-path={node.path}
										aria-pressed={selected}
										onClick={() => openArtifactFile(node.path)}
										className={isSidebar ? "inno-sidebar-file-result" : `flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
											selected ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"
										}`}
									>
										<span className="inno-workspace-file-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={isSidebar ? undefined : { background: tone.bg, color: tone.fg }}>
											{artifactIcon(node.name)}
										</span>
										<span className="min-w-0 flex-1">
											<FileName name={node.name} className={`block truncate font-medium text-[var(--inno-text)] ${isSidebar ? "text-sm" : "text-[13px]"}`} />
											<span className={`mt-0.5 block text-[var(--inno-text-subtle)] ${isSidebar ? "text-xs" : "text-[11px]"}`}>{formatSize(node.size)}</span>
										</span>
									</Button>
								);
							})
						)}
					</div>
				) : (
				<div
					ref={treeContainerRef}
					className="workspace-scroll relative min-h-0 flex-1 overflow-hidden"
					onContextMenu={(e) => {
						// Right-click on empty space → create at workspace root.
						e.preventDefault();
						setCtxMenu({ x: e.clientX, y: e.clientY, nodePath: "", nodeName: "", isDir: true, isRoot: true });
					}}
					{...getLongPressHandlers((x, y) => setCtxMenu({ x, y, nodePath: "", nodeName: "", isDir: true, isRoot: true }))}
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
									rowHeight={isSidebar ? 36 : 28}
									openByDefault={false}
									disableSelect={(node) => !node.isLeaf}
									disableDrag={busy}
									disableDrop={busy}
									onCreate={onCreate}
									onRename={onRename}
									onDelete={onDelete}
									onMove={onMove}
								>
									{(nodeProps) => <Node {...nodeProps} isSidebar={isSidebar} onPreviewFile={onPreviewFile} />}
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
				)}

				{isSidebar ? (
					<div className="inno-sidebar-files-footer text-xs">
						<Folder size={14} aria-hidden="true" />
						<span>{t("files.fileCount", { count: showFlatList ? filteredFiles.length : allFiles.length })}</span>
					</div>
				) : null}

				{/* Drag overlay */}
				{isDragOver && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-[var(--inno-accent-soft)]">
						<div className={`rounded-lg bg-[var(--inno-surface)] px-4 py-2 text-xs font-medium shadow-sm ${uploadError ? "text-[var(--inno-danger)]" : "text-[var(--inno-accent)]"}`}>
							{uploadError || t("files.dropToUpload", "Drop files to upload")}
						</div>
					</div>
				)}
			</aside> : null}

			{/* --- Preview / Edit pane --- */}
			{showContent ? (
				<section className="inno-workspace-card inno-workspace-pane inno-workspace-preview-pane flex min-w-0 min-h-0 flex-col overflow-hidden rounded-xl">
					<div className="relative flex min-h-0 flex-1 flex-col">
						<FileContentPane
							onToggleSidebar={isPreview ? undefined : () => setSidebarOpen((v) => !v)}
							sidebarOpen={sidebarOpen}
							emptyWhenUnselected={isPreview}
							wordEditing={activeWordSession}
							onEditWord={openEditWord}
						/>
						{/* Inline DOCX editor layers, one per open document. Hidden (not
						    unmounted) while another tab is active so every draft, undo
						    history and edit position survives tab switches; `inert` keeps
						    hidden engines from taking focus or shortcuts. */}
						{wordSessions.map((session) => {
							const key = previewTabKey({ path: session.file.path, workspaceId: session.workspaceId });
							const tabActive = key === state.activePreviewPath;
							return (
								<div key={key} className={`absolute inset-0 flex flex-col ${tabActive ? "" : "invisible"}`} inert={!tabActive || undefined} aria-hidden={!tabActive || undefined}>
									<Suspense fallback={<div role="status" className="flex flex-1 items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("wordEditor.loading")}</div>}>
										<WordEditor
											ref={(handle) => { if (handle) wordEditorRefs.current.set(key, handle); else wordEditorRefs.current.delete(key); }}
											file={session.file}
											workspaceId={session.workspaceId}
											active={tabActive}
											onClose={() => closeWordEditor(key)}
										/>
									</Suspense>
								</div>
							);
						})}
						{/* DOCX leave confirmation: closing a session's tab while its
						    editor holds unsaved work. Switching tabs never closes a
						    session, so tab activation alone never reaches this dialog;
						    the outcome ends only the confirmed file's session and tab.
						    Rendered inside the preview pane (Dialog scoped
						    mode) so the dialog and mask center on the document pane instead
						    of the whole window; it sits outside the hidden editor layer so
						    it stays visible when the editor tab is backgrounded. */}
						{wordLeaveConfirm ? (
							<Dialog scoped label={t("wordEditor.closeTitle")} className="inno-word-confirm-dialog" onClose={() => setWordLeaveConfirm(null)}>
								<div className="inno-word-confirm-card flex flex-col gap-5 p-6">
									<div>
										<h2 className="text-base font-medium">{t("wordEditor.closeTitle")}</h2>
										<p className="mt-2 text-sm text-[var(--inno-text-muted)]">{t("wordEditor.closeMessage")}</p>
									</div>
									<div className="flex flex-wrap justify-end gap-2">
										<Button size="sm" onClick={() => setWordLeaveConfirm(null)}>
											{t("wordEditor.continueEditing")}
										</Button>
										<Button size="sm" disabled={wordSaving} onClick={() => void finishWordLeave("discard", wordLeaveConfirm.tabKey)}>
											{t("wordEditor.discard")}
										</Button>
										<Button variant="primary" size="sm" disabled={wordSaving} onClick={() => void finishWordLeave("save", wordLeaveConfirm.tabKey)}>
											{wordSaving ? <Spinner size={14} /> : <Save size={14} />}
											{t("wordEditor.saveAndClose")}
										</Button>
									</div>
								</div>
							</Dialog>
						) : null}
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
