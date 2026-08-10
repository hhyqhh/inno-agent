import { apiFetch, withApiToken } from "./client.js";
import type { SkillInfo, SkillLibraryItem } from "../types/skills.js";
import type { WorkspaceTreeNode, WorkspaceFileDetail } from "../types/workspace.js";

export async function listSkills(): Promise<SkillInfo[]> {
	return apiFetch<SkillInfo[]>("/api/skills");
}

export async function listSkillLibrary(forceRefresh = false): Promise<SkillLibraryItem[]> {
	return apiFetch<SkillLibraryItem[]>(`/api/skill-library${forceRefresh ? "?refresh=1" : ""}`);
}

export async function importSkillFromLibrary(name: string): Promise<SkillInfo> {
	return apiFetch<SkillInfo>("/api/skill-library/import", {
		method: "POST",
		body: JSON.stringify({ name }),
	});
}

export async function uploadSkill(file: File): Promise<SkillInfo> {
	const dataBase64 = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			resolve(result.includes(",") ? result.split(",")[1] : result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
		reader.readAsDataURL(file);
	});

	return apiFetch<SkillInfo>("/api/skills/upload", {
		method: "POST",
		body: JSON.stringify({
			fileName: file.name,
			mimeType: file.type || "text/markdown",
			dataBase64,
		}),
	});
}

export async function updateSkill(name: string, enabled: boolean): Promise<SkillInfo> {
	return apiFetch<SkillInfo>(`/api/skills/${encodeURIComponent(name)}`, {
		method: "PATCH",
		body: JSON.stringify({ enabled }),
	});
}

export async function deleteSkill(name: string): Promise<void> {
	await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function reloadSkills(): Promise<{ reloaded: boolean; skills: SkillInfo[] }> {
	return apiFetch<{ reloaded: boolean; skills: SkillInfo[] }>("/api/skills/reload", { method: "POST" });
}

export async function getSkillContent(name: string): Promise<{ name: string; content: string }> {
	return apiFetch<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}/content`);
}

export async function saveSkillContent(name: string, content: string): Promise<{ name: string; saved: boolean }> {
	return apiFetch<{ name: string; saved: boolean }>(`/api/skills/${encodeURIComponent(name)}/content`, {
		method: "PUT",
		body: JSON.stringify({ content }),
	});
}

export async function getSkillTree(name: string): Promise<{ name: string; children: WorkspaceTreeNode[] }> {
	return apiFetch<{ name: string; children: WorkspaceTreeNode[] }>(`/api/skills/${encodeURIComponent(name)}/tree`);
}

export async function getSkillFile(name: string, path: string, forceText = false): Promise<WorkspaceFileDetail> {
	const params = new URLSearchParams({ path });
	if (forceText) params.set("forceText", "1");
	return apiFetch<WorkspaceFileDetail>(`/api/skills/${encodeURIComponent(name)}/file?${params.toString()}`);
}

export async function saveSkillFile(name: string, path: string, content: string): Promise<{ path: string; saved: boolean }> {
	return apiFetch<{ path: string; saved: boolean }>(`/api/skills/${encodeURIComponent(name)}/file`, {
		method: "PUT",
		body: JSON.stringify({ path, content }),
	});
}

export function skillRawUrl(name: string, path: string): string {
	return withApiToken(`/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(path)}`);
}

// ---- HTML resource inlining for srcdoc previews ----

function isRelUrl(url: string): boolean {
	const t = url.trim();
	if (!t) return false;
	if (/^(https?:)?\/\//i.test(t)) return false;
	if (t.startsWith("/")) return false;
	if (/^(?:data|blob):/i.test(t)) return false;
	return true;
}

function resolveRelPath(htmlFilePath: string, relativeRef: string): string {
	const htmlDir = htmlFilePath.includes("/") ? htmlFilePath.split("/").slice(0, -1).join("/") : "";
	const segs = htmlDir ? htmlDir.split("/").filter(Boolean) : [];
	for (const seg of relativeRef.split("/")) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") { segs.pop(); continue; }
		segs.push(seg);
	}
	return segs.join("/");
}

export async function inlineSkillHtml(skillName: string, html: string, filePath: string): Promise<string> {
	const fetches: Array<{ tag: string; path: string; type: "css" | "js"; attrs?: string }> = [];

	const linkRe = /<link\b([^>]*)\/?>/gi;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(html)) !== null) {
		const attrs = m[1];
		if (!/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(attrs)) continue;
		const hm = attrs.match(/\bhref\s*=\s*["\']([^"\']+)["\']/i);
		if (!hm) continue;
		if (!isRelUrl(hm[1])) continue;
		const rp = resolveRelPath(filePath, hm[1]);
		if (/\.(?:css|js|mjs)$/i.test(rp)) fetches.push({ tag: m[0], path: rp, type: "css" });
	}

	const scrRe = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi;
	while ((m = scrRe.exec(html)) !== null) {
		if (!isRelUrl(m[2])) continue;
		const rp = resolveRelPath(filePath, m[2]);
		if (/\.(?:js|mjs)$/i.test(rp)) fetches.push({ tag: m[0], path: rp, type: "js", attrs: (m[1] + ' ' + m[3]).replace(/\bsrc\s*=\s*["'][^"']*["']/gi, '').replace(/\s+/g, ' ').trim() });
	}

	if (fetches.length === 0) return html;

	const results = await Promise.all(
		fetches.map(async (f) => {
			try {
				const file = await getSkillFile(skillName, f.path);
				if (file?.content && file.content.length > 0) {
					return { ...f, content: file.content };
				}
			} catch { /* skip */ }
			return { ...f, content: null };
		})
	);

	let result = html;
	for (const r of results) {
		if (r.content == null) continue;
		if (r.type === "css") {
			result = result.replace(r.tag, `<style>${r.content}</style>`);
		} else {
			const open = r.attrs ? `<script ${r.attrs}>` : "<script>";
			result = result.replace(r.tag, `${open}${r.content}</script>`);
		}
	}
	return result;
}
