import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	statSync,
	unlinkSync,
	constants,
} from "node:fs";
import { dirname } from "node:path";
import type { WorkspaceMeta, WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { resolveContainedPath } from "../utils/path-safety.js";
import {
	WORKSPACE_IGNORES,
	normalizeWorkspaceRelativePath,
	safeJoinReal,
} from "./file-helpers.js";
import { getWorkspaceFileActivities } from "./workspace-activity-store.js";

export type WorkspaceFileAccess = "read" | "write" | "read_write";
export type WorkspaceSwitchFileAction = "move" | "copy" | "none";

export interface WorkspaceSwitchFile {
	path: string;
	access: WorkspaceFileAccess;
	exists: boolean;
	selectable: boolean;
}

export interface WorkspaceSwitchPreview {
	sourceWorkspace: WorkspaceMeta;
	targetWorkspace: WorkspaceMeta;
	files: WorkspaceSwitchFile[];
	trackingIncomplete: boolean;
}

export type WorkspaceSwitchFileStatus = "moved" | "copied" | "conflict" | "missing" | "failed";
type TransferAction = Exclude<WorkspaceSwitchFileAction, "none">;

export interface WorkspaceSwitchFileResult {
	path: string;
	access: WorkspaceFileAccess;
	action: TransferAction;
	status: WorkspaceSwitchFileStatus;
	error?: string;
	/** A move can leave a successfully copied target when source deletion fails. */
	copied?: boolean;
}

export function isSwitchableWorkspace(workspace: WorkspaceMeta | null | undefined): workspace is WorkspaceMeta {
	if (!workspace) return false;
	return !workspace.id.startsWith("channel-");
}

function normalizeTransferPath(rawPath: string): string | null {
	if (typeof rawPath !== "string") return null;
	const value = rawPath.trim().replaceAll("\\", "/");
	if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
	const normalized = normalizeWorkspaceRelativePath(value);
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || WORKSPACE_IGNORES.has(part))) return null;
	return normalized;
}

function isSafeWorkspaceRoot(rootDir: string): boolean {
	try {
		const stat = lstatSync(rootDir);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

interface InspectedSourceFile {
	path: string;
	fullPath: string | null;
	exists: boolean;
	selectable: boolean;
	reason?: string;
}

function inspectSourceFile(rootDir: string, path: string): InspectedSourceFile {
	const normalized = normalizeTransferPath(path);
	if (!normalized) return { path, fullPath: null, exists: false, selectable: false, reason: "invalid_path" };
	const fullPath = safeJoinReal(rootDir, normalized);
	if (!fullPath) {
		return { path: normalized, fullPath: null, exists: false, selectable: false, reason: "unsafe_path" };
	}
	try {
		const stat = lstatSync(fullPath);
		if (stat.isSymbolicLink()) return { path: normalized, fullPath: null, exists: false, selectable: false, reason: "symlink" };
		if (!stat.isFile()) return { path: normalized, fullPath, exists: true, selectable: false, reason: "not_file" };
		return { path: normalized, fullPath, exists: true, selectable: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { path: normalized, fullPath, exists: false, selectable: false, reason: "missing" };
		}
		return { path: normalized, fullPath: null, exists: false, selectable: false, reason: "unreadable" };
	}
}

function sourceHistoryExists(sessionPath: string | null): boolean {
	if (!sessionPath || !existsSync(sessionPath)) return false;
	try {
		return statSync(sessionPath).size > 0;
	} catch {
		return false;
	}
}

export function buildWorkspaceSwitchPreview(input: {
	dataDir: string;
	sessionId: string;
	sessionPath: string | null;
	workspaceRegistry: WorkspaceRegistry;
	targetWorkspaceId: string;
}): WorkspaceSwitchPreview {
	const sourceWorkspaceId = input.workspaceRegistry.getSessionWorkspaceId(input.sessionId);
	const sourceWorkspace = input.workspaceRegistry.getWorkspace(sourceWorkspaceId);
	const targetWorkspace = input.workspaceRegistry.getWorkspace(input.targetWorkspaceId);
	if (!sourceWorkspace) throw new Error("Source workspace not found");
	if (!isSwitchableWorkspace(targetWorkspace)) throw new Error("Target workspace is not available for conversation switching");
	const sourceRoot = input.workspaceRegistry.resolveWorkspaceDir(sourceWorkspace.id);
	const targetRoot = input.workspaceRegistry.resolveWorkspaceDir(targetWorkspace.id);
	if (!sourceRoot || !targetRoot || !isSafeWorkspaceRoot(sourceRoot) || !isSafeWorkspaceRoot(targetRoot)) {
		throw new Error("Workspace path is not available or safe");
	}
	const activity = getWorkspaceFileActivities(input.dataDir, {
		sessionId: input.sessionId,
		workspaceId: sourceWorkspace.id,
		workspaceRoot: sourceRoot,
		hasSessionHistory: sourceHistoryExists(input.sessionPath),
	});
	const files = activity.files
		.map((entry) => {
			const inspected = inspectSourceFile(sourceRoot, entry.path);
			return {
				path: inspected.path,
				access: entry.access,
				exists: inspected.exists,
				selectable: inspected.selectable,
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
	return {
		sourceWorkspace,
		targetWorkspace,
		files,
		trackingIncomplete: activity.trackingIncomplete,
	};
}

function ensureSafeTargetParent(rootDir: string, path: string): string | null {
	const fullPath = resolveContainedPath(rootDir, path);
	if (!fullPath) return null;
	try {
		mkdirSync(dirname(fullPath), { recursive: true });
	} catch {
		return null;
	}
	const verifiedParent = resolveContainedPath(rootDir, dirname(path));
	return verifiedParent ? fullPath : null;
}

function targetConflictOrUnsafe(rootDir: string, path: string): "conflict" | "unsafe" | null {
	const target = safeJoinReal(rootDir, path);
	if (!target) return "unsafe";
	try {
		const stat = lstatSync(target);
		if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
		return "conflict";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? null : "unsafe";
	}
}

function fileResult(
	path: string,
	access: WorkspaceFileAccess,
	action: TransferAction,
	status: WorkspaceSwitchFileStatus,
	error?: string,
	copied = false,
): WorkspaceSwitchFileResult {
	return {
		path,
		access,
		action,
		status,
		...(error === undefined ? {} : { error }),
		...(copied ? { copied: true } : {}),
	};
}

export function transferWorkspaceFiles(input: {
	preview: WorkspaceSwitchPreview;
	sourceRoot: string;
	targetRoot: string;
	fileActions: Record<string, WorkspaceSwitchFileAction>;
}): WorkspaceSwitchFileResult[] {
	const allowed = new Map(input.preview.files.filter((file) => file.selectable).map((file) => [file.path, file]));
	const entries = Object.entries(input.fileActions)
		.filter(([, action]) => action !== "none")
		.map(([rawPath, action]) => [rawPath, action as TransferAction, normalizeTransferPath(rawPath)] as const);
	if (!isSafeWorkspaceRoot(input.sourceRoot) || !isSafeWorkspaceRoot(input.targetRoot)) {
		return entries.map(([rawPath, action, path]) => {
			const access = path ? (allowed.get(path)?.access ?? "read") : "read";
			return fileResult(
				path ?? rawPath,
				access,
				action,
				"failed",
				"Source or target workspace root is unsafe or unavailable",
			);
		});
	}
	return entries.map(([rawPath, action, path]) => {
		const previewFile = path ? allowed.get(path) : undefined;
		if (!path || !previewFile) {
			return fileResult(path ?? rawPath, previewFile?.access ?? "read", action, "failed", "File is not an existing selectable file from the switch preview");
		}
		const source = inspectSourceFile(input.sourceRoot, path);
		if (!source.exists || !source.fullPath) return fileResult(path, previewFile.access, action, "missing", "Source file no longer exists");
		if (!source.selectable) return fileResult(path, previewFile.access, action, "failed", source.reason ?? "Source is not a regular file");
		const targetStatus = targetConflictOrUnsafe(input.targetRoot, path);
		if (targetStatus === "conflict") return fileResult(path, previewFile.access, action, "conflict", "Target file already exists");
		if (targetStatus === "unsafe") return fileResult(path, previewFile.access, action, "failed", "Target path is unsafe or not a regular file");

		const target = ensureSafeTargetParent(input.targetRoot, path);
		if (!target) return fileResult(path, previewFile.access, action, "failed", "Target directory is unsafe or cannot be created");
		try {
			copyFileSync(source.fullPath, target, constants.COPYFILE_EXCL);
			const copiedStat = lstatSync(target);
			if (!copiedStat.isFile()) throw new Error("Target copy is not a regular file");
			if (action === "copy") return fileResult(path, previewFile.access, action, "copied");
			try {
				unlinkSync(source.fullPath);
			} catch (error) {
				return fileResult(path, previewFile.access, action, "failed", error instanceof Error ? `Copied, but source deletion failed: ${error.message}` : "Copied, but source deletion failed", true);
			}
			return fileResult(path, previewFile.access, action, "moved");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") return fileResult(path, previewFile.access, action, "conflict", "Target file already exists");
			return fileResult(path, previewFile.access, action, "failed", error instanceof Error ? error.message : "File operation failed");
		}
	});
}

export function workspaceSwitchStatistics(files: WorkspaceSwitchFileResult[]): {
	success: number;
	conflicts: number;
	failures: number;
	missing: number;
	selected: number;
} {
	return {
		success: files.filter((file) => file.status === "copied" || file.status === "moved").length,
		conflicts: files.filter((file) => file.status === "conflict").length,
		failures: files.filter((file) => file.status === "failed").length,
		missing: files.filter((file) => file.status === "missing").length,
		selected: files.length,
	};
}
