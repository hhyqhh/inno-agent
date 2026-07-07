import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RuntimePaths } from "../runtime.js";
import type { WorkspaceMeta, WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { RemoteContentSource } from "../content-source/index.js";
import { logger } from "../logger.js";

/**
 * Preset workspaces — ready-to-use templates surfaced in Simple Mode.
 *
 * Each preset is a directory containing:
 *   - `preset.json` — metadata `{ id, name, description, icon? }` (id must equal
 *     the directory name)
 *   - `agent.md`    — per-workspace instructions (injected each turn by the
 *     extension's `before_agent_start` hook)
 *   - `.skills/`    — optional per-workspace private skills (also auto-injected)
 *
 * Presets are fetched from the remote content hub (a GitHub repo or a private
 * bundle service) and materialized into a local cache under
 * `<dataDir>/preset-cache/<id>/`. Opening a preset instantiates it: a fresh
 * editable workspace is created and the preset's `agent.md` + `.skills/` are
 * copied in (excluding `preset.json`). The cache is the single source of truth
 * for instantiation, so first open requires the network but later opens (and
 * offline use) reuse the cached copy.
 */

export interface PresetMeta {
	id: string;
	name: string;
	description: string;
	icon?: string;
	category?: string;
}

/** Only simple, single-segment ids — blocks path traversal. */
const PRESET_ID_RE = /^[a-zA-Z0-9._-]+$/;

function isValidPresetId(id: string): boolean {
	return PRESET_ID_RE.test(id) && id !== "." && id !== "..";
}

/** Absolute path to the local preset cache directory. */
export function presetsDir(paths: RuntimePaths): string {
	return paths.presetCacheDir;
}

/**
 * Absolute path to the presets bundled with the app (shipped under the compiled
 * code root). Used as an offline fallback / seed when the remote hub has no
 * presets yet, so the app still shows its built-in templates.
 */
export function bundledPresetsDir(paths: RuntimePaths): string {
	return join(paths.codeDir, "presets");
}

function parsePresetMeta(rawText: string, id: string): PresetMeta | null {
	try {
		const raw = JSON.parse(rawText) as Partial<PresetMeta>;
		const metaId = (raw.id ?? "").trim();
		// The declared id must match the directory name to keep instantiation safe.
		if (metaId !== id) {
			logger.warn({ metaId, id }, "preset.json id does not match directory name; skipping");
			return null;
		}
		const name = (raw.name ?? "").trim();
		if (!name) {
			logger.warn({ id }, "preset.json missing name; skipping");
			return null;
		}
		return {
			id,
			name,
			description: (raw.description ?? "").trim(),
			icon: raw.icon?.trim() || undefined,
			category: raw.category?.trim() || undefined,
		};
	} catch (err) {
		logger.warn({ err, id }, "failed to parse preset.json; skipping");
		return null;
	}
}

function readPresetMeta(dir: string, id: string): PresetMeta | null {
	const metaPath = join(dir, "preset.json");
	if (!existsSync(metaPath)) return null;
	return parsePresetMeta(readFileSync(metaPath, "utf-8"), id);
}

/**
 * List presets available offline: the union of the local cache and the presets
 * bundled with the app (cache wins on id collision). Best-effort — invalid
 * presets are skipped. Used as a fallback when the remote hub is unreachable.
 */
export function listPresets(paths: RuntimePaths): PresetMeta[] {
	const byId = new Map<string, PresetMeta>();
	// Bundled first, then cache overrides (a downloaded preset is fresher).
	for (const root of [bundledPresetsDir(paths), presetsDir(paths)]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "__MACOSX" || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
			if (!isValidPresetId(entry.name)) continue;
			const meta = readPresetMeta(join(root, entry.name), entry.name);
			if (meta) byId.set(meta.id, meta);
		}
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List presets available from the remote content hub. For each preset, the
 * metadata comes from inline source meta (bundle service) or by reading its
 * `preset.json` (GitHub). Best-effort: presets with invalid metadata are
 * skipped.
 */
export async function listRemotePresets(source: RemoteContentSource, forceRefresh = false): Promise<PresetMeta[]> {
	const items = await source.listItems("presets", { forceRefresh });
	// GitHub reads one preset.json per item over raw.githubusercontent.com, which
	// throttles bursts (429). Cap concurrency so a large catalog doesn't trip the
	// limit and silently drop presets from the list.
	const metas = await mapWithConcurrency(items, 5, async (item): Promise<PresetMeta | null> => {
		// Bundle service ships metadata inline in index.json.
		const m = item.meta;
		if (m && typeof m.name === "string" && m.name.trim()) {
			return {
				id: item.name,
				name: m.name.trim(),
				description: typeof m.description === "string" ? m.description.trim() : "",
				icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
				category: typeof m.category === "string" && m.category.trim() ? m.category.trim() : undefined,
			};
		}
		// GitHub: read the preset.json file.
		const text = await source.readItemTextFile("presets", item.name, "preset.json");
		if (!text) {
			logger.warn({ id: item.name }, "remote preset missing preset.json; skipping");
			return null;
		}
		return parsePresetMeta(text, item.name);
	});
	return metas.filter((m): m is PresetMeta => m !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Map over items with a bounded number of in-flight async tasks, preserving order. */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Ensure a preset's files are present in the local cache, downloading them from
 * the content source on first use (or when `forceRefresh` is set). Returns the
 * absolute cache directory. Throws if the preset is unknown / invalid.
 */
export async function ensurePresetCached(
	paths: RuntimePaths,
	source: RemoteContentSource,
	presetId: string,
	forceRefresh = false,
): Promise<string> {
	const id = presetId.trim();
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${presetId}`);
	}
	const root = presetsDir(paths);
	const cacheDir = join(root, id);
	const cachedMetaExists = existsSync(join(cacheDir, "preset.json"));
	if (cachedMetaExists && !forceRefresh) {
		return cacheDir;
	}
	// Try the remote hub first.
	try {
		await source.downloadItem("presets", id, cacheDir);
		if (!existsSync(join(cacheDir, "preset.json"))) {
			throw new Error(`Preset "${id}" did not provide a preset.json`);
		}
		logger.info({ presetId: id, cacheDir }, "cached remote preset");
		return cacheDir;
	} catch (err) {
		// Fall back to a preset bundled with the app, if one exists. Lets the
		// shipped templates work offline / before the hub has them.
		const bundledDir = join(bundledPresetsDir(paths), id);
		if (existsSync(join(bundledDir, "preset.json"))) {
			copyPresetContents(bundledDir, cacheDir);
			// copyPresetContents skips preset.json, so copy it explicitly.
			writeFileSync(join(cacheDir, "preset.json"), readFileSync(join(bundledDir, "preset.json")));
			logger.info({ presetId: id, cacheDir }, "seeded preset from bundled copy (remote unavailable)");
			return cacheDir;
		}
		throw err;
	}
}

/**
 * Recursively copy a preset's content into a destination workspace directory.
 * Uses file-by-file read/write (not cpSync) for robustness against
 * asar-unpacked paths in Electron packaged builds. Skips `preset.json`.
 */
function copyPresetContents(sourceDir: string, targetDir: string): void {
	if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX" || entry.name === ".DS_Store" || entry.name === "preset.json") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyPresetContents(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
 * Open a preset: return its stable dedicated workspace (creating + seeding it
 * with the preset's files on first open). Repeatedly opening the same preset
 * reuses one workspace, so every conversation for that task is archived
 * together. The preset must already be present in the local cache (call
 * `ensurePresetCached` first). Throws on an unknown/invalid preset.
 */
export function instantiatePreset(
	paths: RuntimePaths,
	registry: WorkspaceRegistry,
	presetId: string,
): WorkspaceMeta {
	const id = presetId.trim();
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${presetId}`);
	}
	const root = presetsDir(paths);
	const srcDir = join(root, id);
	// Confirm the resolved dir stays under the cache root (defence in depth).
	const rel = relative(root, srcDir);
	if (rel.startsWith("..") || !existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
		throw new Error(`Preset not found in cache: ${presetId}`);
	}
	const meta = readPresetMeta(srcDir, id);
	if (!meta) {
		throw new Error(`Preset metadata invalid: ${presetId}`);
	}

	const { ws, created } = registry.ensurePresetWorkspace(id, meta.name);
	const destDir = registry.resolveWorkspaceDir(ws.id);
	if (!destDir) {
		throw new Error(`Failed to resolve workspace dir for ${ws.id}`);
	}
	// Only seed the preset's files on first creation so later opens don't clobber
	// the user's edits / conversation artifacts in that workspace.
	if (created) {
		copyPresetContents(srcDir, destDir);
		logger.info({ presetId: id, workspaceId: ws.id }, "instantiated preset workspace");
	} else {
		logger.info({ presetId: id, workspaceId: ws.id }, "reused existing preset workspace");
	}
	return ws;
}
