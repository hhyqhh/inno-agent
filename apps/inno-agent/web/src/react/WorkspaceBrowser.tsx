import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeRendererProps, type TreeApi, type CreateHandler, type RenameHandler, type DeleteHandler, type MoveHandler } from "react-arborist";
import MDEditor from "@uiw/react-md-editor";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { markdown as cmMarkdown } from "@codemirror/lang-markdown";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import type { Extension } from "@codemirror/state";
import { RefreshCw, FileText, FileType, Globe, File, FolderOpen, Folder, Pencil, Save, X, PanelLeftClose, PanelLeftOpen, Sparkles, Download } from "lucide-react";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspaceFileUrl, workspaceFolderZipUrl, triggerDownload } from "../api/workspace.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { getSessionWorkspace } from "../api/workspaces.js";
import { TerminalDrawer } from "./terminal/TerminalDrawer.js";
import { RunButton } from "./terminal/RunButton.js";
import type { WorkspaceFileDetail, WorkspaceFileKind } from "../types/workspace.js";
import { type ArboristNode, toArboristNodes } from "../types/workspace.js";
import { useStoreSnapshot } from "./hooks.js";
import "@earendil-works/pi-web-ui";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

/* ---------- helpers ---------- */

function formatSize(size = 0): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function nodeIcon(name: string, isDir: boolean, isOpen: boolean) {
	if (isDir) return isOpen ? <FolderOpen size={14} /> : <Folder size={14} />;
	const lower = name.toLowerCase();
	if (lower.endsWith(".md")) return <FileText size={14} />;
	if (lower.endsWith(".pdf")) return <FileType size={14} />;
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return <Globe size={14} />;
	return <File size={14} />;
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

/** Return CodeMirror language extension for the given lang key */
function cmLangExtension(lang: string): Extension[] {
	switch (lang) {
		case "typescript": case "tsx": return [javascript({ jsx: true, typescript: true })];
		case "javascript": case "jsx": return [javascript({ jsx: true })];
		case "python": return [python()];
		case "json": return [json()];
		case "html": return [html()];
		case "css": case "scss": case "less": return [css()];
		case "xml": return [xml()];
		case "yaml": case "toml": return [yaml()];
		case "sql": return [sql()];
		case "markdown": return [cmMarkdown()];
		case "java": case "kotlin": return [java()];
		case "c": case "cpp": return [cpp()];
		case "rust": return [rust()];
		case "go": return [go()];
		default: return [];
	}
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
		return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.emptyTable", "Empty table")}</div>;
	}
	const [header, ...body] = rows;
	return (
		<div className="h-full overflow-auto bg-white p-3">
			<table className="w-full border-collapse text-xs">
				<thead className="sticky top-0 z-10">
					<tr>
						{header.map((cell, i) => (
							<th key={i} className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700">
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((r, ri) => (
						<tr key={ri} className="odd:bg-white even:bg-slate-50/60">
							{header.map((_, ci) => (
								<td key={ci} className="border border-slate-200 px-2 py-1 align-top text-slate-600">
									{r[ci] ?? ""}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			<div className="mt-2 text-[10px] text-slate-400">{t("preview.tableRows", "{{count}} rows", { count: body.length })}</div>
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
		return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.officeParsing", "Extracting document text...")}</div>;
	}
	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-500">
				<div className="font-medium text-slate-700">{file.name}</div>
				<div className="text-xs text-red-500">{error}</div>
				<button className="flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
		);
	}
	const pages = data?.pages?.length ? data.pages : (data ? [{ pageNumber: 1, text: data.text }] : []);
	return (
		<div className="workspace-scroll h-full overflow-auto bg-slate-50 p-4">
			<div className="mb-3 flex items-center justify-between gap-2">
				<div className="text-xs text-slate-500">
					{t("preview.officeNote", "Text extracted for preview · formatting may differ")} · {t("preview.pageCount", "{{count}} pages", { count: data?.pageCount ?? pages.length })}
				</div>
				<button className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
			<div className="space-y-3">
				{pages.map((p) => (
					<div key={p.pageNumber} className="rounded-lg border border-slate-200 bg-white p-4">
						{pages.length > 1 ? (
							<div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-400">
								{t("preview.page", "Page")} {p.pageNumber}
							</div>
						) : null}
						<pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-slate-700">{p.text}</pre>
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

  return <iframe className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={html} title={file.name} />;
}

/* ---------- Preview (read-only) ---------- */

function Preview({ file, isLoading }: { file: WorkspaceFileDetail; isLoading: boolean }) {
	const { t } = useTranslation();
	if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.loadingFile")}</div>;
	if (file.kind === "markdown") return <div className="workspace-scroll h-full overflow-y-auto p-5"><markdown-artifact content={file.content ?? ""} /></div>;
		if (file.kind === "html") return <HtmlPreview file={file} />;
	if (file.kind === "pdf") {
		// Default to fit-width so the PDF fills the preview panel horizontally.
		// `view=FitH` (PDF Open Params) + `zoom=page-width` covers Chromium and Firefox.
		// Users can still zoom in/out further via the native PDF viewer toolbar.
		const baseUrl = file.url ?? "";
		const pdfUrl = baseUrl
			? `${baseUrl}${baseUrl.includes("#") ? "&" : "#"}view=FitH&zoom=page-width`
			: "";
		return <iframe className="h-full w-full border-0 bg-white" src={pdfUrl} title={file.name} />;
	}
	if (file.kind === "image") {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-slate-50 p-4">
				<img className="max-h-full max-w-full object-contain" src={file.url ?? ""} alt={file.name} />
			</div>
		);
	}
	if (file.kind === "office") {
		return <OfficePreview file={file} />;
	}
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center text-sm text-slate-500">
				<div className="mb-2 text-lg font-medium text-slate-950">{file.name}</div>
				<div>{t("preview.binaryFile")} · {formatSize(file.size)}</div>
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
		<div className="h-full overflow-hidden">
			<CodeMirror
				value={file.content ?? ""}
				height="100%"
				readOnly
				editable={false}
				extensions={cmLangExtension(lang)}
				basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: false }}
				style={{ height: "100%", fontSize: "12px" }}
			/>
		</div>
	);
}

/* ---------- Markdown Editor ---------- */

function MarkdownEditorPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return (
		<div className="h-full overflow-hidden" data-color-mode="light">
			<MDEditor
				value={value}
				onChange={(v) => onChange(v ?? "")}
				height="100%"
				preview="live"
				visibleDragbar={false}
				style={{ height: "100%" }}
			/>
		</div>
	);
}

/* ---------- Code Editor (CodeMirror) ---------- */

function CodeEditorPane({ value, onChange, lang }: { value: string; onChange: (v: string) => void; lang: string }) {
	const extensions = useMemo(() => cmLangExtension(lang), [lang]);
	return (
		<div className="h-full overflow-hidden">
			<CodeMirror
				value={value}
				height="100%"
				extensions={extensions}
				onChange={onChange}
				basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true }}
				style={{ height: "100%", fontSize: "12px" }}
			/>
		</div>
	);
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
	}));

	const canEdit = state.file != null && isEditable(state.file.kind);

	if (state.isEditing && state.file) {
		const isMd = state.file.kind === "markdown";
		return (
			<div className="flex h-full flex-col">
				{/* Editor toolbar */}
				<div className="flex h-10 items-center justify-between border-b border-slate-200 bg-white px-3">
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{state.file.name}</div>
						<div className="truncate text-[10px] text-slate-500">{t("files.editing", "Editing")} · {state.file.path}</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button
							disabled={state.isSaving}
							className="flex h-7 items-center gap-1 rounded-md bg-slate-900 px-2.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
							onClick={() => void workspaceStore.saveFile()}
						>
							<Save size={12} />
							{t("common.save", "Save")}
						</button>
						<button
							disabled={state.isSaving}
							className="flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
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
			<div className="flex h-10 items-center justify-between border-b border-slate-200 bg-white px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<button
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
						onClick={onToggleSidebar}
						title={sidebarOpen ? t("common.collapseSidebar", "Collapse sidebar") : t("common.expandSidebar", "Expand sidebar")}
					>
						{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
					</button>
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{state.file?.name ?? t("preview.noFile", "No file selected")}</div>
						<div className="truncate text-[10px] text-slate-500">
							{state.file ? `${state.file.path} · ${formatSize(state.file.size)}` : t("preview.selectFile", "Select a file to preview")}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{state.file && !simpleMode ? <RunButton filePath={state.file.path} /> : null}
					{canEdit && (
						<button
							className="flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-950"
							onClick={() => workspaceStore.startEditing()}
						>
							<Pencil size={12} />
							{t("common.edit", "Edit")}
						</button>
					)}
				</div>
			</div>
			<div className="workspace-scroll min-h-0 flex-1 overflow-auto">
				{state.error ? <div className="p-4 text-sm text-red-500">{state.error}</div> : null}
				{!state.error && state.file ? <Preview file={state.file} isLoading={state.isLoadingFile} /> : null}
				{!state.error && !state.file ? <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.noPreview", "Nothing to preview")}</div> : null}
			</div>
		</div>
	);
}

/* ---------- Custom Node Renderer ---------- */

function Node({ node, style, dragHandle }: NodeRendererProps<ArboristNode>) {
	const selected = node.isSelected;
	const isDir = !node.isLeaf;

	return (
		<div
			ref={dragHandle}
			style={style}
			className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer select-none ${
				selected ? "bg-blue-50 text-blue-700 ring-1 ring-blue-100" : "text-slate-600 hover:bg-slate-100/85 hover:text-slate-950"
			}`}
			onClick={(e) => {
				e.stopPropagation();
				if (isDir) node.toggle();
				else {
					node.select();
					void workspaceStore.selectFile(node.data.path);
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				node.select();
				const ev = new CustomEvent("workspace-ctx", { detail: { x: e.clientX, y: e.clientY, node: node.data }, bubbles: true });
				e.currentTarget.dispatchEvent(ev);
			}}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400">
				{nodeIcon(node.data.name, isDir, node.isOpen)}
			</span>
			{node.isEditing ? (
				<input
					autoFocus
					className="min-w-0 flex-1 rounded border border-blue-300 bg-white px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-blue-200"
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
					<span className="min-w-0 flex-1 truncate">{node.data.name}</span>
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

function ContextMenu({ state, onClose, treeRef, workspaceId }: { state: CtxMenuState; onClose: () => void; treeRef: React.RefObject<TreeApi<ArboristNode> | null>; workspaceId?: string }) {
	const { t } = useTranslation();
	const items = state.isRoot
		? [
			{ label: t("files.newFile", "New File"), action: () => { treeRef.current?.create({ parentId: null, type: "leaf" }); } },
			{ label: t("files.newFolder", "New Folder"), action: () => { treeRef.current?.create({ parentId: null, type: "internal" }); } },
			{ label: t("files.downloadFolder", "Download as ZIP"), action: () => { triggerDownload(workspaceFolderZipUrl("", workspaceId)); } },
		]
		: [
			{ label: t("files.rename", "Rename"), action: () => { const n = treeRef.current?.get(state.nodePath); n?.edit(); } },
			...(state.isDir
				? [{ label: t("files.downloadFolder", "Download as ZIP"), action: () => { triggerDownload(workspaceFolderZipUrl(state.nodePath, workspaceId)); } }]
				: [{ label: t("files.download", "Download"), action: () => { triggerDownload(workspaceFileUrl(state.nodePath, workspaceId, true)); } }]),
			{ label: t("files.delete", "Delete"), action: () => { const n = treeRef.current?.get(state.nodePath); if (n) treeRef.current?.delete(n.id); } },
			...(state.isDir ? [
				{ label: t("files.newFileHere", "New File Here"), action: () => { const n = treeRef.current?.get(state.nodePath); n?.open(); treeRef.current?.create({ parentId: state.nodePath, type: "leaf" }); } },
				{ label: t("files.newFolderHere", "New Folder Here"), action: () => { const n = treeRef.current?.get(state.nodePath); n?.open(); treeRef.current?.create({ parentId: state.nodePath, type: "internal" }); } },
			] : []),
		];

	return (
		<>
			<div className="fixed inset-0 z-40" onClick={onClose} />
			<div className="fixed z-50 min-w-[140px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg" style={{ left: state.x, top: state.y }}>
				{items.map((item) => (
					<button
						key={item.label}
						className="flex w-full items-center px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
						onClick={() => { item.action(); onClose(); }}
					>
						{item.label}
					</button>
				))}
			</div>
		</>
	);
}

/* ---------- Delete Confirmation ---------- */

function DeleteConfirm({ paths, onConfirm, onCancel }: { paths: string[]; onConfirm: () => void; onCancel: () => void }) {
	const { t } = useTranslation();
	const names = paths.map((p) => p.split("/").pop() || p);
	return (
		<>
			<div className="fixed inset-0 z-40 bg-black/20" onClick={onCancel} />
			<div className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
				<div className="mb-3 text-sm font-medium text-slate-950">{t("files.confirmDelete", "Delete?")}</div>
				<div className="mb-4 text-xs text-slate-500">
					{names.length === 1 ? names[0] : `${names.length} items`}
				</div>
				<div className="flex justify-end gap-2">
					<button className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50" onClick={onCancel}>
						{t("common.cancel", "Cancel")}
					</button>
					<button className="rounded-md bg-red-500 px-3 py-1.5 text-xs text-white hover:bg-red-600" onClick={onConfirm}>
						{t("common.delete", "Delete")}
					</button>
				</div>
			</div>
		</>
	);
}

/* ---------- Main Component ---------- */

export function WorkspaceBrowser() {
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

	const state = useStoreSnapshot(workspaceStore, () => ({
		tree: workspaceStore.tree,
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
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	// The file tree pane keeps a fixed width; the content preview pane appears
	// only once the panel is dragged wide enough to fit it beside the tree.
	const TREE_PANE_WIDTH = 260;
	const CONTENT_REVEAL_WIDTH = TREE_PANE_WIDTH + 150;
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
				setTreeHeight(Math.floor(entry.contentRect.height));
				setTreeWidth(Math.max(180, Math.floor(entry.contentRect.width)));
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
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
		setDeleteConfirm(null);
	}, [deleteConfirm]);

	/* --- Upload handlers --- */

	const selectedParentPath = useCallback(() => {
		const sel = treeRef.current?.selectedNodes?.[0];
		if (!sel) return "";
		return sel.isLeaf ? (sel.parent?.id ?? "") : sel.id;
	}, []);

	const handleSkillUploadChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files?.length) {
			for (const file of Array.from(files)) {
				void workspaceStore.uploadSkillPackage(file);
			}
			e.target.value = "";
		}
	}, []);

	/** Only true when dragging files from OS (not internal react-dnd tree drags) */
	const isExternalFileDrag = useCallback((e: DragEvent) => {
		return e.dataTransfer.types.includes("Files");
	}, []);

	const handleDragOver = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		setIsDragOver(true);
	}, [isExternalFileDrag]);

	const handleDragLeave = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		setIsDragOver(false);
	}, [isExternalFileDrag]);

	const handleDrop = useCallback((e: DragEvent) => {
		if (!isExternalFileDrag(e)) return;
		e.preventDefault();
		setIsDragOver(false);
		if (e.dataTransfer.files?.length) {
			void workspaceStore.uploadFiles(selectedParentPath(), e.dataTransfer.files);
		}
	}, [selectedParentPath, isExternalFileDrag]);

	/* --- Toolbar button helpers --- */
	const busy = state.isMutating || state.isLoadingTree;

	return (
		<div ref={rootRef} className={`grid h-full min-h-0 gap-3 bg-transparent p-3 transition-[grid-template-columns] duration-200 ${showContent ? (sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]") : "grid-cols-[minmax(0,1fr)]"}`}>
			{/* --- Tree pane --- */}
			<aside
				className={`inno-workspace-card relative flex min-h-0 flex-col overflow-hidden rounded-lg transition-opacity duration-200 ${isDragOver ? "border-blue-400 bg-blue-50" : ""} ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{/* Toolbar */}
				<div className="flex h-10 items-center gap-1 border-b border-slate-200 bg-slate-50 px-2">
					<div className="min-w-0 flex-1">
						<span className="block max-w-[220px] truncate px-1 text-xs font-medium text-slate-700" title={activeWorkspaceName}>
							{activeWorkspaceName || "工作区"}
						</span>
					</div>
					<button disabled={busy} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-violet-100 hover:text-violet-600 disabled:opacity-40" title={t("files.uploadSkill", "上传技能包 (.zip/.md) 到 .skills")} onClick={() => skillUploadRef.current?.click()}>
						<Sparkles size={13} />
					</button>
					<button disabled={busy} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40" title={t("preview.refresh", "Refresh")} onClick={() => void workspaceStore.loadTree()}>
						<RefreshCw size={13} />
					</button>
					<input ref={skillUploadRef} type="file" multiple accept=".zip,application/zip,.md,text/markdown" className="hidden" onChange={handleSkillUploadChange} />
				</div>

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
						<div className="p-3 text-xs text-slate-500">{t("preview.loading", "Loading...")}</div>
					) : (
						<>
							{/* Always mount the Tree (even when empty) so treeRef is available
							    for root-level create actions from the context menu. */}
							<Tree<ArboristNode>
								ref={treeRef}
								data={arboristData}
								width={treeWidth}
								height={treeHeight}
								indent={16}
								rowHeight={28}
								openByDefault={false}
								disableDrag={busy}
								disableDrop={busy}
								onCreate={onCreate}
								onRename={onRename}
								onDelete={onDelete}
								onMove={onMove}
							>
								{Node}
							</Tree>
							{!arboristData.length && (
								<div className="pointer-events-none absolute left-0 top-0 p-3 text-xs text-slate-500">
									{t("preview.empty", "Empty workspace")}
								</div>
							)}
						</>
					)}
				</div>

				{/* Drag overlay */}
				{isDragOver && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-blue-50">
						<div className="rounded-lg bg-white px-4 py-2 text-xs font-medium text-blue-600 shadow-sm">{t("files.dropToUpload", "Drop files to upload")}</div>
					</div>
				)}
			</aside>

			{/* --- Preview / Edit pane --- */}
			{showContent ? (
				<section className="inno-workspace-card flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg">
					<div className="flex min-h-0 flex-1 flex-col">
						<FileContentPane onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
					</div>
					{!simpleMode && <TerminalDrawer />}
				</section>
			) : null}

			{/* Context Menu */}
			{ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} treeRef={treeRef} workspaceId={state.activeWorkspaceId ?? undefined} />}

			{/* Delete Confirmation */}
			{deleteConfirm && <DeleteConfirm paths={deleteConfirm.ids} onConfirm={() => void handleConfirmDelete()} onCancel={() => setDeleteConfirm(null)} />}
		</div>
	);
}
