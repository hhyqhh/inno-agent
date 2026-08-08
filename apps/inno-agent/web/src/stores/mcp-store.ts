import { EventEmitter } from "./event-emitter.js";
import { deleteMcpServer, getMcpOverview, setMcpServerDisabled, upsertMcpServer } from "../api/mcp.js";
import type { McpOverview, McpServerEntry } from "../types/mcp.js";

interface McpStoreEvents {
	change: void;
}

class McpStoreImpl extends EventEmitter<McpStoreEvents> {
	overview: McpOverview | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.overview = await getMcpOverview();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to load MCP overview";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	private async run(action: () => Promise<McpOverview>): Promise<void> {
		this.isSaving = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.overview = await action();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "MCP operation failed";
			this.emit("change", undefined);
			throw err;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async upsertServer(name: string, entry: McpServerEntry): Promise<void> {
		await this.run(() => upsertMcpServer(name, entry));
	}

	async setDisabled(name: string, disabled: boolean): Promise<void> {
		await this.run(() => setMcpServerDisabled(name, disabled));
	}

	async deleteServer(name: string): Promise<void> {
		await this.run(() => deleteMcpServer(name));
	}
}

export const mcpStore = new McpStoreImpl();
