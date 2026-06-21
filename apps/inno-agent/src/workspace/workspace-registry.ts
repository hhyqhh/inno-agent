import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, readJson, writeJson } from "../storage/file-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceMeta {
	id: string;
	name: string;
	relPath: string;       // relative to workspaceDir; "" for default
	createdAt: string;
	updatedAt: string;
	isTemp: boolean;
}

interface RegistryFile {
	workspaces: WorkspaceMeta[];
	/** One-time flag: legacy unbound sessions have been bound to the default workspace. */
	migratedUnboundToDefault?: boolean;
}

type SessionWorkspaceMap = Record<string, string>;

export interface WorkspaceWithSessions extends WorkspaceMeta {
	sessionIds: string[];
}

export const DEFAULT_WORKSPACE_ID = "default";
export const TEMP_WORKSPACE_ID = "tmp";
const DEFAULT_WORKSPACE_REL_PATH = ".pub";
const TEMP_WORKSPACE_REL_PATH = ".tmp";

/** Human-readable names for channel-backed workspaces. */
const CHANNEL_WORKSPACE_NAMES: Record<string, string> = {
	feishu: "飞书",
	wechat: "微信",
	qq: "QQ",
	cli: "CLI",
};

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32);
	return slug;
}

function shortHash(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class WorkspaceRegistry {
	constructor(
		private readonly workspaceDir: string,
		private readonly dataDir: string,
	) {}

	private registryPath(): string {
		return join(this.dataDir, "workspaces", "registry.json");
	}

	private sessionMapPath(): string {
		return join(this.dataDir, "sessions", "workspaces.json");
	}

	private loadRegistry(): RegistryFile {
		return readJson<RegistryFile>(this.registryPath(), { workspaces: [] });
	}

	private saveRegistry(reg: RegistryFile): void {
		writeJson(this.registryPath(), reg);
	}

	private loadSessionMap(): SessionWorkspaceMap {
		return readJson<SessionWorkspaceMap>(this.sessionMapPath(), {});
	}

	private saveSessionMap(map: SessionWorkspaceMap): void {
		writeJson(this.sessionMapPath(), map);
	}

	/** Ensure the shared tmp workspace exists; preserve a legacy default if present. */
	ensureBootstrapped(): void {
		ensureDir(this.workspaceDir);
		ensureDir(join(this.workspaceDir, TEMP_WORKSPACE_REL_PATH));
		const reg = this.loadRegistry();
		const now = new Date().toISOString();
		let changed = false;

		// The default workspace is no longer auto-created (web sessions fall back
		// to tmp). We only preserve/normalize it when a legacy install still has
		// one bound to existing sessions; never recreate it once removed.
		const defaultIdx = reg.workspaces.findIndex((w) => w.id === DEFAULT_WORKSPACE_ID);
		if (defaultIdx >= 0) {
			const def = reg.workspaces[defaultIdx];
			ensureDir(join(this.workspaceDir, DEFAULT_WORKSPACE_REL_PATH));
			// Legacy installs labelled this the shared "公共空间"; it is now an
			// ordinary, deletable workspace with no special fallback role.
			if (def.name === "公共空间") { def.name = "默认工作区"; changed = true; }
			if (def.relPath !== DEFAULT_WORKSPACE_REL_PATH) {
				def.relPath = DEFAULT_WORKSPACE_REL_PATH;
				changed = true;
			}
		}

		if (!reg.workspaces.some((w) => w.id === TEMP_WORKSPACE_ID)) {
			reg.workspaces.push({
				id: TEMP_WORKSPACE_ID,
				name: "临时工作区",
				relPath: TEMP_WORKSPACE_REL_PATH,
				createdAt: now,
				updatedAt: now,
				isTemp: true,
			});
			changed = true;
		}

		if (changed) this.saveRegistry(reg);
	}

	/**
	 * List workspaces with their bound session ids (most recently updated first).
	 * If `allSessionIds` is provided, any session id NOT in the registry's session
	 * map is treated as bound to the shared temp workspace (the unbound fallback).
	 */
	listWorkspaces(allSessionIds?: string[]): WorkspaceWithSessions[] {
		const reg = this.loadRegistry();
		const map = this.loadSessionMap();
		const sessionsByWs = new Map<string, string[]>();
		for (const [sessionId, workspaceId] of Object.entries(map)) {
			const arr = sessionsByWs.get(workspaceId) ?? [];
			arr.push(sessionId);
			sessionsByWs.set(workspaceId, arr);
		}
		if (allSessionIds && allSessionIds.length > 0) {
			const mapped = new Set(Object.keys(map));
			const orphans: string[] = [];
			for (const sid of allSessionIds) {
				if (!mapped.has(sid)) orphans.push(sid);
			}
			if (orphans.length > 0) {
				const existing = sessionsByWs.get(TEMP_WORKSPACE_ID) ?? [];
				sessionsByWs.set(TEMP_WORKSPACE_ID, [...existing, ...orphans]);
			}
		}
		const enriched = reg.workspaces.map((w) => ({
			...w,
			sessionIds: sessionsByWs.get(w.id) ?? [],
		}));
		enriched.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
		return enriched;
	}

	getWorkspace(id: string): WorkspaceMeta | null {
		const reg = this.loadRegistry();
		return reg.workspaces.find((w) => w.id === id) ?? null;
	}

	/** Resolve a workspace id to its absolute directory. Returns null if invalid or escapes workspaceDir. */
	resolveWorkspaceDir(id: string | null | undefined): string | null {
		const wsId = id || TEMP_WORKSPACE_ID;
		const ws = this.getWorkspace(wsId);
		if (!ws) return null;
		const resolved = resolve(this.workspaceDir, ws.relPath);
		const rel = relative(resolve(this.workspaceDir), resolved);
		if (rel.startsWith("..")) return null;
		return resolved;
	}

	/**
	 * Create a new workspace.
	 * - isTemp=true → returns the shared `tmp` workspace (does not allocate a new directory).
	 * - isTemp=false → places it at `<slug>-<hash>/`, where slug comes from the name and hash is 8 random hex chars.
	 */
	createWorkspace(input: { name?: string; isTemp?: boolean }): WorkspaceMeta {
		const reg = this.loadRegistry();
		const now = new Date().toISOString();

		if (input.isTemp) {
			const existing = reg.workspaces.find((w) => w.id === TEMP_WORKSPACE_ID);
			if (existing) {
				existing.updatedAt = now;
				this.saveRegistry(reg);
				ensureDir(join(this.workspaceDir, existing.relPath));
				return existing;
			}
			// Fallback: bootstrap was skipped. Create the shared tmp entry now.
			const tmp: WorkspaceMeta = {
				id: TEMP_WORKSPACE_ID,
				name: "临时工作区",
				relPath: TEMP_WORKSPACE_REL_PATH,
				createdAt: now,
				updatedAt: now,
				isTemp: true,
			};
			reg.workspaces.push(tmp);
			this.saveRegistry(reg);
			ensureDir(join(this.workspaceDir, tmp.relPath));
			return tmp;
		}

		const rawName = input.name?.trim() || "工作区";
		const slugBase = slugify(rawName) || "workspace";
		// Always append a hash so we never collide and never need -2/-3 suffixes.
		const id = `${slugBase}-${shortHash()}`;
		const relPath = id;
		const absDir = join(this.workspaceDir, relPath);
		if (!existsSync(absDir)) {
			mkdirSync(absDir, { recursive: true });
		} else if (!statSync(absDir).isDirectory()) {
			throw new Error(`Path conflicts with non-directory: ${relPath}`);
		}

		const ws: WorkspaceMeta = {
			id,
			name: rawName,
			relPath,
			createdAt: now,
			updatedAt: now,
			isTemp: false,
		};
		reg.workspaces.push(ws);
		this.saveRegistry(reg);
		return ws;
	}

	/**
	 * Return (creating if needed) a stable workspace dedicated to a chat channel
	 * (e.g. feishu/wechat/qq). Channel-originated sessions bind here because they
	 * cannot prompt the user for a workspace choice.
	 */
	ensureChannelWorkspace(channel: string): WorkspaceMeta {
		const id = `channel-${channel}`;
		const reg = this.loadRegistry();
		const now = new Date().toISOString();
		let ws = reg.workspaces.find((w) => w.id === id);
		if (!ws) {
			ws = {
				id,
				name: CHANNEL_WORKSPACE_NAMES[channel] ?? channel,
				relPath: join(".channels", channel),
				createdAt: now,
				updatedAt: now,
				isTemp: false,
			};
			reg.workspaces.push(ws);
			this.saveRegistry(reg);
		}
		ensureDir(join(this.workspaceDir, ws.relPath));
		return ws;
	}

	/**
	 * Return (creating if needed) a stable workspace dedicated to a bundled
	 * preset. Unlike a one-off `createWorkspace`, the id is derived from the
	 * preset id (`preset-<presetId>`) so that repeatedly opening the same preset
	 * task reuses one workspace — every conversation for that task is archived
	 * together. `created` is true only on the first call (so the caller knows
	 * when to seed the preset's files).
	 */
	ensurePresetWorkspace(presetId: string, name: string): { ws: WorkspaceMeta; created: boolean } {
		const id = `preset-${presetId}`;
		const reg = this.loadRegistry();
		const now = new Date().toISOString();
		let ws = reg.workspaces.find((w) => w.id === id);
		if (ws) {
			ws.updatedAt = now;
			this.saveRegistry(reg);
			ensureDir(join(this.workspaceDir, ws.relPath));
			return { ws, created: false };
		}
		ws = {
			id,
			name,
			relPath: join(".presets", presetId),
			createdAt: now,
			updatedAt: now,
			isTemp: false,
		};
		reg.workspaces.push(ws);
		this.saveRegistry(reg);
		ensureDir(join(this.workspaceDir, ws.relPath));
		return { ws, created: true };
	}

	/**
	 * One-time migration: bind any session not present in the session→workspace
	 * map to `targetWorkspaceId`. This preserves the working directory of legacy
	 * sessions that used to fall back to the shared public workspace.
	 */
	migrateUnboundSessions(sessionIds: string[], targetWorkspaceId: string): void {
		const reg = this.loadRegistry();
		if (reg.migratedUnboundToDefault) return;
		if (!reg.workspaces.some((w) => w.id === targetWorkspaceId)) {
			reg.migratedUnboundToDefault = true;
			this.saveRegistry(reg);
			return;
		}
		const map = this.loadSessionMap();
		let changed = false;
		for (const sid of sessionIds) {
			if (!(sid in map)) {
				map[sid] = targetWorkspaceId;
				changed = true;
			}
		}
		if (changed) this.saveSessionMap(map);
		reg.migratedUnboundToDefault = true;
		this.saveRegistry(reg);
	}

	renameWorkspace(id: string, name: string): WorkspaceMeta | null {
		const reg = this.loadRegistry();
		const ws = reg.workspaces.find((w) => w.id === id);
		if (!ws) return null;
		ws.name = name.trim() || ws.name;
		ws.updatedAt = new Date().toISOString();
		this.saveRegistry(reg);
		return ws;
	}

	/** Delete a workspace. Refuses only the shared tmp (the unbound fallback). */
	deleteWorkspace(id: string, options: { removeFiles?: boolean } = {}): boolean {
		if (id === TEMP_WORKSPACE_ID) return false;
		const reg = this.loadRegistry();
		const index = reg.workspaces.findIndex((w) => w.id === id);
		if (index < 0) return false;
		const ws = reg.workspaces[index];
		reg.workspaces.splice(index, 1);
		this.saveRegistry(reg);

		// Unbind all sessions pointing to this workspace.
		const map = this.loadSessionMap();
		let changed = false;
		for (const sessionId of Object.keys(map)) {
			if (map[sessionId] === id) {
				delete map[sessionId];
				changed = true;
			}
		}
		if (changed) this.saveSessionMap(map);

		if (options.removeFiles) {
			const absDir = join(this.workspaceDir, ws.relPath);
			if (ws.relPath && existsSync(absDir)) {
				rmSync(absDir, { recursive: true, force: true });
			}
		}
		return true;
	}

	/** Touch updatedAt for ordering. */
	touchWorkspace(id: string): void {
		const reg = this.loadRegistry();
		const ws = reg.workspaces.find((w) => w.id === id);
		if (!ws) return;
		ws.updatedAt = new Date().toISOString();
		this.saveRegistry(reg);
	}

	// ---- Session ↔ Workspace mapping ----

	getSessionWorkspaceId(sessionId: string): string {
		const map = this.loadSessionMap();
		return map[sessionId] ?? TEMP_WORKSPACE_ID;
	}

	/** Whether this session has an explicit workspace binding (vs the tmp fallback). */
	isSessionBound(sessionId: string): boolean {
		const map = this.loadSessionMap();
		return sessionId in map;
	}

	bindSession(sessionId: string, workspaceId: string): boolean {
		if (!this.getWorkspace(workspaceId)) return false;
		const map = this.loadSessionMap();
		map[sessionId] = workspaceId;
		this.saveSessionMap(map);
		this.touchWorkspace(workspaceId);
		return true;
	}

	unbindSession(sessionId: string): void {
		const map = this.loadSessionMap();
		if (sessionId in map) {
			delete map[sessionId];
			this.saveSessionMap(map);
		}
	}

	/**
	 * Whether this session is the sole owner of the given workspace AND that
	 * workspace was a per-session temp directory.
	 * Now that temp sessions share a single `tmp` workspace, this always returns
	 * false — temp directories are no longer auto-cleaned on session delete.
	 */
	isOnlyTempSessionOwner(_sessionId: string, _workspaceId: string): boolean {
		return false;
	}
}
