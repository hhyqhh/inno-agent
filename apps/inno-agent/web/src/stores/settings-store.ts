import { EventEmitter } from "./event-emitter.js";
import { getSettings, switchBackendModel, upsertProvider, deleteProviderApi, saveChannelsSettings, saveMemorySettings, saveGithubSettings } from "../api/settings.js";
import type { InnoSettings, UpsertProviderRequest, ChannelsSettingsPayload } from "../types/settings.js";

interface SettingsStoreEvents {
	change: void;
}

class SettingsStoreImpl extends EventEmitter<SettingsStoreEvents> {
	settings: InnoSettings | null = null;
	isLoading = false;
	isSavingModel = false;
	isSavingProvider = false;
	isSavingChannels = false;
	isSavingMemory = false;
	isSavingGithub = false;
	error: string | null = null;

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await getSettings();
		} catch (err) {
			this.settings = null;
			this.error = err instanceof Error ? err.message : "Failed to load settings";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async switchModel(provider: string, model: string): Promise<void> {
		this.isSavingModel = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Switch model timed out")), 10_000),
			);
			const next = await Promise.race([switchBackendModel(provider, model), timeout]);
			if (this.settings) {
				this.settings = {
					...this.settings,
					defaultProvider: next.defaultProvider,
					defaultModel: next.defaultModel,
				};
			}
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to switch model";
			this.emit("change", undefined);
		} finally {
			this.isSavingModel = false;
			this.emit("change", undefined);
		}
	}

	async saveProvider(payload: UpsertProviderRequest): Promise<void> {
		this.isSavingProvider = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await upsertProvider(payload);
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save provider";
			this.emit("change", undefined);
		} finally {
			this.isSavingProvider = false;
			this.emit("change", undefined);
		}
	}

	async deleteProvider(providerId: string): Promise<void> {
		this.isSavingProvider = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await deleteProviderApi(providerId);
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to delete provider";
			this.emit("change", undefined);
		} finally {
			this.isSavingProvider = false;
			this.emit("change", undefined);
		}
	}

	async saveChannels(payload: ChannelsSettingsPayload): Promise<void> {
		this.isSavingChannels = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await saveChannelsSettings(payload);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save channels";
			this.emit("change", undefined);
		} finally {
			this.isSavingChannels = false;
			this.emit("change", undefined);
		}
	}

	async saveMemory(l3Enabled: boolean): Promise<void> {
		this.isSavingMemory = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await saveMemorySettings(l3Enabled);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save memory settings";
			this.emit("change", undefined);
		} finally {
			this.isSavingMemory = false;
			this.emit("change", undefined);
		}
	}

	async saveGithub(token: string): Promise<void> {
		this.isSavingGithub = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await saveGithubSettings(token);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save GitHub settings";
			this.emit("change", undefined);
			throw err;
		} finally {
			this.isSavingGithub = false;
			this.emit("change", undefined);
		}
	}
}

export const settingsStore = new SettingsStoreImpl();
