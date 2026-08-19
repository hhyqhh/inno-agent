import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { logger } from "../../logger.js";
import type { SkillLibraryItem } from "../../content-source/types.js";
import { isWithin } from "../../utils/path-safety.js";
import {
	canonicalTreeRoot,
	contentTypeForWorkspaceFile,
	safeJoinReal,
	slugifySkillName,
	workspaceFileKind,
	WORKSPACE_TREE_MAX_DEPTH,
	type WorkspaceTreeNode,
} from "../file-helpers.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

/**
 * Skill-management dependencies owned by server.ts. These helpers close over
 * server module state (skillsDir, configDir, the content source), so they are
 * injected rather than imported. A later split step may move them into a
 * shared skill-store module; until then this ctx keeps the route domain
 * behavior-identical.
 */
export interface SkillsRouteContext {
	skillsDir: string;
	scheduleSkillsReload: () => void;
	listProjectSkills: () => unknown[];
	setSkillEnabled: (name: string, enabled: boolean) => void;
	installSkillZip: (fileName: string, data: Buffer) => { name: string; filePath: string };
	installSkillMarkdown: (fileName: string, data: Buffer) => { name: string; filePath: string };
	listSkillLibrary: (forceRefresh?: boolean) => Promise<SkillLibraryItem[]>;
	importSkillFromLibrary: (name: string) => Promise<{ name: string; filePath: string }>;
}

/**
 * /api/skills* and /api/skill-library* route domain. Returns true when the
 * request was handled. Extracted verbatim from server.ts during the P2 route
 * split — behavior unchanged.
 */
export async function handleSkillsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SkillsRouteContext,
): Promise<boolean> {
	const { skillsDir } = ctx;

	if (method === "GET" && url === "/api/skills") {
		// Do not call reloadResources() here — it is queued behind the agent
		// loop, so it stalls while an LLM turn is streaming. Listing from
		// disk is enough for displaying the panel.
		json(res, 200, ctx.listProjectSkills());
		return true;
	}

	if (method === "POST" && url === "/api/skills/upload") {
		const body = (await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES })) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) {
			json(res, 400, { error: "Missing fileName or dataBase64" });
			return true;
		}
		const data = Buffer.from(dataBase64, "base64");
		const ext = extname(fileName).toLowerCase();
		const skill = ext === ".zip"
			? ctx.installSkillZip(fileName, data)
			: ctx.installSkillMarkdown(fileName, data);
		ctx.setSkillEnabled(skill.name, true);
		const installed = ctx.listProjectSkills().find((entry) => (entry as { name: string }).name === skill.name);
		json(res, 201, installed ?? { name: skill.name });
		ctx.scheduleSkillsReload();
		return true;
	}

	if (method === "POST" && url === "/api/skills/reload") {
		ctx.scheduleSkillsReload();
		json(res, 200, { reloaded: true, skills: ctx.listProjectSkills() });
		return true;
	}

	// --- Remote skill library (GitHub) ---
	if (method === "GET" && url.split("?")[0] === "/api/skill-library") {
		const forceRefresh = new URL(url, "http://localhost").searchParams.get("refresh") === "1";
		try {
			json(res, 200, await ctx.listSkillLibrary(forceRefresh));
		} catch (err) {
			logger.warn({ err }, "failed to list skill library");
			json(res, 502, { error: err instanceof Error ? err.message : "Failed to load skill library" });
		}
		return true;
	}

	if (method === "POST" && url === "/api/skill-library/import") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const skillName = typeof body.name === "string" ? body.name.trim() : "";
		if (!skillName) {
			json(res, 400, { error: "Missing skill name" });
			return true;
		}
		try {
			const installed = await ctx.importSkillFromLibrary(skillName);
			ctx.setSkillEnabled(installed.name, true);
			const entry = ctx.listProjectSkills().find((s) => (s as { name: string }).name === installed.name);
			json(res, 201, entry ?? { name: installed.name });
			ctx.scheduleSkillsReload();
		} catch (err) {
			logger.warn({ err }, "failed to import skill from library");
			json(res, 502, { error: err instanceof Error ? err.message : "Failed to import skill" });
		}
		return true;
	}

	const skillToggleMatch = matchRoute("PATCH", method, url, "/api/skills/:name");
	if (skillToggleMatch) {
		const name = slugifySkillName(decodeURIComponent(skillToggleMatch.name));
		const skillFile = join(skillsDir, name, "SKILL.md");
		if (!existsSync(skillFile)) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.enabled === "boolean") {
			ctx.setSkillEnabled(name, body.enabled);
		}
		ctx.scheduleSkillsReload();
		json(res, 200, ctx.listProjectSkills().find((entry) => (entry as { name: string }).name === name));
		return true;
	}

	const skillDeleteMatch = matchRoute("DELETE", method, url, "/api/skills/:name");
	if (skillDeleteMatch) {
		const name = slugifySkillName(decodeURIComponent(skillDeleteMatch.name));
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		rmSync(skillDir, { recursive: true, force: true });
		ctx.setSkillEnabled(name, true);
		ctx.scheduleSkillsReload();
		json(res, 204, null);
		return true;
	}

	// GET /api/skills/:name/content — read SKILL.md content
	const skillContentGetMatch = matchRoute("GET", method, url, "/api/skills/:name/content");
	if (skillContentGetMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentGetMatch.name));
		const filePath = join(skillsDir, name, "SKILL.md");
		if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return true; }
		json(res, 200, { name, content: readFileSync(filePath, "utf-8") });
		return true;
	}

	// PUT /api/skills/:name/content — save SKILL.md content
	const skillContentPutMatch = matchRoute("PUT", method, url, "/api/skills/:name/content");
	if (skillContentPutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentPutMatch.name));
		const filePath = join(skillsDir, name, "SKILL.md");
		if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return true; }
		const body = (await readBody(req)) as Record<string, unknown>;
		const content = typeof body.content === "string" ? body.content : "";
		writeFileSync(filePath, content, "utf-8");
		ctx.scheduleSkillsReload();
		json(res, 200, { name, saved: true });
		return true;
	}

	// GET /api/skills/:name/tree — file tree of a skill directory
	const skillTreeMatch = matchRoute("GET", method, url, "/api/skills/:name/tree");
	if (skillTreeMatch) {
		const name = slugifySkillName(decodeURIComponent(skillTreeMatch.name));
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		const skillRootReal = canonicalTreeRoot(skillDir);
		function readSkillTree(dir: string, depth = 0, seen: ReadonlySet<string> = new Set()): WorkspaceTreeNode[] {
			if (depth > WORKSPACE_TREE_MAX_DEPTH) return [];
			let entries: Dirent<string>[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return [];
			}
			return entries
				.filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX" && e.name !== "node_modules")
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
				.slice(0, 200)
				.map((entry): WorkspaceTreeNode | null => {
					const fullPath = join(dir, entry.name);
					let st: ReturnType<typeof statSync>;
					try {
						st = statSync(fullPath);
					} catch {
						return null;
					}
					const isDir = st.isDirectory();
					const node: WorkspaceTreeNode = {
						name: entry.name,
						path: relative(skillDir, fullPath),
						type: isDir ? "directory" : "file",
						size: st.size,
						updatedAt: st.mtime.toISOString(),
					};
					if (isDir) {
						let real: string;
						try {
							real = realpathSync(fullPath);
						} catch {
							real = fullPath;
						}
						const withinRoot = isWithin(skillRootReal, real);
						node.children = withinRoot && !seen.has(real)
							? readSkillTree(fullPath, depth + 1, new Set([...seen, real]))
							: [];
					}
					return node;
				})
				.filter((node): node is WorkspaceTreeNode => node !== null);
		}
		const st = statSync(skillDir);
		json(res, 200, {
			name,
			path: "",
			type: "directory",
			size: st.size,
			updatedAt: st.mtime.toISOString(),
			children: readSkillTree(skillDir),
		});
		return true;
	}

	// GET /api/skills/:name/file?path=... — read a file inside a skill
	const skillFileGetMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/file");
	if (skillFileGetMatch && method === "GET") {
		const name = slugifySkillName(decodeURIComponent(skillFileGetMatch.name));
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = params.get("path") ?? "";
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		const st = statSync(fullPath);
		const kind = workspaceFileKind(fullPath);
		const forceText = params.get("forceText") === "1";
		if (!forceText && (kind === "binary" || kind === "pdf" || kind === "image")) {
			json(res, 200, {
				path: relative(skillDir, fullPath),
				name: basename(fullPath),
				kind,
				mimeType: contentTypeForWorkspaceFile(fullPath),
				size: st.size,
				updatedAt: st.mtime.toISOString(),
				url: `/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(relative(skillDir, fullPath))}`,
			});
			return true;
		}
		if (st.size > 1024 * 1024) { json(res, 413, { error: "File too large" }); return true; }
		json(res, 200, {
			path: relative(skillDir, fullPath),
			name: basename(fullPath),
			kind: forceText ? "text" : kind,
			mimeType: forceText ? "text/plain; charset=utf-8" : contentTypeForWorkspaceFile(fullPath),
			size: st.size,
			updatedAt: st.mtime.toISOString(),
			content: readFileSync(fullPath, "utf-8"),
		});
		return true;
	}

	// PUT /api/skills/:name/file — save a file inside a skill
	const skillFilePutMatch = matchRoute("PUT", method, url, "/api/skills/:name/file");
	if (skillFilePutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillFilePutMatch.name));
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const body = (await readBody(req)) as Record<string, unknown>;
		const relPath = typeof body.path === "string" ? body.path.trim() : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!relPath) { json(res, 400, { error: "Missing path" }); return true; }
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		writeFileSync(fullPath, content, "utf-8");
		if (basename(fullPath) === "SKILL.md") ctx.scheduleSkillsReload();
		const st = statSync(fullPath);
		json(res, 200, { path: relPath, saved: true, size: st.size, updatedAt: st.mtime.toISOString() });
		return true;
	}

	// GET /api/skills/:name/raw?path=... — serve raw file bytes
	const skillRawMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/raw");
	if (skillRawMatch) {
		const name = slugifySkillName(decodeURIComponent(skillRawMatch.name));
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = params.get("path") ?? "";
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		const ct = contentTypeForWorkspaceFile(fullPath);
		res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
		res.end(readFileSync(fullPath));
		return true;
	}

	return false;
}
