import { EventEmitter } from "./event-emitter.js";
import {
	getWorkspaceFile,
	getWorkspaceTree,
	createWorkspaceItem,
	renameWorkspaceItem,
	deleteWorkspaceItem,
	moveWorkspaceItem,
	uploadWorkspaceFiles,
	saveWorkspaceFile,
	uploadWorkspaceSkill,
	inlineWorkspaceHtml,
} from "../api/workspace.js";
import type { WorkspaceFileDetail, WorkspaceTree } from "../types/workspace.js";
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
}

const emptyFilePreview = (): FilePreviewState => ({ file: null, isLoading: false, isEditing: false, editBuffer: "", isSaving: false, error: "", requestId: 0 });

export class WorkspaceStoreImpl extends EventEmitter<WorkspaceStoreEvents> {
	tree: WorkspaceTree | null = null;
	previewTabs: WorkspacePreviewTab[] = [];
	activePreviewPath: string | null = null;
	private emptyPreview = emptyFilePreview();
	private get previewState(): FilePreviewState {
		return this.previewTabs.find((tab) => tab.path === this.activePreviewPath) ?? this.emptyPreview;
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

	/** The workspace currently shown in the panel. null → server default. */
	activeWorkspaceId: string | null = null;

	private treeRequestId = 0;
	private fileRequestId = 0;

	private notifyPreview(): void {
		this.previewTabs = [...this.previewTabs];
		this.emit("change", undefined);
	}

	activatePreview(path: string): void {
		if (!this.previewTabs.some((tab) => tab.path === path)) return;
		this.activePreviewPath = path;
		this.streamingPreview = null;
		this.notifyPreview();
	}

	closePreview(path: string): void {
		const index = this.previewTabs.findIndex((tab) => tab.path === path);
		if (index < 0) return;
		this.previewTabs = this.previewTabs.filter((tab) => tab.path !== path);
		if (this.activePreviewPath === path) {
			this.activePreviewPath = this.previewTabs[Math.min(index, this.previewTabs.length - 1)]?.path ?? null;
		}
		this.notifyPreview();
	}

	private relocatePreviews(oldPath: string, newPath: string): void {
		for (const tab of this.previewTabs) {
			if (tab.path !== oldPath && !tab.path.startsWith(`${oldPath}/`)) continue;
			const nextPath = newPath + tab.path.slice(oldPath.length);
			if (this.activePreviewPath === tab.path) this.activePreviewPath = nextPath;
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
		this.fileRequestId++;
		this.activeWorkspaceId = workspaceId;
		this.previewTabs = [];
		this.activePreviewPath = null;
		this.emptyPreview = emptyFilePreview();
		this.streamingPreview = null;
		this.isLoadingTree = false;
		this.isLoadingFile = false;
		this.isEditing = false;
		this.editBuffer = "";
		this.emit("change", undefined);
		await this.loadTree();
	}

	private get wsId(): string | undefined {
		return this.activeWorkspaceId ?? undefined;
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

	async selectFile(path: string, isCurrent: () => boolean = () => true): Promise<void> {
		if (!isCurrent()) return;
		const workspaceId = this.wsId;
		let tab = this.previewTabs.find((item) => item.path === path);
		if (!tab) {
			tab = { ...emptyFilePreview(), path, name: path.split("/").pop() || path };
			this.previewTabs = [...this.previewTabs, tab];
		}
		this.activePreviewPath = path;
		this.streamingPreview = null;
		this.error = "";
		if (tab.file || tab.isLoading) { this.notifyPreview(); return; }
		const target = tab;
		const requestId = ++this.fileRequestId;
		target.requestId = requestId;
		target.isLoading = true;
		target.error = "";
		const valid = () => this.previewTabs.includes(target) && target.requestId === requestId && workspaceId === this.wsId && isCurrent();
		this.notifyPreview();
		try {
			const file = await getWorkspaceFile(path, workspaceId);
			if (!valid()) return;
			if (file && file.kind === "html" && file.content) {
				file.content = await inlineWorkspaceHtml(file.content, file.path, workspaceId);
				if (!valid()) return;
			}
			target.file = file;
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
		const workspaceId = this.wsId;
		const requestId = target.requestId = ++this.fileRequestId;
		target.isLoading = true;
		target.error = "";
		this.notifyPreview();
		try {
			const file = await getWorkspaceFile(path, workspaceId, true);
			if (target.requestId === requestId && workspaceId === this.wsId) target.file = file;
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
		const workspaceId = this.wsId;
		const content = target.editBuffer;
		target.isSaving = true;
		target.error = "";
		this.notifyPreview();
		try {
			// Capture the owning tab before awaiting: switching tabs during save
			// must never write the response or clear the draft of another file.
			await saveWorkspaceFile(path, content, workspaceId);
			target.file = await getWorkspaceFile(path, workspaceId);
			if (target.editBuffer === content) { target.isEditing = false; target.editBuffer = ""; }
		} catch (err) {
			target.error = err instanceof Error ? err.message : "Failed to save file";
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

	async renameItem(oldPath: string, newName: string): Promise<void> {
		const parts = oldPath.split("/");
		parts[parts.length - 1] = newName;
		const newPath = parts.join("/");
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await renameWorkspaceItem(oldPath, newPath, this.wsId);
			this.relocatePreviews(oldPath, newPath);
			await this.loadTree();
			if (this.currentFile?.path === oldPath) {
				await this.selectFile(newPath);
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to rename";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	async deleteItem(path: string): Promise<void> {
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await deleteWorkspaceItem(path, this.wsId);
			for (const tab of [...this.previewTabs]) {
				if (tab.path === path || tab.path.startsWith(`${path}/`)) this.closePreview(tab.path);
			}
			if (this.currentFile?.path === path || this.currentFile?.path.startsWith(path + "/")) {
				this.currentFile = null;
				this.isEditing = false;
				this.editBuffer = "";
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
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			await moveWorkspaceItem(sourcePath, targetDir, this.wsId);
			this.relocatePreviews(sourcePath, [targetDir, sourcePath.split("/").pop()].filter(Boolean).join("/"));
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
