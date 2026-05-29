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
import { RefreshCw, FileText, FileType, Globe, File, FolderOpen, Folder, Pencil, Save, X, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
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

/* ---------- Preview (read-only) ---------- */

function Preview({ file, isLoading }: { file: WorkspaceFileDetail; isLoading: boolean }) {
	const { t } = useTranslation();
	if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.loadingFile")}</div>;
	if (file.kind === "markdown") return <div className="workspace-scroll h-full overflow-y-auto p-5"><markdown-artifact content={file.content ?? ""} /></div>;
	if (file.kind === "html") {
		// Wrap the user-supplied HTML so that:
		//   • in-document anchors (`#section`) still scroll inside the iframe
		//   • external links / forms open in a new tab instead of navigating the iframe
		//   • attempts to navigate window.top / window.parent are neutralized
		// Without this, clicking buttons or links inside e.g. paper_2309.11994.html
		// either jumped the preview panel away or popped open a fresh app instance.
		const raw = file.content ?? "";
		const guardScript = `
<script>(function(){
	function scrollToId(id){
		if(!id){ window.scrollTo(0,0); return; }
		var t = document.getElementById(id) || document.getElementsByName(id)[0];
		if(t && t.scrollIntoView) t.scrollIntoView({behavior:'smooth', block:'start'});
	}
	document.addEventListener('click', function(ev){
		var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
		if(!a) return;
		var href = a.getAttribute('href');
		// Fragment / in-page anchor: scroll programmatically so the iframe
		// doesn't try to navigate to the parent app's URL + #fragment.
		if(href && (href === '#' || href.charAt(0) === '#')){
			ev.preventDefault();
			scrollToId(href.slice(1));
			return;
		}
		// Empty / javascript: / unknown: swallow to avoid replacing the iframe.
		if(!href || href === '' || href.toLowerCase().indexOf('javascript:') === 0){
			ev.preventDefault();
			return;
		}
		// Anything else: open in a new tab.
		ev.preventDefault();
		try { window.open(a.href, '_blank', 'noopener'); } catch(e) {}
	}, true);
	document.addEventListener('submit', function(ev){
		var f = ev.target;
		if(!f) return;
		ev.preventDefault();
		try {
			var url = (f.action && f.action !== '') ? f.action : null;
			if(url) window.open(url, '_blank', 'noopener');
		} catch(e) {}
	}, true);
})();</script>`;
		const html = /<head[^>]*>/i.test(raw)
			? raw.replace(/<head([^>]*)>/i, `<head$1>${guardScript}`)
			: `<!doctype html><html><head>${guardScript}</head><body>${raw}</body></html>`;
		return (
			<iframe
				className="h-full w-full border-0 bg-white"
				sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				srcDoc={html}
				title={file.name}
			/>
		);
	}
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
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center text-sm text-slate-500">
				<div className="mb-2 text-lg font-medium text-slate-950">{file.name}</div>
				<div>{t("preview.binaryFile")} · {formatSize(file.size)}</div>
			</div>
		);
	}
	// text / code — syntax-highlighted via CodeMirror (read-only)
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
					{state.file ? <RunButton filePath={state.file.path} /> : null}
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

function ContextMenu({ state, onClose, treeRef }: { state: CtxMenuState; onClose: () => void; treeRef: React.RefObject<TreeApi<ArboristNode> | null> }) {
	const { t } = useTranslation();
	const items = state.isRoot
		? [
			{ label: t("files.newFile", "New File"), action: () => { treeRef.current?.create({ parentId: null, type: "leaf" }); } },
			{ label: t("files.newFolder", "New Folder"), action: () => { treeRef.current?.create({ parentId: null, type: "internal" }); } },
		]
		: [
			{ label: t("files.rename", "Rename"), action: () => { const n = treeRef.current?.get(state.nodePath); n?.edit(); } },
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
	const treeContainerRef = useRef<HTMLDivElement>(null);
	const [treeHeight, setTreeHeight] = useState(400);
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

	// Measure tree container height for react-window (required by react-arborist)
	useLayoutEffect(() => {
		const el = treeContainerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) setTreeHeight(Math.floor(entry.contentRect.height));
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
		<div className={`grid h-full min-h-0 gap-3 bg-transparent p-3 transition-[grid-template-columns] duration-200 ${sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}>
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
					className="workspace-scroll min-h-0 flex-1 overflow-hidden"
					onContextMenu={(e) => {
						// Right-click on empty space → create at workspace root.
						e.preventDefault();
						setCtxMenu({ x: e.clientX, y: e.clientY, nodePath: "", nodeName: "", isDir: true, isRoot: true });
					}}
				>
					{state.isLoadingTree && !arboristData.length ? (
						<div className="p-3 text-xs text-slate-500">{t("preview.loading", "Loading...")}</div>
					) : !arboristData.length ? (
						<div className="p-3 text-xs text-slate-500">{t("preview.empty", "Empty workspace")}</div>
					) : (
						<Tree<ArboristNode>
							ref={treeRef}
							data={arboristData}
							width={260}
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
			<section className="inno-workspace-card flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg">
				<div className="flex min-h-0 flex-1 flex-col">
					<FileContentPane onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
				</div>
				<TerminalDrawer />
			</section>

			{/* Context Menu */}
			{ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} treeRef={treeRef} />}

			{/* Delete Confirmation */}
			{deleteConfirm && <DeleteConfirm paths={deleteConfirm.ids} onConfirm={() => void handleConfirmDelete()} onCancel={() => setDeleteConfirm(null)} />}
		</div>
	);
}
