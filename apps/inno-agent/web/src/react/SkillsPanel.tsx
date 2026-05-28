import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeRendererProps } from "react-arborist";
import MDEditor from "@uiw/react-md-editor";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json as jsonLang } from "@codemirror/lang-json";
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
import { RefreshCw, Upload, Trash2, ChevronLeft, File, FileText, FileType, Folder, FolderOpen, Globe, Pencil, Save, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { skillsStore } from "../stores/skills-store.js";
import { skillRawUrl } from "../api/skills.js";
import type { SkillInfo } from "../types/skills.js";
import type { WorkspaceFileDetail, WorkspaceFileKind } from "../types/workspace.js";
import { type ArboristNode, toArboristNodes } from "../types/workspace.js";
import { useStoreSnapshot } from "./hooks.js";
import "@earendil-works/pi-web-ui";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

/* ---------- helpers (same as WorkspaceBrowser) ---------- */

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

function isEditable(kind: WorkspaceFileKind): boolean {
	return kind === "markdown" || kind === "text";
}

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

function cmLangExtension(lang: string): Extension[] {
	switch (lang) {
		case "typescript": case "tsx": return [javascript({ jsx: true, typescript: true })];
		case "javascript": case "jsx": return [javascript({ jsx: true })];
		case "python": return [python()];
		case "json": return [jsonLang()];
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

/* ---------- File Preview ---------- */

function FilePreview({ file, skillName, isLoading }: { file: WorkspaceFileDetail; skillName: string; isLoading: boolean }) {
	const { t } = useTranslation();
	if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.loadingFile", "Loading...")}</div>;
	if (file.kind === "markdown") return <div className="h-full overflow-y-auto p-5"><markdown-artifact content={file.content ?? ""} /></div>;
	if (file.kind === "html") return <iframe className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin" srcDoc={file.content ?? ""} title={file.name} />;
	if (file.kind === "pdf") return <iframe className="h-full w-full border-0 bg-white" src={file.url ?? skillRawUrl(skillName, file.path)} title={file.name} />;
	if (file.kind === "image") {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-slate-50 p-4">
				<img className="max-h-full max-w-full object-contain" src={file.url ?? skillRawUrl(skillName, file.path)} alt={file.name} />
			</div>
		);
	}
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center text-sm text-slate-500">
				<div className="mb-2 text-lg font-medium text-slate-950">{file.name}</div>
				<div>{t("preview.binaryFile", "Binary file")} · {formatSize(file.size)}</div>
			</div>
		);
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

/* ---------- Tree Node ---------- */

function SkillFileNode({ node, style, dragHandle }: NodeRendererProps<ArboristNode>) {
	const selected = node.isSelected;
	const isDir = !node.isLeaf;
	return (
		<div
			ref={dragHandle}
			style={style}
			className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer select-none ${
				selected ? "bg-blue-50 text-blue-700 ring-1 ring-blue-100" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
			}`}
			onClick={(e) => {
				e.stopPropagation();
				if (isDir) node.toggle();
				else {
					node.select();
					void skillsStore.selectFile(node.data.path);
				}
			}}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400">
				{nodeIcon(node.data.name, isDir, node.isOpen)}
			</span>
			<span className="min-w-0 flex-1 truncate">{node.data.name}</span>
			{node.isLeaf && <span className="text-[10px] opacity-50">{formatSize(node.data.size)}</span>}
		</div>
	);
}

/* ---------- Skill File Content Pane ---------- */

function SkillFilePane({ skillName, onToggleSidebar, sidebarOpen }: { skillName: string; onToggleSidebar: () => void; sidebarOpen: boolean }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(skillsStore, () => ({
		file: skillsStore.currentFile,
		isLoadingFile: skillsStore.isLoadingFile,
		isEditing: skillsStore.isEditing,
		editBuffer: skillsStore.editBuffer,
		isSaving: skillsStore.isSaving,
	}));

	const canEdit = state.file != null && isEditable(state.file.kind);

	if (state.isEditing && state.file) {
		const isMd = state.file.kind === "markdown";
		const lang = langFromName(state.file.name);
		const extensions = cmLangExtension(lang);
		return (
			<div className="flex h-full flex-col">
				<div className="flex h-10 items-center justify-between border-b border-slate-200 bg-white px-3">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onToggleSidebar}>
							{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
						</button>
						<div className="min-w-0">
							<div className="truncate text-sm font-medium">{state.file.name}</div>
							<div className="truncate text-[10px] text-slate-500">{t("files.editing", "Editing")} · {state.file.path}</div>
						</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button disabled={state.isSaving} className="flex h-7 items-center gap-1 rounded-md bg-slate-900 px-2.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50" onClick={() => void skillsStore.saveFile()}>
							<Save size={12} /> {t("common.save", "Save")}
						</button>
						<button disabled={state.isSaving} className="flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50" onClick={() => skillsStore.cancelEditing()}>
							<X size={12} /> {t("common.cancel", "Cancel")}
						</button>
					</div>
				</div>
				<div className="min-h-0 flex-1">
					{isMd ? (
						<div className="h-full overflow-hidden" data-color-mode="light">
							<MDEditor value={state.editBuffer} onChange={(v) => skillsStore.updateEditBuffer(v ?? "")} height="100%" preview="live" visibleDragbar={false} style={{ height: "100%" }} />
						</div>
					) : (
						<div className="h-full overflow-hidden">
							<CodeMirror value={state.editBuffer} height="100%" extensions={extensions} onChange={(v) => skillsStore.updateEditBuffer(v)} basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true }} style={{ height: "100%", fontSize: "12px" }} />
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 items-center justify-between border-b border-slate-200 bg-white px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onToggleSidebar}>
						{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
					</button>
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{state.file?.name ?? t("preview.noFile", "No file selected")}</div>
						<div className="truncate text-[10px] text-slate-500">
							{state.file ? `${state.file.path} · ${formatSize(state.file.size)}` : t("preview.selectFile", "Select a file to preview")}
						</div>
					</div>
				</div>
				{canEdit && (
					<button className="flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-950" onClick={() => skillsStore.startEditing()}>
						<Pencil size={12} /> {t("common.edit", "Edit")}
					</button>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{state.file ? <FilePreview file={state.file} skillName={skillName} isLoading={state.isLoadingFile} /> : (
					<div className="flex h-full items-center justify-center text-sm text-slate-500">{t("preview.noPreview", "Nothing to preview")}</div>
				)}
			</div>
		</div>
	);
}

/* ---------- Skill Detail View ---------- */

function SkillDetail({ skill, onBack }: { skill: SkillInfo; onBack: () => void }) {
	const { t } = useTranslation();
	const treeContainerRef = useRef<HTMLDivElement>(null);
	const [treeHeight, setTreeHeight] = useState(400);
	const [sidebarOpen, setSidebarOpen] = useState(true);

	const state = useStoreSnapshot(skillsStore, () => ({
		skillTree: skillsStore.skillTree,
		isLoadingTree: skillsStore.isLoadingTree,
	}));

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
		void skillsStore.selectSkill(skill.name);
	}, [skill.name]);

	const arboristData = useMemo(() => {
		if (!state.skillTree) return [];
		return toArboristNodes(state.skillTree);
	}, [state.skillTree]);

	return (
		<div className={`grid h-full min-h-0 gap-3 transition-[grid-template-columns] duration-200 ${sidebarOpen ? "grid-cols-[240px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}>
			{/* File tree sidebar */}
			<aside className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition-opacity duration-200 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				{/* Skill header */}
				<div className="flex items-center gap-2 border-b border-slate-200 px-2 py-2">
					<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onBack}>
						<ChevronLeft size={16} />
					</button>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="truncate text-sm font-medium text-slate-950">{skill.name}</span>
							<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${skill.enabled ? "bg-green-50 text-green-700 ring-1 ring-green-100" : "bg-slate-100 text-slate-500"}`}>
								{skill.enabled ? t("common.enabled", "Enabled") : t("common.disabled", "Disabled")}
							</span>
						</div>
					</div>
				</div>

				{/* Toolbar */}
				<div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5">
					<label className="flex items-center gap-1.5 text-xs text-slate-500">
						<input type="checkbox" className="h-3.5 w-3.5" checked={skill.enabled} onChange={(e) => void skillsStore.setEnabled(skill.name, e.target.checked)} />
						{t("common.enable", "Enable")}
					</label>
					<div className="flex-1" />
					<button className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700" title={t("preview.refresh", "Refresh")} onClick={() => void skillsStore.refreshTree()}>
						<RefreshCw size={12} />
					</button>
					<button className="flex h-6 w-6 items-center justify-center rounded text-red-400 hover:bg-red-50 hover:text-red-600" title={t("common.delete", "Delete")} onClick={() => { void skillsStore.remove(skill.name); onBack(); }}>
						<Trash2 size={12} />
					</button>
				</div>

				{/* File tree */}
				<div ref={treeContainerRef} className="min-h-0 flex-1 overflow-hidden">
					{state.isLoadingTree && !arboristData.length ? (
						<div className="flex items-center justify-center py-8 text-slate-500">
							<span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
						</div>
					) : !arboristData.length ? (
						<div className="p-3 text-xs text-slate-500">{t("preview.empty", "Empty")}</div>
					) : (
						<Tree<ArboristNode>
							data={arboristData}
							width={240}
							height={treeHeight}
							indent={16}
							rowHeight={28}
							openByDefault
							disableDrag
							disableDrop
						>
							{SkillFileNode}
						</Tree>
					)}
				</div>
			</aside>

			{/* File content pane */}
			<section className="flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
				<SkillFilePane skillName={skill.name} onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
			</section>
		</div>
	);
}

/* ---------- Skill Row ---------- */

function SkillRow({ skill, onClick }: { skill: SkillInfo; onClick: () => void }) {
	return (
		<button
			className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition-colors hover:bg-slate-50"
			onClick={onClick}
		>
			<span className={`h-2 w-2 shrink-0 rounded-full ${skill.enabled ? "bg-green-500" : "bg-slate-300"}`} />
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium text-slate-950">{skill.name}</div>
				{skill.description && <div className="truncate text-xs text-slate-500">{skill.description}</div>}
			</div>
			<span className="shrink-0 text-[10px] text-slate-400">{formatSize(skill.size)}</span>
		</button>
	);
}

/* ---------- Main SkillsPanel ---------- */

export function SkillsPanel() {
	const { t } = useTranslation();
	const uploadRef = useRef<HTMLInputElement | null>(null);
	const state = useStoreSnapshot(skillsStore, () => ({
		skills: skillsStore.skills,
		selectedSkill: skillsStore.selectedSkill,
		isLoading: skillsStore.isLoading,
		isUploading: skillsStore.isUploading,
		error: skillsStore.error,
	}));

	useEffect(() => {
		void skillsStore.load();
	}, []);

	function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		if (!file) return;
		void skillsStore.upload(file);
		event.target.value = "";
	}

	const activeSkill = state.selectedSkill ? state.skills.find((s) => s.name === state.selectedSkill) : null;

	// Detail view — file browser
	if (activeSkill) {
		return (
			<div className="flex h-full flex-col p-3">
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<SkillDetail skill={activeSkill} onBack={() => skillsStore.deselectSkill()} />
				</div>
			</div>
		);
	}

	// List view — one skill per row
	return (
		<div className="flex h-full flex-col p-3">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
				{/* Toolbar */}
				<div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
					<h3 className="text-sm font-medium text-slate-950">{t("skills.title")}</h3>
					<div className="flex shrink-0 items-center gap-2">
						<input ref={uploadRef} type="file" className="hidden" accept=".zip,application/zip,.md,text/markdown,text/plain" onChange={handleUpload} />
						<button className="flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-950" onClick={() => void skillsStore.reload()}>
							<RefreshCw size={13} />
						</button>
						<button className="flex h-7 items-center gap-1 rounded-md bg-slate-900 px-2.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50" disabled={state.isUploading} onClick={() => uploadRef.current?.click()}>
							<Upload size={13} />
							{state.isUploading ? t("skills.uploading") : t("skills.upload")}
						</button>
					</div>
				</div>
				{state.error ? <div className="border-b border-slate-200 bg-red-50 px-3 py-2 text-xs text-red-700">{state.error}</div> : null}

				{/* Skills list */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.isLoading ? (
						<div className="flex items-center justify-center py-8 text-slate-500">
							<span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
							{t("common.loading")}
						</div>
					) : state.skills.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center text-center text-sm text-slate-500">
							<div className="text-base font-medium text-slate-950">{t("skills.empty")}</div>
							<p className="mt-1 max-w-sm text-xs">{t("skills.emptyDesc")}</p>
						</div>
					) : (
						state.skills.map((skill) => (
							<SkillRow key={skill.name} skill={skill} onClick={() => void skillsStore.selectSkill(skill.name)} />
						))
					)}
				</div>
			</div>
		</div>
	);
}
