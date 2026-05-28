import { EventEmitter } from "./event-emitter.js";
import { deleteSkill, listSkills, reloadSkills, updateSkill, uploadSkill, getSkillTree, getSkillFile, saveSkillFile } from "../api/skills.js";
import type { SkillInfo } from "../types/skills.js";
import type { WorkspaceTreeNode, WorkspaceFileDetail } from "../types/workspace.js";

interface SkillsStoreEvents {
	change: void;
}

class SkillsStoreImpl extends EventEmitter<SkillsStoreEvents> {
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
			this.selectedSkill = null;
			this.skillTree = null;
			this.currentFile = null;
			this.isEditing = false;
		}
		this.emit("change", undefined);
	}

	async reload() {
		const result = await reloadSkills();
		this.skills = result.skills;
		this.emit("change", undefined);
	}

	/* --- File browsing --- */

	async selectSkill(name: string) {
		this.selectedSkill = name;
		this.currentFile = null;
		this.isEditing = false;
		this.isLoadingTree = true;
		this.emit("change", undefined);
		try {
			const data = await getSkillTree(name);
			if (this.selectedSkill === name) {
				this.skillTree = data.children;
			}
		} catch {
			this.skillTree = [];
		} finally {
			this.isLoadingTree = false;
			this.emit("change", undefined);
		}
	}

	deselectSkill() {
		this.selectedSkill = null;
		this.skillTree = null;
		this.currentFile = null;
		this.isEditing = false;
		this.emit("change", undefined);
	}

	async selectFile(path: string) {
		if (!this.selectedSkill) return;
		this.isEditing = false;
		this.isLoadingFile = true;
		this.emit("change", undefined);
		try {
			this.currentFile = await getSkillFile(this.selectedSkill, path);
		} catch {
			this.currentFile = null;
		} finally {
			this.isLoadingFile = false;
			this.emit("change", undefined);
		}
	}

	startEditing() {
		if (!this.currentFile?.content) return;
		this.isEditing = true;
		this.editBuffer = this.currentFile.content;
		this.emit("change", undefined);
	}

	updateEditBuffer(value: string) {
		this.editBuffer = value;
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
		if (!this.selectedSkill) return;
		this.isLoadingTree = true;
		this.emit("change", undefined);
		try {
			const data = await getSkillTree(this.selectedSkill);
			this.skillTree = data.children;
		} catch {
			this.skillTree = [];
		} finally {
			this.isLoadingTree = false;
			this.emit("change", undefined);
		}
	}
}

export const skillsStore = new SkillsStoreImpl();
