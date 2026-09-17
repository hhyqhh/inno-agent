import { basename, extname } from "node:path";
import { canonicalContainmentRoot, resolveContainedPath } from "../utils/path-safety.js";

/**
 * Pure file/path helpers shared by the server route domains (skills,
 * workspaces) and server.ts itself. Extracted verbatim from server.ts during
 * the P2 route split — everything here is stateless.
 */

/**
 * Containment-checked join for endpoints that read or write file contents.
 * A lexical check alone lets a symlink planted inside the root
 * (trivial for the agent's bash tool to create in a workspace) escape to any
 * file on the host; this resolves the closest existing ancestor through
 * realpath and verifies the canonical target stays inside the canonical root.
 * There is deliberately no exported lexical-only variant — new endpoints must
 * go through this guard.
 */
export function safeJoinReal(baseDir: string, userPath: string): string | null {
	return resolveContainedPath(baseDir, userPath);
}

/**
 * Normalize a path supplied by the workspace/file UI without turning an
 * absolute path into a workspace-relative one. Workspace APIs use relative
 * paths; a leading `./` is presentation noise, while a leading `/` must stay
 * absolute so containment checks can reject it.
 */
export function normalizeWorkspaceRelativePath(filePath: string): string {
	return filePath.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

export function slugifySkillName(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return slug || "uploaded-skill";
}

export const WORKSPACE_TREE_MAX_DEPTH = 8;

/** Directories never shown in workspace/skill trees or change monitors. */
export const WORKSPACE_IGNORES = new Set([".git", "node_modules", "dist", ".DS_Store", ".next", ".vite", "coverage"]);

/**
 * Build a `Content-Disposition: attachment` header value that survives
 * non-ASCII filenames. Falls back to a sanitized ASCII name plus the RFC 5987
 * `filename*` form so browsers pick the UTF-8 variant when supported.
 */
export function contentDispositionAttachment(fileName: string): string {
	const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(fileName);
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Canonicalize a tree root for containment checks. The root itself may
 * contain symlink components (e.g. macOS /tmp → /private/tmp); children's
 * realpaths never match a non-canonical root, which would silently render
 * every directory empty.
 */
export function canonicalTreeRoot(dir: string): string {
	return canonicalContainmentRoot(dir);
}

export interface WorkspaceTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	updatedAt?: string;
	children?: WorkspaceTreeNode[];
}

export const TEXT_PREVIEW_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
	".html",
	".htm",
	".xml",
	".yaml",
	".yml",
	".csv",
	".log",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".swift",
	".c",
	".cpp",
	".cc",
	".cxx",
	".h",
	".hpp",
	".cs",
	".php",
	".r",
	".R",
	".lua",
	".pl",
	".pm",
	".sh",
	".bash",
	".zsh",
	".fish",
	".bat",
	".ps1",
	".sql",
	".graphql",
	".gql",
	".toml",
	".ini",
	".cfg",
	".conf",
	".env",
	".gitignore",
	".dockerignore",
	".editorconfig",
	".prettierrc",
	".eslintrc",
	".scss",
	".sass",
	".less",
	".vue",
	".svelte",
	".astro",
	".tf",
	".proto",
	".gradle",
	".cmake",
	".makefile",
	".dockerfile",
]);

export const TEXT_NOEXT_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "vagrantfile"]);

/** Office document extensions previewable via LiteParse text extraction. */
export const OFFICE_PREVIEW_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

/** Map an office extension to a preview format the frontend dispatches on. */
export function officeFormat(filePath: string): "docx" | "xlsx" | "pptx" | undefined {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".docx") return "docx";
	if (ext === ".xlsx") return "xlsx";
	if (ext === ".pptx") return "pptx";
	return undefined;
}

/** Whether a file looks like a dotfile config (almost always text). */
export function isDotfileText(filePath: string): boolean {
	return basename(filePath).startsWith(".");
}

export function contentTypeForWorkspaceFile(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
	if (ext === ".md" || ext === ".markdown") return "text/markdown; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".webp") return "image/webp";
	if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
	if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
	if (isDotfileText(filePath)) return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

export function workspaceFileKind(filePath: string): "markdown" | "html" | "pdf" | "image" | "office" | "text" | "binary" {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "markdown";
	if (ext === ".html" || ext === ".htm") return "html";
	if (ext === ".pdf") return "pdf";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "image";
	if (OFFICE_PREVIEW_EXTENSIONS.has(ext)) return "office";
	if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "text";
	if (!ext && TEXT_NOEXT_NAMES.has(basename(filePath).toLowerCase())) return "text";
	// Dotfiles (.env, .env.local, .npmrc, .gitconfig, etc.) are text config files
	if (isDotfileText(filePath)) return "text";
	return "binary";
}
