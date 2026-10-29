import { EventEmitter } from "./event-emitter.js";
import {
	getWorkspaceFile,
	getWorkspaceTree,
	getWorkspaceActivity,
	createWorkspaceItem,
	renameWorkspaceItem,
	deleteWorkspaceItem,
	moveWorkspaceItem,
	uploadWorkspaceFiles,
	saveWorkspaceFile,
	uploadWorkspaceSkill,
	inlineWorkspaceHtml,
} from "../api/workspace.js";
import type { WorkspaceActivity, WorkspaceFileDetail, WorkspaceTree } from "../types/workspace.js";
import { DEFAULT_UPLOAD_MAX_BYTES, getOversizedFiles, UploadLimitError } from "../utils/upload-limits.js";

export interface StreamingWorkspacePreview {
	id: string;
	title: string;
	path?: string;
	language: string;
	content: string;
	status: "streaming" | "done" | "error";
	stage?: string;
	source: "assistant" | "tool";
	createdAt: number;
	updatedAt: number;
}

interface WorkspaceStoreEvents {
	change: void;
}

interface FilePreviewState {
	file: WorkspaceFileDetail | null;
	isLoading: boolean;
	isEditing: boolean;
	editBuffer: string;
	isSaving: boolean;
	error: string;
	requestId: number;
}

export interface WorkspacePreviewTab extends FilePreviewState {
	path: string;
	name: string;
	/** File ownership survives navigation; undefined denotes the default workspace. */
	workspaceId?: string | null;
}

export function previewTabKey(tab: Pick<WorkspacePreviewTab, "path" | "workspaceId">): string {
	if (isStartTabKey(tab.path)) return tab.path;
	return !tab.workspaceId ? tab.path : JSON.stringify([tab.workspaceId, tab.path]);
}

// Workspace file paths are relative; this absolute key cannot collide with one.
// It is also the prefix of every start-tab key: the tab strip's "+" mints a new
// key (`<prefix>#<n>`) per click so multiple start pages can coexist.
export const WORKSPACE_START_TAB = "/__inno_start__";
export const WORKSPACE_CONVERSATION_TAB = "/__inno_conversation__";

export function isStartTabKey(key: string | null | undefined): boolean {
	return typeof key === "string" && key.startsWith(WORKSPACE_START_TAB);
}

export function isStartTab(tab: Pick<WorkspacePreviewTab, "path">): boolean {
	return isStartTabKey(tab.path);
}
export interface RecentWorkspaceFile {
	workspaceId: string | null;
	path: string;
	name: string;
	openedAt: number;
}

const emptyFilePreview = (): FilePreviewState => ({ file: null, isLoading: false, isEditing: false, editBuffer: "", isSaving: false, error: "", requestId: 0 });
const RECENT_FILES_KEY = "inno.recentWorkspaceFiles";

function readRecentFiles(): RecentWorkspaceFile[] {
	try {
		const stored: unknown = typeof localStorage === "undefined" ? [] : JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || "[]");
		if (!Array.isArray(stored)) return [];
		return stored.filter((file): file is RecentWorkspaceFile => file && (file.workspaceId === null || typeof file.workspaceId === "string")
			&& typeof file.path === "string" && file.path.length > 0 && !file.path.startsWith("/") && !/^[A-Za-z]:/.test(file.path) && !file.path.split(/[\\/]/).includes("..")
			&& typeof file.name === "string" && typeof file.openedAt === "number" && Number.isFinite(file.openedAt)).slice(0, 40);
	} catch { return []; }
}

export class WorkspaceStoreImpl extends EventEmitter<WorkspaceStoreEvents> {
	tree: WorkspaceTree | null = null;
	previewTabs: WorkspacePreviewTab[] = [];
	/** Persist only bounded open-history metadata; drafts remain owned by tabs. */
	recentFiles: RecentWorkspaceFile[] = readRecentFiles();
	activity: WorkspaceActivity = { files: [], trackingIncomplete: false };
	activityError = "";
	/** Opaque tab key (workspace + relative path), not a filesystem path. */
	activePreviewPath: string | null = null;
	/** Fullscreen surface selection; file tabs continue owning their drafts. */
	activeSurface: "conversation" | "preview" = "preview";
	setActiveSurface(surface: "conversation" | "preview"): void {
		if (this.activeSurface === surface) return;
		this.activeSurface = surface;
		this.emit("change", undefined);
	}
	private emptyPreview = emptyFilePreview();
	private get previewState(): FilePreviewState {
		return this.previewTabs.find((tab) => previewTabKey(tab) === this.activePreviewPath) ?? this.emptyPreview;
	}
	get currentFileWorkspaceId(): string | null {
		return this.previewTabs.find((tab) => previewTabKey(tab) === this.activePreviewPath)?.workspaceId ?? null;
	}
	// Keep the existing preview/editor API, with each tab owning its own draft.
	get currentFile() { return this.previewState.file; }
	set currentFile(file: WorkspaceFileDetail | null) { this.previewState.file = file; }
	get isLoadingFile() { return this.previewState.isLoading; }
	set isLoadingFile(value: boolean) { this.previewState.isLoading = value; }
	get isEditing() { return this.previewState.isEditing; }
	set isEditing(value: boolean) { this.previewState.isEditing = value; }
	get editBuffer() { return this.previewState.editBuffer; }
	set editBuffer(value: string) { this.previewState.editBuffer = value; }
	get isSaving() { return this.previewState.isSaving; }
	set isSaving(value: boolean) { this.previewState.isSaving = value; }
	get previewError() { return this.previewState.error; }
	isLoadingTree = false;
	isMutating = false;
	error = "";
	streamingPreview: StreamingWorkspacePreview | null = null;
	/**
	 * Installed by the DOCX editor host while a BetterOffice session may hold
	 * unsaved work for its tab. Returning true vetoes the close; the host owns
	 * the confirmation UI and completes (or abandons) the close itself.
	 */
	wordEditCloseGuard: ((tabKey: string) => boolean) | null = null;

	/** The workspace currently shown in the panel. null → server default. */
	activeWorkspaceId: string | null = null;

	private treeRequestId = 0;
	private fileRequestId = 0;
	private activityRequestId = 0;
	private startTabSeq = 0;

	private notifyPreview(): void {
		this.previewTabs = [...this.previewTabs];
		this.emit("change", undefined);
	}

	openStartPage(): void {
		const startTabs = this.previewTabs.filter(isStartTab);
		if (startTabs.length) {
			// Panel-open entries reuse the most recent start page; duplicates come
			// only from the tab strip's "+" via newStartPage().
			this.activatePreview(previewTabKey(startTabs[startTabs.length - 1]));
			return;
		}
		this.newStartPage();
	}

	/** Mint a fresh start-page tab; the "+" button allows repeated start tabs. */
	newStartPage(): void {
		const key = `${WORKSPACE_START_TAB}#${++this.startTabSeq}`;
		this.previewTabs = [...this.previewTabs, { ...emptyFilePreview(), path: key, name: "" }];
		this.activatePreview(key);
	}

	private persistRecentFiles(): void {
		try { if (typeof localStorage !== "undefined") localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(this.recentFiles)); } catch { /* History is optional when storage is unavailable/full. */ }
	}

	private rememberFile(path: string, name: string, workspaceId: string | null): void {
		this.recentFiles = [{ workspaceId, path, name, openedAt: Date.now() },
			...this.recentFiles.filter((item) => item.workspaceId !== workspaceId || item.path !== path)].slice(0, 40);
		this.persistRecentFiles();
	}

	activatePreview(path: string): void {
		const tab = this.previewTabs.find((tab) => previewTabKey(tab) === path);
		if (!tab) return;
		this.activeSurface = "preview";
		this.activePreviewPath = path;
		this.streamingPreview = null;
		const file = tab.file;
		if (file) this.rememberFile(file.path, file.name, tab.workspaceId ?? null);
		this.notifyPreview();
	}

	closePreview(path: string): void {
		if (this.wordEditCloseGuard?.(path)) return;
		const index = this.previewTabs.findIndex((tab) => previewTabKey(tab) === path);
		if (index < 0) return;
		this.previewTabs = this.previewTabs.filter((tab) => previewTabKey(tab) !== path);
		if (this.activePreviewPath === path) {
			const next = this.previewTabs[Math.min(index, this.previewTabs.length - 1)];
			this.activePreviewPath = next ? previewTabKey(next) : null;
		}
		this.notifyPreview();
	}

	/** Close every tab except `path`; if the active tab was closed, fall back to `path`. */
	closeOtherPreviews(path: string): void {
		if (!this.previewTabs.some((tab) => previewTabKey(tab) === path)) return;
		// Guarded tabs survive the bulk close; only unvetoed tabs are removed.
		this.previewTabs = this.previewTabs.filter((tab) => previewTabKey(tab) === path || !!this.wordEditCloseGuard?.(previewTabKey(tab)));
		if (!this.previewTabs.some((tab) => previewTabKey(tab) === this.activePreviewPath)) this.activePreviewPath = path;
		this.notifyPreview();
	}

	/** Close all tabs after `path`; if the active tab was among them, fall back to `path`. */
	closePreviewsToRight(path: string): void {
		const index = this.previewTabs.findIndex((tab) => previewTabKey(tab) === path);
		if (index < 0 || index === this.previewTabs.length - 1) return;
		// Tabs up to `path` are never touched; later tabs close unless vetoed.
		this.previewTabs = this.previewTabs.filter((tab, position) => position <= index || !!this.wordEditCloseGuard?.(previewTabKey(tab)));
		if (!this.previewTabs.some((tab) => previewTabKey(tab) === this.activePreviewPath)) this.activePreviewPath = path;
		this.notifyPreview();
	}

	closeAllPreviews(): void {
		if (!this.previewTabs.length) return;
		this.previewTabs = this.previewTabs.filter((tab) => !!this.wordEditCloseGuard?.(previewTabKey(tab)));
		if (!this.previewTabs.some((tab) => previewTabKey(tab) === this.activePreviewPath)) {
			const next = this.previewTabs[this.previewTabs.length - 1];
			this.activePreviewPath = next ? previewTabKey(next) : null;
		}
		this.activeSurface = "preview";
		this.notifyPreview();
	}

	private relocatePreviews(oldPath: string, newPath: string, workspaceId: string | null): void {
		this.recentFiles = this.recentFiles.map((item) => {
			if (item.workspaceId !== workspaceId || (item.path !== oldPath && !item.path.startsWith(`${oldPath}/`))) return item;
			const path = newPath + item.path.slice(oldPath.length);
			return { ...item, path, name: path.split("/").pop() || path };
		});
		this.persistRecentFiles();
		for (const tab of this.previewTabs) {
			if ((tab.workspaceId ?? null) !== workspaceId) continue;
			if (tab.path !== oldPath && !tab.path.startsWith(`${oldPath}/`)) continue;
			const nextPath = newPath + tab.path.slice(oldPath.length);
			if (this.activePreviewPath === previewTabKey(tab)) this.activePreviewPath = previewTabKey({ ...tab, path: nextPath });
			tab.path = nextPath;
			tab.name = nextPath.split("/").pop() || nextPath;
			if (tab.file) tab.file = { ...tab.file, path: nextPath, name: tab.name };
			tab.requestId = ++this.fileRequestId;
			tab.isLoading = false;
		}
		this.notifyPreview();
	}

	/** Set the active workspace and reload the tree. */
	async setActiveWorkspace(workspaceId: string | null): Promise<void> {
		if (this.activeWorkspaceId === workspaceId) return;
		this.treeRequestId++;
		this.activityRequestId++;
		this.activeWorkspaceId = workspaceId;
		// Do not display the previous workspace's files on the start page while loading.
		this.tree = null;
		this.activity = { files: [], trackingIncomplete: false };
		this.activityError = "";
		this.emptyPreview = emptyFilePreview();
		this.streamingPreview = null;
		this.isLoadingTree = false;
		// Navigation changes the file tree, not tab ownership or local edits.
		this.emit("change", undefined);
		await this.loadTree();
	}

	private get wsId(): string | undefined {
		return this.activeWorkspaceId ?? undefined;
	}

	async loadActivity(): Promise<void> {
		const requestId = ++this.activityRequestId;
		const workspaceId = this.wsId;
		this.activityError = "";
		try {
			const activity = await getWorkspaceActivity(workspaceId);
			if (requestId === this.activityRequestId && workspaceId === this.wsId) this.activity = activity;
		} catch {
			if (requestId === this.activityRequestId) this.activityError = "activity";
		} finally {
			if (requestId === this.activityRequestId) this.emit("change", undefined);
		}
	}

	async loadTree(isCurrent: () => boolean = () => true): Promise<void> {
		const requestId = ++this.treeRequestId;
		const workspaceId = this.wsId;
		this.isLoadingTree = true;
		this.error = "";
		this.emit("change", undefined);
		try {
			const tree = await getWorkspaceTree(workspaceId);
			if (requestId !== this.treeRequestId || workspaceId !== this.wsId || !isCurrent()) return;
			this.tree = tree;
			// Loading file management must not implicitly open the first file.
		} catch (err) {
			if (requestId !== this.treeRequestId || workspaceId !== this.wsId || !isCurrent()) return;
			this.error = err instanceof Error ? err.message : "Failed to load workspace";
			this.tree = null;
		} finally {
			if (requestId === this.treeRequestId && workspaceId === this.wsId && isCurrent()) {
				this.isLoadingTree = false;
				this.emit("change", undefined);
			}
		}
	}

	async selectFile(path: string, isCurrent: () => boolean = () => true, ownerWorkspaceId: string | null = this.activeWorkspaceId, options?: { replaceStartTab?: boolean }): Promise<void> {
		if (!isCurrent()) return;
		if (isStartTabKey(path)) { this.openStartPage(); return; }
		this.activeSurface = "preview";
		const workspaceId = ownerWorkspaceId ?? undefined;
		const key = previewTabKey({ path, workspaceId });
		let tab: WorkspacePreviewTab | undefined;
		if (options?.replaceStartTab) {
			// Opening a file from a start page navigates that tab in place
			// (browser-style). If the file already has a tab, switch to it and
			// retire the start page: tab keys are unique per file+workspace, so
			// duplicate file tabs are not representable.
			const startTab = this.previewTabs.find((item) => isStartTab(item) && previewTabKey(item) === this.activePreviewPath);
			if (startTab) {
				const existing = this.previewTabs.find((item) => previewTabKey(item) === key);
				if (existing) {
					this.previewTabs = this.previewTabs.filter((item) => item !== startTab);
					tab = existing;
				} else {
					startTab.path = path;
					startTab.name = path.split("/").pop() || path;
					startTab.workspaceId = ownerWorkspaceId;
					tab = startTab;
				}
			}
		}
		if (!tab) tab = this.previewTabs.find((item) => previewTabKey(item) === key);
		if (!tab) {
			tab = { ...emptyFilePreview(), path, workspaceId: ownerWorkspaceId, name: path.split("/").pop() || path };
			this.previewTabs = [...this.previewTabs, tab];
		}
		this.activePreviewPath = key;
		this.streamingPreview = null;
		this.error = "";
		// File-open events also follow agent writes: an existing tab is not proof
		// its cached content is current. Revalidate previews, but retain local edits.
		if (tab.isEditing || tab.isSaving) { this.rememberFile(tab.path, tab.name, ownerWorkspaceId); this.notifyPreview(); return; }
		const target = tab;
		const requestId = ++this.fileRequestId;
		target.requestId = requestId;
		target.isLoading = true;
		target.error = "";
		const valid = () => this.previewTabs.includes(target) && target.requestId === requestId && isCurrent();
		this.notifyPreview();
		try {
			const file = await getWorkspaceFile(path, workspaceId);
			if (!valid()) return;
			if (file && file.kind === "html" && file.content) {
				file.content = await inlineWorkspaceHtml(file.content, file.path, workspaceId);
				if (!valid()) return;
			}
			target.file = file;
			if (file) this.rememberFile(file.path, file.name, ownerWorkspaceId);
		} catch (err) {
			if (!valid()) return;
			target.error = err instanceof Error ? err.message : "Failed to load file";
		} finally {
			if (this.previewTabs.includes(target) && target.requestId === requestId) {
				target.isLoading = false;
				this.notifyPreview();
			}
		}
	}

	startStreamingPreview(input: {
		id: string;
		title: string;
		path?: string;
		language?: string;
		content?: string;
		stage?: string;
		source?: StreamingWorkspacePreview["source"];
	}): void {
		const now = Date.now();
		this.activeSurface = "preview";
		this.streamingPreview = {
			id: input.id,
			title: input.title,
			path: input.path,
			language: input.language ?? languageFromPath(input.path ?? input.title),
			content: input.content ?? "",
			status: "streaming",
			stage: input.stage,
			source: input.source ?? "assistant",
			createdAt: now,
			updatedAt: now,
		};
		this.emit("change", undefined);
	}

	updateStreamingPreview(id: string, patch: Partial<Pick<StreamingWorkspacePreview, "title" | "path" | "language" | "content" | "status" | "stage">>): void {
		if (!this.streamingPreview || this.streamingPreview.id !== id) return;
		const keys = ["title", "path", "language", "content", "status", "stage"] as const;
		if (!keys.some((key) => key in patch && patch[key] !== this.streamingPreview?.[key])) return;
		this.streamingPreview = {
			...this.streamingPreview,
			...patch,
			updatedAt: Date.now(),
		};
		this.emit("change", undefined);
	}

	finishStreamingPreview(id: string, status: "done" | "error" = "done"): void {
		if (!this.streamingPreview || this.streamingPreview.id !== id) return;
		if (this.streamingPreview.status === status) return;
		this.streamingPreview = {
			...this.streamingPreview,
			status,
			updatedAt: Date.now(),
		};
		this.emit("change", undefined);
	}

	clearStreamingPreview(id?: string): void {
		if (id && this.streamingPreview?.id !== id) return;
		this.streamingPreview = null;
		this.emit("change", undefined);
	}

	/* --- Edit lifecycle --- */

	/** Re-fetch the current file forcing text mode (for binary files the user wants to edit). */
	async openAsText(): Promise<void> {
		const target = this.previewState;
		if (!target.file) return;
		const path = target.file.path;
		const workspaceId = this.currentFileWorkspaceId ?? undefined;
		const requestId = target.requestId = ++this.fileRequestId;
		target.isLoading = true;
		target.error = "";
		this.notifyPreview();
		try {
			const file = await getWorkspaceFile(path, workspaceId, true);
			if (target.requestId === requestId && this.previewTabs.includes(target as WorkspacePreviewTab)) target.file = file;
		} catch (err) {
			if (target.requestId === requestId) target.error = err instanceof Error ? err.message : "Failed to load file as text";
		} finally {
			if (target.requestId === requestId) target.isLoading = false;
			this.notifyPreview();
		}
	}

	startEditing(): void {
		if (!this.currentFile || this.currentFile.content == null) return;
		this.isEditing = true;
		this.editBuffer = this.currentFile.content;
		this.notifyPreview();
	}

	updateEditBuffer(value: string): void {
		this.editBuffer = value;
		this.notifyPreview();
	}

	cancelEditing(): void {
		this.isEditing = false;
		this.editBuffer = "";
		this.notifyPreview();
	}

	async saveFile(): Promise<void> {
		const target = this.previewState;
		if (!target.file || target.isSaving) return;
		const path = target.file.path;
		const workspaceId = this.currentFileWorkspaceId ?? undefined;
		const content = target.editBuffer;
		const requestId = target.requestId;
		// Rename/move invalidates the tab's request generation. An old save's
		// readback must not restore its old path or discard the relocated draft.
		const valid = () => this.previewTabs.some((tab) => tab === target)
			&& target.requestId === requestId;
		target.isSaving = true;
		target.error = "";
		this.notifyPreview();
		try {
			// Capture the owning tab before awaiting: switching tabs during save
			// must never write the response or clear the draft of another file.
			await saveWorkspaceFile(path, content, workspaceId);
			if (!valid()) return;
			const file = await getWorkspaceFile(path, workspaceId);
			if (!valid()) return;
			target.file = file;
			if (target.editBuffer === content) { target.isEditing = false; target.editBuffer = ""; }
		} catch (err) {
			if (valid()) target.error = err instanceof Error ? err.message : "Failed to save file";
		} finally {
			target.isSaving = false;
			this.notifyPreview();
		}
	}

	/* --- File operations --- */

	async createItem(parentPath: string, name: string, type: "file" | "directory"): Promise<void> {
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			const itemPath = parentPath ? `${parentPath}/${name}` : name;
			await createWorkspaceItem(itemPath, type, this.wsId);
			await this.loadTree();
			if (type === "file") await this.selectFile(itemPath);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to create item";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

    private guardFileMutation(path: string, workspaceId: string | null): boolean {
        // Relocating a tab changes its key and unmounts its Office engine.
        // Ask the draft owner before the filesystem mutation, while both the
        // original file and the mounted engine still exist.
        return this.previewTabs.some((tab) => (tab.workspaceId ?? null) === workspaceId
            && (tab.path === path || tab.path.startsWith(`${path}/`))
            && !!this.wordEditCloseGuard?.(previewTabKey(tab)));
    }

	async renameItem(oldPath: string, newName: string): Promise<void> {
		// Navigation may change while a mutation is pending; update only its owner.
		const workspaceId = this.activeWorkspaceId;
		if (this.guardFileMutation(oldPath, workspaceId)) return;
		const parts = oldPath.split("/");
		parts[parts.length - 1] = newName;
		const newPath = parts.join("/");
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await renameWorkspaceItem(oldPath, newPath, workspaceId ?? undefined);
			this.relocatePreviews(oldPath, newPath, workspaceId);
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to rename";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	async deleteItem(path: string): Promise<void> {
		const workspaceId = this.activeWorkspaceId;
		if (this.guardFileMutation(path, workspaceId)) return;
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await deleteWorkspaceItem(path, workspaceId ?? undefined);
			this.recentFiles = this.recentFiles.filter((item) => item.workspaceId !== workspaceId || (item.path !== path && !item.path.startsWith(`${path}/`)));
			this.persistRecentFiles();
			for (const tab of [...this.previewTabs]) {
				if ((tab.workspaceId ?? null) === workspaceId && (tab.path === path || tab.path.startsWith(`${path}/`))) this.closePreview(previewTabKey(tab));
			}
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to delete";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	async moveItem(sourcePath: string, targetDir: string): Promise<void> {
		const workspaceId = this.activeWorkspaceId;
		if (this.guardFileMutation(sourcePath, workspaceId)) return;
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await moveWorkspaceItem(sourcePath, targetDir, workspaceId ?? undefined);
			this.relocatePreviews(sourcePath, [targetDir, sourcePath.split("/").pop()].filter(Boolean).join("/"), workspaceId);
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to move";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	async uploadFiles(parentPath: string, fileList: FileList | File[]): Promise<void> {
		const files = Array.from(fileList);
		const oversized = getOversizedFiles(files);
		if (oversized.length > 0) {
			this.isMutating = false;
			this.error = new UploadLimitError(oversized[0].name).message;
			this.emit("change", undefined);
			return;
		}
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			const items: Array<{ path: string; dataBase64: string }> = [];
			for (const file of files) {
				const buffer = await file.arrayBuffer();
				const bytes = new Uint8Array(buffer);
				let binary = "";
				for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
				const base64 = btoa(binary);
				const filePath = parentPath ? `${parentPath}/${file.name}` : file.name;
				items.push({ path: filePath, dataBase64: base64 });
			}
			await uploadWorkspaceFiles(items, this.wsId);
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to upload";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	/** Install a skill package (.zip / .md) into the workspace's private `.skills` dir. */
	async uploadSkillPackage(file: File): Promise<void> {
		if (file.size > DEFAULT_UPLOAD_MAX_BYTES) {
			this.isMutating = false;
			this.error = new UploadLimitError(file.name).message;
			this.emit("change", undefined);
			return;
		}
		this.isMutating = true;
		this.error = "";
		this.emit("change", undefined);
		try {
			const dataBase64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = String(reader.result ?? "");
					resolve(result.includes(",") ? result.split(",")[1] : result);
				};
				reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
				reader.readAsDataURL(file);
			});
			await uploadWorkspaceSkill(file.name, dataBase64, this.wsId);
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to install skill";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

}

export const workspaceStore = new WorkspaceStoreImpl();

function languageFromPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
	if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
	if (lower.endsWith(".py")) return "python";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
	if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
	if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
	if (lower.endsWith(".sql")) return "sql";
	if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
	return "plaintext";
}
