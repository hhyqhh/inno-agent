import { execFile, spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { applyWorkspaceCwd, getCurrentSessionId } from "../../agent/pi-runner.js";
import { streamRegistry } from "../../chat/stream-registry.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { ensureDir } from "../../storage/file-store.js";
import { isWithin } from "../../utils/path-safety.js";
import { TEMP_WORKSPACE_ID, type WorkspaceMeta, type WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import {
	canonicalTreeRoot,
	contentDispositionAttachment,
	contentTypeForWorkspaceFile,
	officeFormat,
	safeJoinReal,
	workspaceFileKind,
	normalizeWorkspaceRelativePath,
	WORKSPACE_IGNORES,
	WORKSPACE_TREE_MAX_DEPTH,
	type WorkspaceTreeNode,
} from "../file-helpers.js";
import {
	buildWorkspaceSwitchPreview,
	isSwitchableWorkspace,
	transferWorkspaceFiles,
	workspaceSwitchStatistics,
	type WorkspaceSwitchFileAction,
} from "../workspace-switch.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

/**
 * Server-owned dependencies the workspace routes touch. `workspaceRegistry`
 * is the live singleton; the skill installers close over server module state
 * (skillsDir default), so they are injected rather than imported.
 */
export interface WorkspacesRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	dataDir: string;
	paths: RuntimePaths;
	installSkillZip: (fileName: string, data: Buffer, targetRoot?: string) => { name: string; filePath: string };
	installSkillMarkdown: (fileName: string, data: Buffer, targetRoot?: string) => { name: string; filePath: string };
	importWorkspaceZip: (fileName: string, data: Buffer, name?: string) => WorkspaceMeta;
	scheduleSkillsReload: () => void;
	sessionFileFromId: (sessionDir: string, id: string) => string | null;
	releaseQueueFromQuestionBlockedTurn: (sessionId: string) => void;
	runQueueOpWithTimeout: <T>(
		req: HttpReq,
		res: ServerResponse,
		op: (signal: AbortSignal) => Promise<T>,
		timeoutMs?: number,
	) => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split)
// ---------------------------------------------------------------------------

function workspaceIdFromQuery(url: string): string {
	try {
		const params = new URL(url, "http://localhost").searchParams;
		const id = params.get("workspaceId");
		return id && id.trim() ? id.trim() : TEMP_WORKSPACE_ID;
	} catch (err) {
		return TEMP_WORKSPACE_ID;
	}
}

function workspaceIdFromBody(body: Record<string, unknown>): string {
	const id = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
	return id || TEMP_WORKSPACE_ID;
}

/** Per-workspace private skills directory (matches inno-extension WORKSPACE_SKILLS_DIR). */
const WORKSPACE_PRIVATE_SKILLS_DIR = ".skills";

function workspaceRelativePath(rootDir: string, filePath: string): string {
	return relative(rootDir, filePath) || "";
}

/** Build a tree node for an installed private skill directory under `<root>/.skills`. */
function workspaceSkillNode(root: string, skillName: string): { name: string; path: string; type: string; size: number; updatedAt: string } {
	const dir = join(root, WORKSPACE_PRIVATE_SKILLS_DIR, skillName);
	const stat = statSync(dir);
	return {
		name: skillName,
		path: workspaceRelativePath(root, dir),
		type: "directory",
		size: stat.size,
		updatedAt: stat.mtime.toISOString(),
	};
}

// Deep enough to cover nested output conventions (e.g. skill runs that nest
// <skill>/<slug>/<timestamp>/<artifact>/<file>), while still bounded so a
// pathological tree cannot hang the request.
function readWorkspaceTree(rootDir: string, dir: string, depth = 0, seen: ReadonlySet<string> = new Set()): WorkspaceTreeNode[] {
	if (depth > WORKSPACE_TREE_MAX_DEPTH) return [];
	const realRoot = canonicalTreeRoot(rootDir);
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => !WORKSPACE_IGNORES.has(entry.name))
		.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
		.slice(0, 200)
		.map((entry): WorkspaceTreeNode | null => {
			const fullPath = join(dir, entry.name);
			// statSync follows symlinks, so a directory symlink (e.g. a `latest`
			// pointer) resolves to its target type. A broken symlink throws here
			// and is skipped instead of crashing the whole tree with a 500.
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(fullPath);
			} catch {
				return null;
			}
			const isDir = stat.isDirectory();
			const node: WorkspaceTreeNode = {
				name: entry.name,
				path: workspaceRelativePath(rootDir, fullPath),
				type: isDir ? "directory" : "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			};
			if (isDir) {
				// Resolve the real path to (a) keep symlink traversal inside the
				// workspace root and (b) guard against symlink cycles.
				let real: string;
				try {
					real = realpathSync(fullPath);
				} catch {
					real = fullPath;
				}
				const withinRoot = isWithin(realRoot, real);
				node.children = withinRoot && !seen.has(real)
					? readWorkspaceTree(rootDir, fullPath, depth + 1, new Set([...seen, real]))
					: [];
			}
			return node;
		})
		.filter((node): node is WorkspaceTreeNode => node !== null);
}

/**
 * Zip a directory and return the archive as a Buffer.
 *
 * Uses the system `zip` on macOS/Linux and PowerShell `Compress-Archive` on
 * Windows so we avoid pulling in a new dependency. The archive is built in a
 * temp dir and read back into memory (workspace folders are expected to be
 * small enough for an in-memory download).
 */
function zipDirectory(dirPath: string): Buffer {
	const tempRoot = join(tmpdir(), `inno-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, "archive.zip");
	ensureDir(tempRoot);
	try {
		if (process.platform === "win32") {
			const ps = `Compress-Archive -Path '${dirPath.replace(/'/g, "''")}\\*' ` +
				`-DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
			const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		} else {
			// `-r` recurse, run inside the dir so paths are relative to it.
			// `-y` stores symlinks as links: without it zip dereferences them,
			// so a symlink planted inside the workspace would leak the linked
			// host files into the archive.
			const result = spawnSync("/usr/bin/zip", ["-r", "-y", "-q", zipPath, "."], { cwd: dirPath, encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		}
		return readFileSync(zipPath);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// --- PPTX → SVG conversion (pure-Python converter, no LibreOffice) ---
const PPTX_TIMEOUT_MS = 60_000;
const MAX_PPTX_SLIDES = 200;
const MAX_PPTX_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);
let cachedPythonExe: string | null | undefined;

/** Absolute path to the vendored pptx_to_svg CLI (dev = repo, prod = bundled). */
function pptxScriptPath(codeDir: string): string {
	// In a packaged Electron app, codeDir points inside app.asar but the script
	// is unpacked (asarUnpack) to app.asar.unpacked — Python can't read asar.
	const base = codeDir.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
	return join(base, "scripts", "pptx_to_svg.py");
}

/** Resolve a usable Python executable, caching the result. */
function resolvePythonExecutable(): string | null {
	if (cachedPythonExe !== undefined) return cachedPythonExe;
	const candidates: string[] = [];
	const override = process.env.INNO_PYTHON?.trim();
	if (override) candidates.push(override);
	// On Windows the launcher is usually `python`; elsewhere prefer `python3`.
	if (process.platform === "win32") candidates.push("python", "python3");
	else candidates.push("python3", "python");
	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
			if (!probe.error && probe.status === 0) {
				cachedPythonExe = candidate;
				return candidate;
			}
		} catch {
			// try next candidate
		}
	}
	cachedPythonExe = null;
	return null;
}

interface PptxSvgSlide {
	index: number;
	svg: string;
}

interface PptxConvertResult {
	slides: PptxSvgSlide[];
	canvasPx?: [number, number];
}

/**
 * Convert a .pptx to per-slide SVG strings via the vendored Python converter.
 * Runs asynchronously (never blocks the HTTP loop) and always cleans up its
 * temp directory. Throws on failure so the caller can return a 422 fallback.
 */
async function convertPptxToSvg(codeDir: string, filePath: string): Promise<PptxConvertResult> {
	const python = resolvePythonExecutable();
	if (!python) {
		throw new Error("Python is not available; set INNO_PYTHON or install python3");
	}
	const script = pptxScriptPath(codeDir);
	if (!existsSync(script)) {
		throw new Error(`pptx converter not found at ${script}`);
	}
	const outDir = join(tmpdir(), `inno-pptx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	ensureDir(outDir);
	try {
		const { stdout } = await execFileAsync(
			python,
			[script, filePath, "--embed-images", "--inheritance-mode", "flat", "-o", outDir],
			{ timeout: PPTX_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
		);
		const svgDir = join(outDir, "svg");
		if (!existsSync(svgDir)) {
			throw new Error("converter produced no output");
		}
		const files = readdirSync(svgDir)
			.filter((f) => /^slide_\d+\.svg$/i.test(f))
			.sort((a, b) => {
				const na = Number(a.match(/\d+/)?.[0] ?? 0);
				const nb = Number(b.match(/\d+/)?.[0] ?? 0);
				return na - nb;
			});
		const slides: PptxSvgSlide[] = [];
		for (const file of files.slice(0, MAX_PPTX_SLIDES)) {
			const index = Number(file.match(/\d+/)?.[0] ?? slides.length + 1);
			slides.push({ index, svg: readFileSync(join(svgDir, file), "utf-8") });
		}
		if (slides.length === 0) {
			throw new Error("converter produced no slides");
		}
		let canvasPx: [number, number] | undefined;
		const match = /Canvas:\s*([\d.]+)\s*x\s*([\d.]+)\s*px/i.exec(stdout);
		if (match) canvasPx = [Number(match[1]), Number(match[2])];
		return { slides, canvasPx };
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * /api/workspace/*, /api/workspaces* and /api/sessions/:id/workspace route
 * domain. Returns true when the request was handled. Extracted verbatim from
 * server.ts during the P2 route split — behavior unchanged. (The workspaces
 * registry and session-binding routes previously lived ~400 lines below the
 * file routes; exact-path matching makes the reordering inert.)
 */
export async function handleWorkspacesRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: WorkspacesRouteContext,
): Promise<boolean> {
	const {
		workspaceRegistry,
		dataDir,
		paths,
		installSkillZip,
		installSkillMarkdown,
		importWorkspaceZip,
		scheduleSkillsReload,
		sessionFileFromId,
		releaseQueueFromQuestionBlockedTurn,
		runQueueOpWithTimeout,
	} = ctx;

	// safeWorkspacePath closed over server.ts's module-level workspaceRegistry;
	// rebind it to the injected registry here so the route bodies stay verbatim.
	// safeJoinReal (not plain safeJoin): a symlink planted inside the workspace
	// must not let these endpoints read/write files outside it.
	const safeWorkspacePath = (workspaceId: string | null | undefined, userPath: string): string | null => {
		const root = workspaceRegistry.resolveWorkspaceDir(workspaceId ?? TEMP_WORKSPACE_ID);
		if (!root) return null;
		const normalizedPath = normalizeWorkspaceRelativePath(userPath);
		// A workspace path may have a harmless `./` prefix, but a leading `/`
		// (or a Windows drive prefix) is an absolute path and must not be turned
		// into a relative path by the API boundary.
		if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) return null;
		return safeJoinReal(root, normalizedPath);
	};
	const sessionPathForSwitch = (sessionId: string): string | null => {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return null;
		}
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot rebind a session with an active chat turn" });
			return null;
		}
		return sessionPath;
	};
	const isAvailableSwitchTarget = (workspaceId: string): boolean => {
		if (isSwitchableWorkspace(workspaceRegistry.getWorkspace(workspaceId))) return true;
		json(res, 404, { error: "Target workspace not found or unavailable" });
		return false;
	};

	// --- Workspace API ---
	if (method === "GET" && url.split("?")[0] === "/api/workspace/tree") {
		const wsId = workspaceIdFromQuery(url);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		ensureDir(root);
		const stat = statSync(root);
		json(res, 200, {
			root,
			workspaceId: wsId,
			name: basename(root),
			path: "",
			type: "directory",
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
			children: readWorkspaceTree(root, root),
		});
		return true;
	}

	if (method === "GET" && url.startsWith("/api/workspace/file?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const filePath = safeWorkspacePath(wsId, requestedPath);
		if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		const stat = statSync(filePath);
		const kind = workspaceFileKind(filePath);
		const contentType = contentTypeForWorkspaceFile(filePath);
		const forceText = params.get("forceText") === "1";
		if (!forceText && (kind === "binary" || kind === "pdf" || kind === "image" || kind === "office")) {
			const relPath = workspaceRelativePath(root, filePath);
			const rawUrl = `/api/workspace/raw?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`;
			const format = kind === "office" ? officeFormat(filePath) : undefined;
			// pptx is rendered as SVG via the Python converter; docx/xlsx are
			// rendered client-side from the raw bytes, so they need no previewUrl.
			let previewUrl: string | undefined;
			if (format === "pptx") {
				previewUrl = `/api/workspace/pptx-preview?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`;
			}
			json(res, 200, {
				path: relPath,
				name: basename(filePath),
				kind,
				format,
				mimeType: contentType,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
				url: rawUrl,
				previewUrl,
			});
			return true;
		}
		if (stat.size > 1024 * 1024) {
			json(res, 413, { error: "File is too large to preview as text" });
			return true;
		}
		json(res, 200, {
			path: workspaceRelativePath(root, filePath),
			name: basename(filePath),
			kind: forceText ? "text" : kind,
			mimeType: forceText ? "text/plain; charset=utf-8" : contentType,
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
			content: readFileSync(filePath, "utf-8"),
		});
		return true;
	}

	if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/raw?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wantsDownload = params.get("download") === "1";
		const wsId = workspaceIdFromQuery(url);
		const filePath = safeWorkspacePath(wsId, requestedPath);
		if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		const content = readFileSync(filePath);
		const headers: Record<string, string | number> = {
			"Content-Type": contentTypeForWorkspaceFile(filePath),
			"Content-Length": content.length,
			"Cache-Control": "no-store",
		};
		if (wantsDownload) {
			headers["Content-Disposition"] = contentDispositionAttachment(basename(filePath));
		}
		res.writeHead(200, headers);
		res.end(method === "GET" ? content : undefined);
		return true;
	}

	// Download a directory as a zip archive.
	if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/download-folder?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		// Empty path → zip the whole workspace root.
		const dirPath = requestedPath ? safeWorkspacePath(wsId, requestedPath) : root;
		if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
			json(res, 404, { error: "Workspace folder not found" });
			return true;
		}
		const archiveName = `${basename(dirPath) || basename(root) || "workspace"}.zip`;
		if (method === "HEAD") {
			res.writeHead(200, {
				"Content-Type": "application/zip",
				"Content-Disposition": contentDispositionAttachment(archiveName),
				"Cache-Control": "no-store",
			});
			res.end();
			return true;
		}
		try {
			const zipData = zipDirectory(dirPath);
			res.writeHead(200, {
				"Content-Type": "application/zip",
				"Content-Length": zipData.length,
				"Content-Disposition": contentDispositionAttachment(archiveName),
				"Cache-Control": "no-store",
			});
			res.end(zipData);
		} catch (err) {
			logger.error({ err }, "failed to create zip archive");
			json(res, 500, { error: err instanceof Error ? err.message : "Failed to create zip archive" });
		}
		return true;
	}

	// Extract text from office documents (docx/xlsx/pptx) for in-browser preview.
	if (method === "GET" && url.startsWith("/api/workspace/office-preview?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		const filePath = safeWorkspacePath(wsId, requestedPath);
		if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		try {
			const { parseDocument } = await import("../../memory/l2/document-parser.js");
			const parsed = await parseDocument(filePath);
			json(res, 200, {
				name: basename(filePath),
				pageCount: parsed.pageCount,
				text: parsed.text,
				pages: parsed.pages,
			});
		} catch (err) {
			logger.warn({ err }, "failed to parse office document");
			json(res, 422, { error: err instanceof Error ? err.message : "Failed to parse document" });
		}
		return true;
	}

	// Render a .pptx as per-slide SVG via the vendored Python converter.
	if (method === "GET" && url.startsWith("/api/workspace/pptx-preview?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		const filePath = safeWorkspacePath(wsId, requestedPath);
		if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		if (statSync(filePath).size > MAX_PPTX_BYTES) {
			json(res, 413, { error: "Presentation is too large to preview" });
			return true;
		}
		try {
			const result = await convertPptxToSvg(paths.codeDir, filePath);
			json(res, 200, {
				name: basename(filePath),
				slideCount: result.slides.length,
				slides: result.slides,
				canvasPx: result.canvasPx,
			});
		} catch (err) {
			logger.warn({ err }, "failed to convert pptx to svg");
			json(res, 422, {
				error: err instanceof Error ? err.message : "Failed to render presentation",
				code: "PPTX_CONVERT_FAILED",
			});
		}
		return true;
	}

	// --- Workspace Mutations API ---

	if (method === "PUT" && url === "/api/workspace/file") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const filePath = typeof body.path === "string" ? body.path.trim() : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!filePath) { json(res, 400, { error: "Missing path" }); return true; }
		const fullPath = safeWorkspacePath(wsId, filePath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" }); return true;
		}
		writeFileSync(fullPath, content, "utf-8");
		const stat = statSync(fullPath);
		json(res, 200, { path: filePath, saved: true, size: stat.size, updatedAt: stat.mtime.toISOString() });
		return true;
	}

	if (method === "POST" && url === "/api/workspace/create") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const itemPath = typeof body.path === "string" ? body.path.trim() : "";
		const itemType = body.type === "directory" ? "directory" : "file";
		if (!itemPath) { json(res, 400, { error: "Missing path" }); return true; }
		const fullPath = safeWorkspacePath(wsId, itemPath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (existsSync(fullPath)) { json(res, 409, { error: "Already exists" }); return true; }
		if (itemType === "directory") {
			mkdirSync(fullPath, { recursive: true });
		} else {
			ensureDir(dirname(fullPath));
			writeFileSync(fullPath, "");
		}
		const stat = statSync(fullPath);
		json(res, 201, {
			name: basename(fullPath),
			path: workspaceRelativePath(root, fullPath),
			type: itemType,
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/rename") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const oldPath = typeof body.oldPath === "string" ? body.oldPath.trim() : "";
		const newPath = typeof body.newPath === "string" ? body.newPath.trim() : "";
		if (!oldPath || !newPath) { json(res, 400, { error: "Missing oldPath or newPath" }); return true; }
		if (oldPath === newPath) { json(res, 400, { error: "Paths are identical" }); return true; }
		const fullOld = safeWorkspacePath(wsId, oldPath);
		const fullNew = safeWorkspacePath(wsId, newPath);
		if (!fullOld || !fullNew) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullOld)) { json(res, 404, { error: "Source not found" }); return true; }
		if (existsSync(fullNew)) { json(res, 409, { error: "Target already exists" }); return true; }
		ensureDir(dirname(fullNew));
		renameSync(fullOld, fullNew);
		const stat = statSync(fullNew);
		json(res, 200, {
			name: basename(fullNew),
			path: workspaceRelativePath(root, fullNew),
			type: stat.isDirectory() ? "directory" : "file",
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/delete") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const itemPath = typeof body.path === "string" ? body.path.trim() : "";
		if (!itemPath) { json(res, 400, { error: "Cannot delete workspace root" }); return true; }
		const fullPath = safeWorkspacePath(wsId, itemPath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullPath)) { json(res, 404, { error: "Not found" }); return true; }
		rmSync(fullPath, { recursive: true, force: true });
		json(res, 200, { deleted: true, path: itemPath });
		return true;
	}

	if (method === "POST" && url === "/api/workspace/move") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
		const targetDir = typeof body.targetDir === "string" ? body.targetDir.trim() : "";
		if (!sourcePath) { json(res, 400, { error: "Missing sourcePath" }); return true; }
		const fullSource = safeWorkspacePath(wsId, sourcePath);
		const fullTargetDir = targetDir ? safeWorkspacePath(wsId, targetDir) : root;
		if (!fullSource || !fullTargetDir) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullSource)) { json(res, 404, { error: "Source not found" }); return true; }
		const newFullPath = join(fullTargetDir, basename(fullSource));
		if (existsSync(newFullPath)) { json(res, 409, { error: "Target already exists" }); return true; }
		ensureDir(fullTargetDir);
		renameSync(fullSource, newFullPath);
		const stat = statSync(newFullPath);
		json(res, 200, {
			name: basename(newFullPath),
			path: workspaceRelativePath(root, newFullPath),
			type: stat.isDirectory() ? "directory" : "file",
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/upload") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const files = Array.isArray(body.files) ? body.files : [];
		if (!files.length) { json(res, 400, { error: "No files provided" }); return true; }
		const uploaded: Array<{ name: string; path: string; type: string; size: number; updatedAt: string }> = [];
		let installedSkill = false;
		for (const entry of files) {
			const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
			const dataBase64 = typeof entry.dataBase64 === "string" ? entry.dataBase64 : "";
			if (!filePath || !dataBase64) continue;
			const fullPath = safeWorkspacePath(wsId, filePath);
			if (!fullPath) continue;
			const data = Buffer.from(dataBase64, "base64");
			const ext = extname(filePath).toLowerCase();

			// A .zip or .md dropped into the workspace's private skills dir is
			// installed as a skill (zip is extracted) rather than written raw.
			if (filePath.split("/").includes(WORKSPACE_PRIVATE_SKILLS_DIR) && (ext === ".zip" || ext === ".md")) {
				// The install target must really be `<root>/.skills` — a symlink
				// planted at `.skills` would make the installer delete/overwrite
				// a directory outside the workspace.
				const skillsRoot = safeWorkspacePath(wsId, WORKSPACE_PRIVATE_SKILLS_DIR);
				if (!skillsRoot) { json(res, 400, { error: "Invalid skills directory" }); return true; }
				try {
					const skill = ext === ".zip"
						? installSkillZip(basename(filePath), data, skillsRoot)
						: installSkillMarkdown(basename(filePath), data, skillsRoot);
					uploaded.push(workspaceSkillNode(root, skill.name));
					installedSkill = true;
					continue;
				} catch (err) {
					logger.error({ err }, "failed to install skill package during upload");
					json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
					return true;
				}
			}

			ensureDir(dirname(fullPath));
			writeFileSync(fullPath, data);
			const stat = statSync(fullPath);
			uploaded.push({
				name: basename(fullPath),
				path: workspaceRelativePath(root, fullPath),
				type: "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
		}
		if (installedSkill) scheduleSkillsReload();
		json(res, 201, { uploaded });
		return true;
	}

	// Install a skill package (.zip / .md) into the workspace's private .skills dir.
	if (method === "POST" && url === "/api/workspace/skills/upload") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const wsId = workspaceIdFromBody(body);
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) { json(res, 400, { error: "Missing fileName or dataBase64" }); return true; }
		const ext = extname(fileName).toLowerCase();
		if (ext !== ".zip" && ext !== ".md") { json(res, 400, { error: "Only .zip or .md skill packages are supported" }); return true; }
		const data = Buffer.from(dataBase64, "base64");
		// Guard the install target: a symlink planted at `.skills` would make the
		// installer delete/overwrite a directory outside the workspace.
		const skillsRoot = safeWorkspacePath(wsId, WORKSPACE_PRIVATE_SKILLS_DIR);
		if (!skillsRoot) { json(res, 400, { error: "Invalid skills directory" }); return true; }
		try {
			const skill = ext === ".zip"
				? installSkillZip(fileName, data, skillsRoot)
				: installSkillMarkdown(fileName, data, skillsRoot);
			scheduleSkillsReload();
			json(res, 201, workspaceSkillNode(root, skill.name));
		} catch (err) {
			logger.error({ err }, "failed to install workspace skill package");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
		}
		return true;
	}

	// --- Workspaces registry API ---
	if (method === "GET" && url === "/api/workspaces") {
		const sessionDir = join(dataDir, "sessions");
		const allSessionIds = existsSync(sessionDir)
			? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
			: [];
		json(res, 200, workspaceRegistry.listWorkspaces(allSessionIds));
		return true;
	}

	if (method === "POST" && url === "/api/workspaces") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name : undefined;
		const isTemp = Boolean(body.isTemp);
		try {
			const ws = workspaceRegistry.createWorkspace({ name, isTemp });
			json(res, 201, ws);
		} catch (err) {
			logger.error({ err }, "failed to create workspace");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to create workspace" });
		}
		return true;
	}

	// Import a workspace from a zip archive (e.g. an exported preset workspace
	// bundle): extracts the archive and seeds a fresh workspace with its files.
	if (method === "POST" && url === "/api/workspaces/import") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		const name = typeof body.name === "string" ? body.name : undefined;
		if (!fileName || !dataBase64) { json(res, 400, { error: "Missing fileName or dataBase64" }); return true; }
		if (extname(fileName).toLowerCase() !== ".zip") {
			json(res, 400, { error: "Only .zip workspace archives are supported" });
			return true;
		}
		try {
			const ws = importWorkspaceZip(fileName, Buffer.from(dataBase64, "base64"), name);
			json(res, 201, ws);
		} catch (err) {
			logger.error({ err }, "failed to import workspace archive");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to import workspace archive" });
		}
		return true;
	}

	const workspacePatchMatch = matchRoute("PATCH", method, url, "/api/workspaces/:id");
	if (workspacePatchMatch) {
		const body = (await readBody(req)) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name : "";
		if (!name.trim()) { json(res, 400, { error: "Missing name" }); return true; }
		const updated = workspaceRegistry.renameWorkspace(decodeURIComponent(workspacePatchMatch.id), name);
		if (!updated) { json(res, 404, { error: "Workspace not found" }); return true; }
		json(res, 200, updated);
		return true;
	}

	const workspaceDeleteMatch = matchRoute("DELETE", method, url.split("?")[0], "/api/workspaces/:id");
	if (workspaceDeleteMatch) {
		const id = decodeURIComponent(workspaceDeleteMatch.id);
		if (streamRegistry.getActiveForWorkspace(id)) {
			json(res, 409, { error: "Cannot delete a workspace with an active chat turn" });
			return true;
		}
		if (id === TEMP_WORKSPACE_ID) {
			json(res, 400, { error: "Cannot delete the shared tmp workspace" });
			return true;
		}
		const params = new URL(url, "http://localhost").searchParams;
		const removeFiles = params.get("removeFiles") === "1" || params.get("removeFiles") === "true";
		const ok = workspaceRegistry.deleteWorkspace(id, { removeFiles });
		if (!ok) { json(res, 404, { error: "Workspace not found" }); return true; }
		json(res, 200, { id, deleted: true, removedFiles: removeFiles });
		return true;
	}

	// --- Session ↔ workspace binding ---
	const sessionWorkspaceSwitchPreviewMatch = matchRoute("GET", method, url, "/api/sessions/:id/workspace/switch-preview");
	if (sessionWorkspaceSwitchPreviewMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceSwitchPreviewMatch.id);
		const sessionPath = sessionPathForSwitch(sessionId);
		if (!sessionPath) return true;
		const targetWorkspaceId = new URL(url, "http://localhost").searchParams.get("targetWorkspaceId")?.trim() ?? "";
		if (!targetWorkspaceId) {
			json(res, 400, { error: "Missing targetWorkspaceId" });
			return true;
		}
		if (!isAvailableSwitchTarget(targetWorkspaceId)) return true;
		try {
			const preview = buildWorkspaceSwitchPreview({
				dataDir,
				sessionId,
				sessionPath,
				workspaceRegistry,
				targetWorkspaceId,
			});
			json(res, 200, preview);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Unable to preview workspace switch" });
		}
		return true;
	}

	const sessionWorkspaceSwitchMatch = matchRoute("POST", method, url, "/api/sessions/:id/workspace/switch");
	if (sessionWorkspaceSwitchMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceSwitchMatch.id);
		const sessionPath = sessionPathForSwitch(sessionId);
		if (!sessionPath) return true;
		const body = (await readBody(req)) as Record<string, unknown>;
		const targetWorkspaceId = typeof body.targetWorkspaceId === "string" ? body.targetWorkspaceId.trim() : "";
		if (!targetWorkspaceId) {
			json(res, 400, { error: "targetWorkspaceId is required" });
			return true;
		}
		if (!body.fileActions || typeof body.fileActions !== "object" || Array.isArray(body.fileActions)) {
			json(res, 400, { error: "fileActions must be an object mapping relative paths to move|copy|none" });
			return true;
		}
		const entries = Object.entries(body.fileActions as Record<string, unknown>);
		if (entries.some(([path, action]) => !path.trim() || (action !== "move" && action !== "copy" && action !== "none"))) {
			json(res, 400, { error: "fileActions must contain only relative paths and move|copy|none actions" });
			return true;
		}
		const fileActions = Object.fromEntries(entries) as Record<string, WorkspaceSwitchFileAction>;
		const sourceWorkspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
		if (sourceWorkspaceId === targetWorkspaceId) {
			json(res, 409, { error: "Session is already bound to this workspace" });
			return true;
		}
		if (!isAvailableSwitchTarget(targetWorkspaceId)) return true;
		const sourceRoot = workspaceRegistry.resolveWorkspaceDir(sourceWorkspaceId);
		const targetRoot = workspaceRegistry.resolveWorkspaceDir(targetWorkspaceId);
		if (!sourceRoot || !targetRoot) {
			json(res, 404, { error: "Workspace path is not available" });
			return true;
		}
		let preview;
		try {
			preview = buildWorkspaceSwitchPreview({
				dataDir,
				sessionId,
				sessionPath,
				workspaceRegistry,
				targetWorkspaceId,
			});
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Unable to validate workspace switch" });
			return true;
		}

		// Bind before touching any file. If the live agent cannot adopt the new
		// cwd, restore the old binding and leave both workspaces untouched.
		if (!workspaceRegistry.bindSession(sessionId, targetWorkspaceId)) {
			json(res, 404, { error: "Target workspace not found" });
			return true;
		}
		if (getCurrentSessionId() === sessionId) {
			releaseQueueFromQuestionBlockedTurn(sessionId);
			try {
				const applied = await runQueueOpWithTimeout(req, res, (signal) => {
					const currentPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
					if (!currentPath) throw new Error("Session not found");
					return applyWorkspaceCwd(currentPath, { signal });
				});
				if (applied === null) {
					workspaceRegistry.bindSession(sessionId, sourceWorkspaceId);
					return true;
				}
			} catch (err) {
				workspaceRegistry.bindSession(sessionId, sourceWorkspaceId);
				json(res, 500, { error: err instanceof Error ? err.message : "Failed to bind target workspace" });
				return true;
			}
		}

		const files = transferWorkspaceFiles({ preview, sourceRoot, targetRoot, fileActions });
		json(res, 200, {
			switched: true,
			sessionId,
			sourceWorkspace: preview.sourceWorkspace,
			targetWorkspace: preview.targetWorkspace,
			files,
			statistics: workspaceSwitchStatistics(files),
			trackingIncomplete: preview.trackingIncomplete,
		});
		return true;
	}

	const sessionWorkspaceGetMatch = matchRoute("GET", method, url, "/api/sessions/:id/workspace");
	if (sessionWorkspaceGetMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceGetMatch.id);
		const workspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
		const ws = workspaceRegistry.getWorkspace(workspaceId);
		json(res, 200, { sessionId, workspaceId, workspace: ws });
		return true;
	}

	const sessionWorkspacePutMatch = matchRoute("PUT", method, url, "/api/sessions/:id/workspace");
	if (sessionWorkspacePutMatch) {
		const sessionId = decodeURIComponent(sessionWorkspacePutMatch.id);
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot rebind a session with an active chat turn" });
			return true;
		}
		const body = (await readBody(req)) as Record<string, unknown>;
		const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		if (!workspaceId) { json(res, 400, { error: "Missing workspaceId" }); return true; }
		const ok = workspaceRegistry.bindSession(sessionId, workspaceId);
		if (!ok) { json(res, 404, { error: "Workspace not found" }); return true; }
		// If the rebinding affects the currently active session, refresh agent cwd.
		if (getCurrentSessionId() === sessionId) {
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
			if (sessionPath) {
				releaseQueueFromQuestionBlockedTurn(sessionId);
				const applied = await runQueueOpWithTimeout(req, res, (signal) => applyWorkspaceCwd(sessionPath, { signal }));
				if (applied === null) return true; // 409 session_busy already sent (or client gone)
			}
		}
		json(res, 200, { sessionId, workspaceId });
		return true;
	}

	return false;
}
