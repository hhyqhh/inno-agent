import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DragDropManager } from "dnd-core";
import { Tree, type NodeRendererProps } from "react-arborist";
import { RefreshCw, Upload, Trash2, ChevronLeft, File, FileText, FileType, Folder, FolderOpen, Globe, Pencil, Save, X, PanelLeftClose, PanelLeftOpen, Download, Check, FileCode2, Search, Puzzle } from "lucide-react";
import { skillsStore } from "../stores/skills-store.js";
import { skillRawUrl } from '../api/skills.js';
import type { SkillInfo, SkillLibraryItem } from "../types/skills.js";
import type { WorkspaceFileDetail, WorkspaceFileKind, WorkspaceTreeNode } from "../types/workspace.js";
import { type ArboristNode, toArboristNodes } from "../types/workspace.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { groupByCategory, matchesQuery } from "../utils/category-grouping.js";
import { useStoreSnapshot } from "./hooks.js";
import { checkboxCls } from "./ui/checkbox.js";
import { Spinner } from "./ui/Spinner.js";
import { LazyCodeEditor } from "./LazyCodeEditor.js";
import { LazyMarkdownEditor } from "./LazyMarkdownEditor.js";
import { FileName } from "./FileName.js";
import "@earendil-works/pi-web-ui";

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

function findSkillReadme(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode | null {
	for (const node of nodes) {
		if (node.type === "file" && node.name.toLowerCase() === "skill.md") return node;
		const nested = node.children ? findSkillReadme(node.children) : null;
		if (nested) return nested;
	}
	return null;
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

function SkillHtmlPreview({ file }: { file: WorkspaceFileDetail }) {
  return <iframe className="h-full w-full border-0 bg-[var(--inno-surface)]" sandbox="allow-scripts allow-same-origin" srcDoc={file.content ?? ""} title={file.name} />;
}

/* ---------- File Preview ---------- */

function FilePreview({ file, skillName, isLoading }: { file: WorkspaceFileDetail; skillName: string; isLoading: boolean }) {
	const { t } = useTranslation();
	if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.loadingFile", "Loading...")}</div>;
	if (file.kind === "markdown") return <div className="h-full overflow-y-auto p-5"><markdown-artifact content={normalizeMarkdownMath(file.content ?? "")} /></div>;
	if (file.kind === "html") return <SkillHtmlPreview file={file} />;
	if (file.kind === "pdf") return <iframe className="h-full w-full border-0 bg-[var(--inno-surface)]" src={file.url ?? skillRawUrl(skillName, file.path)} title={file.name} />;
	if (file.kind === "image") {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-[var(--inno-surface-muted)] p-4">
				<img className="max-h-full max-w-full object-contain" src={file.url ?? skillRawUrl(skillName, file.path)} alt={file.name} />
			</div>
		);
	}
	if (file.kind === "binary") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--inno-text-muted)]">
				<div className="text-lg font-medium text-[var(--inno-text)]">{file.name}</div>
				<div>{t("preview.binaryFile", "Binary file")} · {formatSize(file.size)}</div>
				<button
					className="mt-2 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
					onClick={() => skillsStore.openAsText()}
				>
					<FileCode2 size={14} />
					{t("preview.openAsText", "Open as Text")}
				</button>
			</div>
		);
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

/* ---------- Tree Node ---------- */

function SkillFileNode({ node, style, dragHandle }: NodeRendererProps<ArboristNode>) {
	const selected = node.isSelected;
	const isDir = !node.isLeaf;
	return (
		<div
			ref={dragHandle}
			style={style}
			className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer select-none ${
				selected
					? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
					: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
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
			<span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--inno-text-subtle)]">
				{nodeIcon(node.data.name, isDir, node.isOpen)}
			</span>
			<FileName name={node.data.name} className="min-w-0 flex-1" />
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
		return (
			<div className="flex h-full flex-col">
				<div className="flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={onToggleSidebar}>
							{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
						</button>
						<div className="min-w-0">
							<FileName name={state.file.name} className="text-sm font-medium" />
							<div className="truncate text-[10px] text-[var(--inno-text-muted)]">{t("files.editing", "Editing")} · {state.file.path}</div>
						</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button disabled={state.isSaving} className="flex h-7 items-center gap-1 rounded-md inno-primary-button px-2.5 text-xs text-white disabled:opacity-50" onClick={() => void skillsStore.saveFile()}>
							<Save size={12} /> {t("common.save", "Save")}
						</button>
						<button disabled={state.isSaving} className="flex h-7 items-center gap-1 rounded-md px-2.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50" onClick={() => skillsStore.cancelEditing()}>
							<X size={12} /> {t("common.cancel", "Cancel")}
						</button>
					</div>
				</div>
				<div className="min-h-0 flex-1">
					{isMd ? (
						<LazyMarkdownEditor value={state.editBuffer} onChange={(v) => skillsStore.updateEditBuffer(v)} />
					) : (
						<LazyCodeEditor value={state.editBuffer} lang={lang} onChange={(v) => skillsStore.updateEditBuffer(v)} />
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={onToggleSidebar}>
						{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
					</button>
					<div className="min-w-0">
						{state.file ? <FileName name={state.file.name} className="text-sm font-medium" /> : <div className="text-sm font-medium">{t("preview.noFile", "No file selected")}</div>}
						<div className="truncate text-[10px] text-[var(--inno-text-muted)]">
							{state.file ? `${state.file.path} · ${formatSize(state.file.size)}` : t("preview.selectFile", "Select a file to preview")}
						</div>
					</div>
				</div>
				{canEdit && (
					<button className="flex h-7 items-center gap-1 rounded-md px-2.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => skillsStore.startEditing()}>
						<Pencil size={12} /> {t("common.edit", "Edit")}
					</button>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{state.file ? <FilePreview file={state.file} skillName={skillName} isLoading={state.isLoadingFile} /> : (
					<div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.noPreview", "Nothing to preview")}</div>
				)}
			</div>
		</div>
	);
}

/* ---------- Skill Detail View ---------- */

function SkillDetail({ skill, onBack, dndManager }: { skill: SkillInfo; onBack: () => void; dndManager: DragDropManager }) {
	const { t } = useTranslation();
	const treeContainerRef = useRef<HTMLDivElement>(null);
	const [treeHeight, setTreeHeight] = useState(400);
	const [treeWidth, setTreeWidth] = useState(240);
	const [sidebarOpen, setSidebarOpen] = useState(
		() => typeof window === "undefined" || !window.matchMedia("(max-width: 767px)").matches,
	);

	// Phones get the file tree as an overlay (below) — keep it closed when the
	// viewport crosses into narrow so it never squeezes the editor column.
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 767px)");
		const onChange = (e: MediaQueryListEvent) => {
			if (e.matches) setSidebarOpen(false);
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const state = useStoreSnapshot(skillsStore, () => ({
		skillTree: skillsStore.skillTree,
		isLoadingTree: skillsStore.isLoadingTree,
	}));

	useLayoutEffect(() => {
		const el = treeContainerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) {
				setTreeHeight(Math.max(1, Math.floor(entry.contentRect.height)));
				setTreeWidth(Math.max(1, Math.floor(entry.contentRect.width)));
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		void skillsStore.selectSkill(skill.name).then(async () => {
			if (cancelled || skillsStore.selectedSkill !== skill.name) return;
			const readme = findSkillReadme(skillsStore.skillTree ?? []);
			if (readme) await skillsStore.selectFile(readme.path);
		});
		return () => {
			cancelled = true;
		};
	}, [skill.name]);

	const arboristData = useMemo(() => {
		if (!state.skillTree) return [];
		return toArboristNodes(state.skillTree);
	}, [state.skillTree]);

	return (
		<div className={`relative grid h-full min-h-0 gap-3 transition-[grid-template-columns] duration-200 max-md:grid-cols-[minmax(0,1fr)] ${sidebarOpen ? "grid-cols-[240px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}>
			{/* File tree sidebar — absolute overlay on phones */}
			<aside className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] transition-opacity duration-200 max-md:absolute max-md:inset-3 max-md:z-20 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0 max-md:hidden"}`}>
				{/* Skill header */}
				<div className="flex items-center gap-2 border-b border-[var(--inno-border)] px-2 py-2">
					<button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={onBack}>
						<ChevronLeft size={16} />
					</button>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="truncate text-sm font-medium text-[var(--inno-text)]">{skill.name}</span>
							<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${skill.enabled ? "bg-[var(--inno-success-bg)] text-[var(--inno-success)]" : "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]"}`}>
								{skill.enabled ? t("common.enabled", "Enabled") : t("common.disabled", "Disabled")}
							</span>
						</div>
					</div>
				</div>

				{/* Toolbar */}
				<div className="flex items-center gap-1 border-b border-[var(--inno-border)] px-2 py-1.5">
					<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
						<input type="checkbox" className={checkboxCls} checked={skill.enabled} onChange={(e) => void skillsStore.setEnabled(skill.name, e.target.checked)} />
						{t("common.enable", "Enable")}
					</label>
					<div className="flex-1" />
					<button className="flex h-6 w-6 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" title={t("preview.refresh", "Refresh")} onClick={() => void skillsStore.refreshTree()}>
						<RefreshCw size={12} />
					</button>
					<button className="flex h-6 w-6 items-center justify-center rounded text-[var(--inno-danger)] hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)]" title={t("common.delete", "Delete")} onClick={() => { void skillsStore.remove(skill.name); onBack(); }}>
						<Trash2 size={12} />
					</button>
				</div>

				{/* File tree */}
				<div ref={treeContainerRef} className="min-h-0 flex-1 overflow-hidden">
					{state.isLoadingTree && !arboristData.length ? (
						<div className="flex items-center justify-center py-8 text-[var(--inno-text-muted)]">
							<Spinner size={16} className="mr-2" />
						</div>
					) : !arboristData.length ? (
						<div className="p-3 text-xs text-[var(--inno-text-muted)]">{t("preview.empty", "Empty")}</div>
					) : (
						<Tree<ArboristNode>
							data={arboristData}
							width={treeWidth}
							height={treeHeight}
							dndManager={dndManager}
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
			<section className="flex min-w-0 min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)]">
				<SkillFilePane skillName={skill.name} onToggleSidebar={() => setSidebarOpen((v) => !v)} sidebarOpen={sidebarOpen} />
			</section>
		</div>
	);
}

/* ---------- Skill cards ---------- */

// Category tiles cycle through the semantic token pairs so both themes work.
const TILE_TONES = [
	{ bg: "var(--inno-accent-soft)", fg: "var(--inno-accent)" },
	{ bg: "var(--inno-success-bg)", fg: "var(--inno-success)" },
	{ bg: "var(--inno-warning-bg)", fg: "var(--inno-warning)" },
	{ bg: "var(--inno-danger-bg)", fg: "var(--inno-danger)" },
	{ bg: "var(--inno-chip-bg)", fg: "var(--inno-text-muted)" },
];

function tileToneFor(category: string): { bg: string; fg: string } {
	let hash = 0;
	for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) | 0;
	return TILE_TONES[Math.abs(hash) % TILE_TONES.length];
}

function SkillCard({ skill, category, onClick }: { skill: SkillInfo; category: string; onClick: () => void }) {
	const { t } = useTranslation();
	const tone = tileToneFor(category);
	return (
		<button
			className="flex items-center gap-3 rounded-[14px] border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-4 py-3.5 text-left transition-shadow hover:shadow-[var(--inno-shadow-soft)]"
			onClick={onClick}
		>
			<span
				className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]"
				style={{ background: tone.bg, color: tone.fg }}
			>
				<Puzzle size={19} strokeWidth={1.8} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13.5px] font-medium text-[var(--inno-text)]">{skill.name}</div>
				<div className="mt-0.5 truncate text-[11.5px] text-[var(--inno-text-subtle)]">
					{skill.description || t("skills.noDescription")} · {formatSize(skill.size)}
				</div>
			</div>
			<span
				className={`h-2 w-2 shrink-0 rounded-full ${skill.enabled ? "bg-[var(--inno-success)]" : "bg-[var(--inno-border-strong)]"}`}
				title={skill.enabled ? t("common.enabled", "Enabled") : t("common.disabled", "Disabled")}
			/>
		</button>
	);
}

/* ---------- Main SkillsPanel ---------- */

type SkillsTab = "mine" | "library";

export function SkillsPanel({ dndManager }: { dndManager: DragDropManager }) {
	const { t } = useTranslation();
	const uploadRef = useRef<HTMLInputElement | null>(null);
	const state = useStoreSnapshot(skillsStore, () => ({
		skills: skillsStore.skills,
		selectedSkill: skillsStore.selectedSkill,
		isLoading: skillsStore.isLoading,
		isUploading: skillsStore.isUploading,
		error: skillsStore.error,
		library: skillsStore.library,
		isLoadingLibrary: skillsStore.isLoadingLibrary,
		libraryError: skillsStore.libraryError,
		importing: skillsStore.importing,
		notice: skillsStore.notice,
	}));
	const [tab, setTab] = useState<SkillsTab>("mine");
	const [query, setQuery] = useState("");
	const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

	useEffect(() => {
		void skillsStore.load();
	}, []);

	useEffect(() => {
		if (tab === "library") void skillsStore.loadLibrary();
	}, [tab]);

	function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		if (!file) return;
		void skillsStore.upload(file);
		event.target.value = "";
	}

	const activeSkill = state.selectedSkill ? state.skills.find((s) => s.name === state.selectedSkill) : null;

	const uncategorizedLabel = t("skills.uncategorized");
	// "mine" lists every installed skill (cards carry their own enable toggle);
	// the former "all" tab was the same list and has been merged into it.
	const sourceItems = useMemo<(SkillInfo | SkillLibraryItem)[]>(() => {
		if (tab === "library") return state.library;
		return state.skills;
	}, [tab, state.skills, state.library]);

	const groups = useMemo(
		() => groupByCategory(
			sourceItems.filter((s) => matchesQuery(s, query, s.category ? t(`categories.${s.category}`, s.category) : undefined)),
			uncategorizedLabel,
		),
		[sourceItems, query, uncategorizedLabel, t],
	);
	const visibleGroups = useMemo(
		() => (categoryFilter ? groups.filter(([cat]) => cat === categoryFilter) : groups),
		[groups, categoryFilter],
	);
	const totalMatched = useMemo(() => groups.reduce((sum, [, items]) => sum + items.length, 0), [groups]);

	// Reset the category filter when switching tabs (categories differ per source).
	function switchTab(next: SkillsTab) {
		setTab(next);
		setCategoryFilter(null);
	}

	// Detail view — file browser
	if (activeSkill) {
		return (
			<div className="mx-auto flex h-full w-full max-w-[1160px] flex-col p-5">
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<SkillDetail skill={activeSkill} onBack={() => skillsStore.deselectSkill()} dndManager={dndManager} />
				</div>
			</div>
		);
	}

	const isLibraryTab = tab === "library";
	const isEmptySource = isLibraryTab ? state.library.length === 0 : state.skills.length === 0;

	return (
		<div className="skills-panel-scroll h-full overflow-y-scroll">
			<div className="mx-auto flex w-full max-w-[1160px] flex-col px-5 pb-10 pt-2">
				{/* Tabs + search + actions */}
				<div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<div className="flex gap-6">
						{(["mine", "library"] as SkillsTab[]).map((key) => (
							<button
								key={key}
								className={`border-b-[2.5px] py-2.5 text-[15px] ${
									tab === key
										? "border-[var(--inno-text)] font-medium text-[var(--inno-text)]"
										: "border-transparent text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
								}`}
								onClick={() => switchTab(key)}
							>
								{t(`skills.tabs.${key}`)}
							</button>
						))}
					</div>
					<div className="flex items-center gap-2">
						<div className="flex w-[220px] items-center gap-2 rounded-[18px] border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-3.5 py-[7px] max-md:w-full">
							<Search size={15} className="shrink-0 text-[var(--inno-text-subtle)]" />
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("skills.searchPlaceholder")}
								className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] focus:outline-none"
							/>
							{query ? (
								<button
									className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
									onClick={() => setQuery("")}
									title={t("common.clear", "Clear")}
								>
									<X size={12} />
								</button>
							) : null}
						</div>
						<button
							className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							title={isLibraryTab ? t("skills.reload") : t("preview.refresh", "Refresh")}
							onClick={() => void (isLibraryTab ? skillsStore.loadLibrary(true) : skillsStore.reload())}
						>
							<RefreshCw size={15} />
						</button>
						<input ref={uploadRef} type="file" className="hidden" accept=".zip,application/zip,.md,text/markdown,text/plain" onChange={handleUpload} />
						<button
							className="flex h-8 items-center gap-1.5 rounded-[10px] inno-primary-button px-3.5 text-[13px] text-white disabled:opacity-50"
							disabled={state.isUploading}
							title={state.isUploading ? t("skills.uploading") : t("skills.upload")}
							onClick={() => uploadRef.current?.click()}
						>
							<Upload size={14} />
							{state.isUploading ? t("skills.uploading") : t("skills.upload")}
						</button>
					</div>
				</div>

				{/* Category filter row (real categories only — no invented metadata) */}
				{groups.length > 1 || categoryFilter ? (
					<div className="mb-4 flex flex-wrap items-baseline gap-1 py-1.5">
						<span className="mr-2 min-w-[46px] shrink-0 text-[13px] text-[var(--inno-text-subtle)]">{t("skills.filterCategory")}</span>
						<button
							className={`whitespace-nowrap rounded-lg px-2.5 py-[3px] text-[13px] ${
								categoryFilter === null
									? "bg-[var(--inno-accent-soft)] font-medium text-[var(--inno-accent)]"
									: "text-[var(--inno-text-muted)] hover:text-[var(--inno-accent)]"
							}`}
							onClick={() => setCategoryFilter(null)}
						>
							{t("skills.filterAll")}
						</button>
						{groups.map(([cat]) => (
							<button
								key={cat}
								className={`whitespace-nowrap rounded-lg px-2.5 py-[3px] text-[13px] ${
									categoryFilter === cat
										? "bg-[var(--inno-accent-soft)] font-medium text-[var(--inno-accent)]"
										: "text-[var(--inno-text-muted)] hover:text-[var(--inno-accent)]"
								}`}
								onClick={() => setCategoryFilter(cat)}
							>
								{cat === uncategorizedLabel ? cat : t(`categories.${cat}`, cat)}
							</button>
						))}
					</div>
				) : null}

				{(isLibraryTab ? state.libraryError : state.error) ? (
					<div className="mb-3 rounded-lg bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]">
						{isLibraryTab ? state.libraryError : state.error}
					</div>
				) : null}

				{/* Body */}
				{(isLibraryTab ? state.isLoadingLibrary : state.isLoading) ? (
					<div className="flex items-center justify-center py-16 text-[var(--inno-text-muted)]">
						<Spinner size={16} className="mr-2" />
						{t("common.loading")}
					</div>
				) : isEmptySource ? (
					tab === "mine" ? (
						<div className="flex flex-col items-center py-24 text-center">
							<Puzzle size={44} strokeWidth={1.5} className="mb-3.5 text-[var(--inno-text-subtle)] opacity-60" />
							<div className="mb-1.5 text-[15px] font-semibold text-[var(--inno-text)]">{t("skills.mineEmpty")}</div>
							<div className="text-[12.5px] text-[var(--inno-text-subtle)]">{t("skills.mineEmptyDesc")}</div>
						</div>
					) : (
						<div className="flex flex-col items-center py-24 text-center">
							<Puzzle size={44} strokeWidth={1.5} className="mb-3.5 text-[var(--inno-text-subtle)] opacity-60" />
							<div className="mb-1.5 text-[15px] font-semibold text-[var(--inno-text)]">
								{isLibraryTab ? t("skills.libraryEmpty") : t("skills.empty")}
							</div>
							{!isLibraryTab ? <div className="max-w-sm text-[12.5px] text-[var(--inno-text-subtle)]">{t("skills.emptyDesc")}</div> : null}
						</div>
					)
				) : totalMatched === 0 ? (
					<div className="py-16 text-center text-sm text-[var(--inno-text-muted)]">{t("skills.noResults")}</div>
				) : (
					visibleGroups.map(([category, items]) => (
						<div key={category} className="mb-7">
							<div className="mb-3.5 mt-2 flex items-baseline gap-3">
								<span className="text-[15px] font-semibold text-[var(--inno-text)]">
									{category === uncategorizedLabel ? category : t(`categories.${category}`, category)}
								</span>
								<span className="text-[12.5px] text-[var(--inno-text-subtle)]">· {items.length}</span>
							</div>
							<div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
								{isLibraryTab
									? (items as SkillLibraryItem[]).map((item) => {
											const isImporting = state.importing.has(item.name);
											const tone = tileToneFor(category);
											return (
												<div
													key={item.name}
													className="flex items-center gap-3 rounded-[14px] border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-4 py-3.5"
												>
													<span
														className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]"
														style={{ background: tone.bg, color: tone.fg }}
													>
														<Puzzle size={19} strokeWidth={1.8} />
													</span>
													<div className="min-w-0 flex-1">
														<div className="truncate text-[13.5px] font-medium text-[var(--inno-text)]">{item.name}</div>
														{item.description ? (
															<div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--inno-text-subtle)]">{item.description}</div>
														) : null}
													</div>
													{item.installed ? (
														<span className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--inno-success-bg)] px-2 py-1 text-[11px] font-medium text-[var(--inno-success)]">
															<Check size={12} /> {t("skills.installed")}
														</span>
													) : (
														<button
															disabled={isImporting}
															className="flex h-7 shrink-0 items-center gap-1 rounded-md inno-primary-button px-2.5 text-xs text-white disabled:opacity-50"
															onClick={() => void skillsStore.importFromLibrary(item.name)}
														>
															<Download size={12} />
															{isImporting ? t("skills.importing") : t("skills.import")}
														</button>
													)}
												</div>
											);
										})
									: (items as SkillInfo[]).map((skill) => (
											<SkillCard key={skill.name} skill={skill} category={category} onClick={() => void skillsStore.selectSkill(skill.name)} />
										))}
							</div>
						</div>
					))
				)}
			</div>
			{state.notice ? (
				<div
					role="status"
					className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-4 py-2.5 text-[13px] text-[var(--inno-text)] shadow-lg"
				>
					<Check size={14} className="shrink-0 text-[var(--inno-success)]" />
					{t("skills.importDone", { name: state.notice })}
				</div>
			) : null}
		</div>
	);
}
