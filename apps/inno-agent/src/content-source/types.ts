/**
 * Remote content source abstraction.
 *
 * Inno fetches two kinds of ready-to-use content from a remote "hub": the
 * global skill library and the Simple Mode preset workspaces. Both share the
 * same shape (a directory per item containing a marker file + supporting
 * files), so they sit behind one transport-agnostic interface. Swapping the
 * backing source — a public GitHub repo today, a private self-hosted bundle
 * service tomorrow — is then a config change, not a code change.
 */

/** The two logical content categories the hub serves. */
export type ContentCategory = "skills" | "presets";

/** One listable item (a skill or a preset), keyed by its directory name. */
export interface RemoteItem {
	/** Directory / id name of the item. */
	name: string;
	/**
	 * Pre-fetched metadata, when the source can provide it cheaply (the bundle
	 * service ships it in index.json). GitHub leaves this undefined and callers
	 * fall back to reading the item's marker file via readItemTextFile.
	 */
	meta?: Record<string, unknown>;
}

export interface ListOpts {
	/** Bypass any short-lived cache and re-fetch from the source. */
	forceRefresh?: boolean;
}

export interface RemoteContentSource {
	/** Enumerate the items available in a category. */
	listItems(category: ContentCategory, opts?: ListOpts): Promise<RemoteItem[]>;
	/**
	 * Read a single UTF-8 text file inside an item (e.g. SKILL.md / preset.json)
	 * for metadata. Returns null when the file is missing.
	 */
	readItemTextFile(category: ContentCategory, name: string, relPath: string): Promise<string | null>;
	/**
	 * Download every file of an item into `targetDir` (created if needed),
	 * preserving the item's internal directory structure. The item's files land
	 * directly under targetDir (not nested under an extra <name>/ level).
	 */
	downloadItem(category: ContentCategory, name: string, targetDir: string): Promise<void>;
	/** Drop any cached listing so the next call re-fetches. */
	invalidate(): void;
}

/** The marker file that identifies a directory as an item of each category. */
export const CATEGORY_MARKER: Record<ContentCategory, string> = {
	skills: "SKILL.md",
	presets: "preset.json",
};

/** Validate a single-segment item name (blocks path traversal). */
export function isSafeItemName(name: string): boolean {
	return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}
