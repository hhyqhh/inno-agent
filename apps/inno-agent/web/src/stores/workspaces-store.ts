import { EventEmitter } from "./event-emitter.js";
import {
	createWorkspace,
	deleteWorkspace,
	importWorkspaceZip,
	listWorkspaces,
	updateWorkspace,
	type WorkspaceConfiguration,
	type CreateWorkspaceInput,
	type WorkspaceMeta,
} from "../api/workspaces.js";

interface WorkspacesStoreEvents {
	change: void;
}

class WorkspacesStoreImpl extends EventEmitter<WorkspacesStoreEvents> {
	workspaces: WorkspaceMeta[] = [];
	isLoading = false;
	error = "";

	get nonTemp(): WorkspaceMeta[] {
		return this.workspaces.filter((w) => !w.isTemp);
	}

	getById(id: string): WorkspaceMeta | undefined {
		return this.workspaces.find((w) => w.id === id);
	}

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = "";
		this.emit("change", undefined);
		try {
			this.workspaces = await listWorkspaces();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to load workspaces";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async create(input: CreateWorkspaceInput): Promise<WorkspaceMeta> {
		const ws = await createWorkspace(input);
		this.workspaces = [...this.workspaces.filter((item) => item.id !== ws.id), ws];
		this.emit("change", undefined);
		return ws;
	}

	async importFromZip(file: File): Promise<WorkspaceMeta> {
		const ws = await importWorkspaceZip(file);
		this.workspaces = [...this.workspaces, ws];
		this.emit("change", undefined);
		return ws;
	}

	async rename(id: string, name: string): Promise<void> {
		await this.update(id, { name });
	}

	async update(id: string, configuration: WorkspaceConfiguration & { name?: string }): Promise<WorkspaceMeta> {
		const updated = await updateWorkspace(id, configuration);
		this.workspaces = this.workspaces.map((workspace) => workspace.id === id ? updated : workspace);
		this.emit("change", undefined);
		return updated;
	}

	async remove(id: string, removeFiles = false): Promise<void> {
		await deleteWorkspace(id, removeFiles);
		this.workspaces = this.workspaces.filter((w) => w.id !== id);
		this.emit("change", undefined);
	}
}

export const workspacesStore = new WorkspacesStoreImpl();
