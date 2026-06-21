#!/usr/bin/env node
/**
 * Inno Agent — local Content Hub bundle service.
 *
 * Serves the "bundle" content-source contract that inno-agent's RemoteContentSource
 * speaks, so you can host skills + workspace templates yourself (e.g. backed by a
 * private git repo) instead of pulling from GitHub:
 *
 *   GET /index.json
 *       → { "skills":  [{ name, description, ... }],
 *           "presets": [{ name, description, icon }] }
 *
 *   GET /skills/<name>.tar.gz      → gzipped tar of skill-library/<name>/
 *   GET /presets/<name>.tar.gz     → gzipped tar of workspace-templates/<name>/
 *
 * Point a content directory at it (default: ./content) laid out as:
 *
 *   content/
 *   ├── skill-library/<name>/SKILL.md
 *   └── workspace-templates/<name>/preset.json (+ agent.md, .skills/, …)
 *
 * The index is built by scanning those dirs; tarballs are produced on demand
 * with the system `tar` (strip-components is applied by the CLIENT on extract,
 * so we pack WITH the top <name>/ dir — the client strips it).
 *
 * Auth (optional): set HUB_TOKEN to require `Authorization: Bearer <token>`.
 *
 * Usage:
 *   node server.mjs                       # serve ./content on :8787
 *   CONTENT_DIR=/path PORT=9000 node server.mjs
 *   HUB_TOKEN=secret node server.mjs      # require bearer token
 *
 * No third-party dependencies — Node >=20 built-ins only.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const CONTENT_DIR = resolve(process.env.CONTENT_DIR ?? join(process.cwd(), "content"));
const HUB_TOKEN = (process.env.HUB_TOKEN ?? "").trim();

// Map a URL category segment → its on-disk directory + marker file.
const CATEGORY = {
	skills: { dir: "skill-library", marker: "SKILL.md" },
	presets: { dir: "workspace-templates", marker: "preset.json" },
};

const ITEM_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function log(...args) {
	console.log(`[hub] ${new Date().toISOString()}`, ...args);
}

/** Single-segment, no traversal, not a skeleton/hidden dir. */
function isUsableItemDir(name) {
	return ITEM_NAME_RE.test(name) && name !== "." && name !== ".." && !name.startsWith("_") && !name.startsWith(".") && name !== "__MACOSX";
}

/** Read a skill's description from SKILL.md frontmatter (best-effort, single-line + block scalar). */
function readSkillDescription(skillDir) {
	const md = join(skillDir, "SKILL.md");
	if (!existsSync(md)) return "";
	const text = readFileSync(md, "utf-8").replace(/\r\n/g, "\n");
	const fm = text.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return "";
	const lines = fm[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^description:\s*(.*)$/);
		if (!m) continue;
		const inline = m[1].trim();
		if (/^[>|][+-]?\s*$/.test(inline)) {
			const block = [];
			for (let j = i + 1; j < lines.length; j++) {
				if (/^\s+\S/.test(lines[j]) || lines[j].trim() === "") block.push(lines[j].trim());
				else break;
			}
			return block.join(" ").replace(/\s+/g, " ").trim();
		}
		return inline.replace(/^["']|["']$/g, "").trim();
	}
	return "";
}

/** Build the index.json payload by scanning the content dirs. */
function buildIndex() {
	const index = { skills: [], presets: [] };

	// Skills: each dir with a SKILL.md; description from frontmatter.
	const skillsRoot = join(CONTENT_DIR, CATEGORY.skills.dir);
	if (existsSync(skillsRoot)) {
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isUsableItemDir(entry.name)) continue;
			const dir = join(skillsRoot, entry.name);
			if (!existsSync(join(dir, CATEGORY.skills.marker))) continue;
			index.skills.push({ name: entry.name, description: readSkillDescription(dir) });
		}
	}

	// Presets: each dir with a preset.json; metadata read straight from it.
	const presetsRoot = join(CONTENT_DIR, CATEGORY.presets.dir);
	if (existsSync(presetsRoot)) {
		for (const entry of readdirSync(presetsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isUsableItemDir(entry.name)) continue;
			const metaPath = join(presetsRoot, entry.name, CATEGORY.presets.marker);
			if (!existsSync(metaPath)) continue;
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
				if ((meta.id ?? "") !== entry.name || !(meta.name ?? "").trim()) continue;
				index.presets.push({
					name: entry.name,
					description: (meta.description ?? "").trim(),
					icon: meta.icon?.trim() || undefined,
				});
			} catch {
				// skip invalid preset.json
			}
		}
	}

	index.skills.sort((a, b) => a.name.localeCompare(b.name));
	index.presets.sort((a, b) => a.name.localeCompare(b.name));
	return index;
}

/** Stream a gzipped tar of <category>/<name>/ to the response. */
function streamTarball(res, categoryDir, name) {
	const itemDir = join(CONTENT_DIR, categoryDir, name);
	if (!existsSync(itemDir) || !statSync(itemDir).isDirectory()) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
		return;
	}
	res.writeHead(200, {
		"Content-Type": "application/gzip",
		"Content-Disposition": `attachment; filename="${name}.tar.gz"`,
	});
	// Pack from the parent dir so the archive contains <name>/… ; the client
	// extracts with --strip-components=1, dropping that top level.
	const tar = spawn("tar", ["-czf", "-", "-C", join(CONTENT_DIR, categoryDir), name]);
	tar.stdout.pipe(res);
	tar.stderr.on("data", (d) => log("tar stderr:", d.toString().trim()));
	tar.on("error", (err) => {
		log("tar spawn error:", err.message);
		if (!res.headersSent) res.writeHead(500);
		res.end();
	});
	res.on("close", () => tar.kill());
}

function authorized(req) {
	if (!HUB_TOKEN) return true;
	const header = req.headers["authorization"] ?? "";
	return header === `Bearer ${HUB_TOKEN}`;
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	const path = url.pathname;

	if (req.method !== "GET") {
		res.writeHead(405).end();
		return;
	}
	if (!authorized(req)) {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return;
	}

	// Health check.
	if (path === "/" || path === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, contentDir: CONTENT_DIR }));
		return;
	}

	// Catalog.
	if (path === "/index.json") {
		try {
			const body = JSON.stringify(buildIndex());
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(body);
		} catch (err) {
			log("index error:", err);
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "failed to build index" }));
		}
		return;
	}

	// Item tarball: /skills/<name>.tar.gz or /presets/<name>.tar.gz
	const m = path.match(/^\/(skills|presets)\/([^/]+)\.tar\.gz$/);
	if (m) {
		const [, category, rawName] = m;
		const name = decodeURIComponent(rawName);
		if (!isUsableItemDir(name)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid item name" }));
			return;
		}
		streamTarball(res, CATEGORY[category].dir, name);
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
	log(`serving ${CONTENT_DIR}`);
	log(`listening on http://localhost:${PORT}`);
	if (!existsSync(CONTENT_DIR)) {
		log(`WARNING: content dir does not exist yet: ${CONTENT_DIR}`);
		log(`create it with: skill-library/<name>/SKILL.md and workspace-templates/<name>/preset.json`);
	}
	if (HUB_TOKEN) log("bearer token auth is ENABLED");
});
