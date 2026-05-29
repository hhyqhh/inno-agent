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
} from "../api/workspace.js";
import type { WorkspaceFileDetail, WorkspaceTree } from "../types/workspace.js";

interface WorkspaceStoreEvents {
	change: void;
}

class WorkspaceStoreImpl extends EventEmitter<WorkspaceStoreEvents> {
	tree: WorkspaceTree | null = null;
	currentFile: WorkspaceFileDetail | null = null;
	isLoadingTree = false;
	isLoadingFile = false;
	isMutating = false;
	error = "";

	/** The workspace currently shown in the panel. null → server default. */
	activeWorkspaceId: string | null = null;

	/* --- Editing state --- */
	isEditing = false;
	editBuffer = "";
	isSaving = false;

	/** Set the active workspace and reload the tree. */
	async setActiveWorkspace(workspaceId: string | null): Promise<void> {
		if (this.activeWorkspaceId === workspaceId) return;
		this.activeWorkspaceId = workspaceId;
		this.currentFile = null;
		this.isEditing = false;
		this.editBuffer = "";
		this.emit("change", undefined);
		await this.loadTree();
	}

	private get wsId(): string | undefined {
		return this.activeWorkspaceId ?? undefined;
	}

	async loadTree(): Promise<void> {
		this.isLoadingTree = true;
		this.error = "";
		this.emit("change", undefined);
		try {
			this.tree = await getWorkspaceTree(this.wsId);
			if (!this.currentFile) {
				const first = this.findFirstPreviewable(this.tree.children);
				if (first) await this.selectFile(first.path);
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to load workspace";
			this.tree = null;
		} finally {
			this.isLoadingTree = false;
			this.emit("change", undefined);
		}
	}

	async selectFile(path: string): Promise<void> {
		// Discard any in-progress edit when switching files
		if (this.isEditing) {
			this.isEditing = false;
			this.editBuffer = "";
		}
		this.isLoadingFile = true;
		this.error = "";
		this.emit("change", undefined);
		try {
			this.currentFile = await getWorkspaceFile(path, this.wsId);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to load file";
			this.currentFile = null;
		} finally {
			this.isLoadingFile = false;
			this.emit("change", undefined);
		}
	}

	/* --- Edit lifecycle --- */

	startEditing(): void {
		if (!this.currentFile || this.currentFile.content == null) return;
		this.isEditing = true;
		this.editBuffer = this.currentFile.content;
		this.emit("change", undefined);
	}

	updateEditBuffer(value: string): void {
		this.editBuffer = value;
		this.emit("change", undefined);
	}

	cancelEditing(): void {
		this.isEditing = false;
		this.editBuffer = "";
		this.emit("change", undefined);
	}

	async saveFile(): Promise<void> {
		if (!this.currentFile) return;
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			await saveWorkspaceFile(this.currentFile.path, this.editBuffer, this.wsId);
			// Refresh the file to get updated metadata
			this.currentFile = await getWorkspaceFile(this.currentFile.path, this.wsId);
			this.isEditing = false;
			this.editBuffer = "";
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save file";
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
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
			await this.loadTree();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to move";
		} finally {
			this.isMutating = false;
			this.emit("change", undefined);
		}
	}

	async uploadFiles(parentPath: string, fileList: FileList | File[]): Promise<void> {
		this.isMutating = true;
		this.emit("change", undefined);
		try {
			const items: Array<{ path: string; dataBase64: string }> = [];
			for (const file of Array.from(fileList)) {
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

	private findFirstPreviewable(nodes: WorkspaceTree["children"]): { path: string } | null {
		for (const node of nodes) {
			if (node.type === "file") return node;
			const child = node.children ? this.findFirstPreviewable(node.children) : null;
			if (child) return child;
		}
		return null;
	}
}

export const workspaceStore = new WorkspaceStoreImpl();
