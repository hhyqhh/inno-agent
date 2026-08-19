import { EventEmitter } from "./event-emitter.js";
import { deleteSkill, listSkills, reloadSkills, inlineSkillHtml, updateSkill, uploadSkill, getSkillTree, getSkillFile, saveSkillFile, listSkillLibrary, importSkillFromLibrary } from "../api/skills.js";
import type { SkillInfo, SkillLibraryItem } from "../types/skills.js";
import type { WorkspaceTreeNode, WorkspaceFileDetail } from "../types/workspace.js";

interface SkillsStoreEvents {
	change: void;
}

export class SkillsStoreImpl extends EventEmitter<SkillsStoreEvents> {
	skills: SkillInfo[] = [];
	isLoading = false;
	isUploading = false;
	error: string | null = null;

	// Detail / file browsing state
	selectedSkill: string | null = null;
	skillTree: WorkspaceTreeNode[] | null = null;
	isLoadingTree = false;
	currentFile: WorkspaceFileDetail | null = null;
	isLoadingFile = false;
	isEditing = false;
	editBuffer = "";
	isSaving = false;

	// Remote skill library state
	libraryOpen = false;
	library: SkillLibraryItem[] = [];
	isLoadingLibrary = false;
	libraryError: string | null = null;
	/** Names currently being imported (for per-row spinners). */
	importing = new Set<string>();
	private treeRequestId = 0;
	private fileRequestId = 0;

	async load() {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.skills = await listSkills();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to load skills";
			this.skills = [];
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async upload(file: File) {
		this.isUploading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const skill = await uploadSkill(file);
			this.skills = [skill, ...this.skills.filter((item) => item.name !== skill.name)].sort((a, b) => a.name.localeCompare(b.name));
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to upload skill";
		} finally {
			this.isUploading = false;
			this.emit("change", undefined);
		}
	}

	async setEnabled(name: string, enabled: boolean) {
		const skill = await updateSkill(name, enabled);
		this.skills = this.skills.map((item) => (item.name === name ? skill : item));
		this.emit("change", undefined);
	}

	async remove(name: string) {
		await deleteSkill(name);
		this.skills = this.skills.filter((item) => item.name !== name);
		if (this.selectedSkill === name) {
			this.treeRequestId++;
			this.fileRequestId++;
			this.selectedSkill = null;
			this.skillTree = null;
			this.currentFile = null;
			this.isLoadingTree = false;
			this.isLoadingFile = false;
			this.isEditing = false;
		}
		this.emit("change", undefined);
	}

	async reload() {
		const result = await reloadSkills();
		this.skills = result.skills;
		this.emit("change", undefined);
	}

	/* --- Remote skill library --- */

	openLibrary() {
		this.libraryOpen = true;
		this.emit("change", undefined);
		void this.loadLibrary();
	}

	closeLibrary() {
		this.libraryOpen = false;
		this.emit("change", undefined);
	}

	async loadLibrary(forceRefresh = false) {
		this.isLoadingLibrary = true;
		this.libraryError = null;
		this.emit("change", undefined);
		try {
			this.library = await listSkillLibrary(forceRefresh);
		} catch (err) {
			this.libraryError = err instanceof Error ? err.message : "Failed to load skill library";
			this.library = [];
		} finally {
			this.isLoadingLibrary = false;
			this.emit("change", undefined);
		}
	}

	async importFromLibrary(name: string) {
		if (this.importing.has(name)) return;
		this.importing.add(name);
		this.libraryError = null;
		this.emit("change", undefined);
		try {
			const skill = await importSkillFromLibrary(name);
			this.skills = [skill, ...this.skills.filter((item) => item.name !== skill.name)].sort((a, b) => a.name.localeCompare(b.name));
			this.library = this.library.map((item) => (item.name === name ? { ...item, installed: true } : item));
		} catch (err) {
			this.libraryError = err instanceof Error ? err.message : "Failed to import skill";
		} finally {
			this.importing.delete(name);
			this.emit("change", undefined);
		}
	}

	/* --- File browsing --- */

	async selectSkill(name: string) {
		const requestId = ++this.treeRequestId;
		this.fileRequestId++;
		this.selectedSkill = name;
		this.currentFile = null;
		this.isLoadingFile = false;
		this.isEditing = false;
		this.isLoadingTree = true;
		this.emit("change", undefined);
		try {
			const data = await getSkillTree(name);
			if (requestId === this.treeRequestId && this.selectedSkill === name) {
				this.skillTree = data.children;
			}
		} catch {
			if (requestId === this.treeRequestId && this.selectedSkill === name) {
				this.skillTree = [];
			}
		} finally {
			if (requestId === this.treeRequestId && this.selectedSkill === name) {
				this.isLoadingTree = false;
				this.emit("change", undefined);
			}
		}
	}

	deselectSkill() {
		this.treeRequestId++;
		this.fileRequestId++;
		this.selectedSkill = null;
		this.skillTree = null;
		this.currentFile = null;
		this.isLoadingTree = false;
		this.isLoadingFile = false;
		this.isEditing = false;
		this.emit("change", undefined);
	}

	async selectFile(path: string) {
		const skillName = this.selectedSkill;
		if (!skillName) return;
		const requestId = ++this.fileRequestId;
		this.isEditing = false;
		this.isLoadingFile = true;
		this.emit("change", undefined);
		try {
			const file = await getSkillFile(skillName, path);
			if (requestId !== this.fileRequestId || this.selectedSkill !== skillName) return;
			if (file && file.kind === "html" && file.content) {
				file.content = await inlineSkillHtml(skillName, file.content, file.path);
				if (requestId !== this.fileRequestId || this.selectedSkill !== skillName) return;
			}
			this.currentFile = file;
		} catch {
			if (requestId === this.fileRequestId && this.selectedSkill === skillName) {
				this.currentFile = null;
			}
		} finally {
			if (requestId === this.fileRequestId && this.selectedSkill === skillName) {
				this.isLoadingFile = false;
				this.emit("change", undefined);
			}
		}
	}

	startEditing() {
		if (!this.currentFile?.content) return;
		this.isEditing = true;
		this.editBuffer = this.currentFile.content;
		this.emit("change", undefined);
	}

	/** Re-fetch the current file forcing text mode (for binary files the user wants to edit). */
	async openAsText() {
		const skillName = this.selectedSkill;
		const currentFile = this.currentFile;
		if (!skillName || !currentFile) return;
		const requestId = ++this.fileRequestId;
		this.isLoadingFile = true;
		this.emit("change", undefined);
		try {
			const file = await getSkillFile(skillName, currentFile.path, true);
			if (requestId === this.fileRequestId && this.selectedSkill === skillName) {
				this.currentFile = file;
			}
		} catch {
			// keep current file on failure
		} finally {
			if (requestId === this.fileRequestId && this.selectedSkill === skillName) {
				this.isLoadingFile = false;
				this.emit("change", undefined);
			}
		}
	}

	updateEditBuffer(value: string) {
		this.editBuffer = value;
		this.emit("change", undefined);
	}

	cancelEditing() {
		this.isEditing = false;
		this.emit("change", undefined);
	}

	async saveFile() {
		if (!this.selectedSkill || !this.currentFile) return;
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			await saveSkillFile(this.selectedSkill, this.currentFile.path, this.editBuffer);
			this.currentFile = { ...this.currentFile, content: this.editBuffer };
			this.isEditing = false;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async refreshTree() {
		const skillName = this.selectedSkill;
		if (!skillName) return;
		const requestId = ++this.treeRequestId;
		this.isLoadingTree = true;
		this.emit("change", undefined);
		try {
			const data = await getSkillTree(skillName);
			if (requestId === this.treeRequestId && this.selectedSkill === skillName) {
				this.skillTree = data.children;
			}
		} catch {
			if (requestId === this.treeRequestId && this.selectedSkill === skillName) {
				this.skillTree = [];
			}
		} finally {
			if (requestId === this.treeRequestId && this.selectedSkill === skillName) {
				this.isLoadingTree = false;
				this.emit("change", undefined);
			}
		}
	}
}

export const skillsStore = new SkillsStoreImpl();
