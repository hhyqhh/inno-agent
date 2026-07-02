import { apiFetch } from "./client.js";
import type { PptxPreviewResult, WorkspaceFileDetail, WorkspaceTree, WorkspaceTreeNode } from "../types/workspace.js";

function qs(workspaceId?: string): string {
	return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
}

function withWorkspace<T extends Record<string, unknown>>(body: T, workspaceId?: string): T & { workspaceId?: string } {
	return workspaceId ? { ...body, workspaceId } : body;
}

export async function getWorkspaceTree(workspaceId?: string): Promise<WorkspaceTree> {
	return apiFetch<WorkspaceTree>(`/api/workspace/tree${qs(workspaceId)}`);
}

export async function getWorkspaceFile(path: string, workspaceId?: string, forceText = false): Promise<WorkspaceFileDetail> {
	const params = new URLSearchParams({ path });
	if (workspaceId) params.set("workspaceId", workspaceId);
	if (forceText) params.set("forceText", "1");
	return apiFetch<WorkspaceFileDetail>(`/api/workspace/file?${params.toString()}`);
}

export async function createWorkspaceItem(path: string, type: "file" | "directory", workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/create", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ path, type }, workspaceId)),
	});
}

export async function renameWorkspaceItem(oldPath: string, newPath: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/rename", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ oldPath, newPath }, workspaceId)),
	});
}

export async function deleteWorkspaceItem(path: string, workspaceId?: string): Promise<{ deleted: boolean; path: string }> {
	return apiFetch<{ deleted: boolean; path: string }>("/api/workspace/delete", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ path }, workspaceId)),
	});
}

export async function moveWorkspaceItem(sourcePath: string, targetDir: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/move", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ sourcePath, targetDir }, workspaceId)),
	});
}

export async function saveWorkspaceFile(path: string, content: string, workspaceId?: string): Promise<{ path: string; saved: boolean; size: number; updatedAt: string }> {
	return apiFetch("/api/workspace/file", {
		method: "PUT",
		body: JSON.stringify(withWorkspace({ path, content }, workspaceId)),
	});
}

export async function uploadWorkspaceFiles(files: Array<{ path: string; dataBase64: string }>, workspaceId?: string): Promise<{ uploaded: WorkspaceTreeNode[] }> {
	return apiFetch<{ uploaded: WorkspaceTreeNode[] }>("/api/workspace/upload", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ files }, workspaceId)),
	});
}

/** Install a skill package (.zip / .md) into the workspace's private `.skills` dir. */
export async function uploadWorkspaceSkill(fileName: string, dataBase64: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/skills/upload", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ fileName, dataBase64 }, workspaceId)),
	});
}

/** Build the raw URL for a workspace file, optionally forcing a download. */
export function workspaceFileUrl(path: string, workspaceId?: string, download = false): string {
	const params = new URLSearchParams({ path });
	if (workspaceId) params.set("workspaceId", workspaceId);
	if (download) params.set("download", "1");
	return `/api/workspace/raw?${params.toString()}`;
}

/** Build the URL that zips and downloads a workspace folder (empty path → whole workspace). */
export function workspaceFolderZipUrl(path: string, workspaceId?: string): string {
	const params = new URLSearchParams();
	if (path) params.set("path", path);
	if (workspaceId) params.set("workspaceId", workspaceId);
	const qs = params.toString();
	return `/api/workspace/download-folder${qs ? `?${qs}` : ""}`;
}

/** Fetch a pptx rendered to per-slide SVG. */
export async function getPptxPreview(path: string, workspaceId?: string): Promise<PptxPreviewResult> {
	const params = new URLSearchParams({ path });
	if (workspaceId) params.set("workspaceId", workspaceId);
	return apiFetch<PptxPreviewResult>(`/api/workspace/pptx-preview?${params.toString()}`);
}

// ---- HTML resource inlining for srcdoc previews ----
// Relative URLs in srcdoc iframes resolve against the parent page, not the
// file's workspace location. We inline CSS/JS so the preview is self-contained.

const MAX_INLINE_BYTES = 512 * 1024;

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

export async function inlineWorkspaceHtml(html: string, filePath: string, wsId?: string): Promise<string> {
  const fetches: Array<{ tag: string; path: string; type: "css" | "js"; attrs?: string }> = [];

  // Collect <link rel="stylesheet" href="...">
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

  // Collect <script src="...">...</script>
  const scrRe = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi;
  while ((m = scrRe.exec(html)) !== null) {
    if (!isRelUrl(m[2])) continue;
    const rp = resolveRelPath(filePath, m[2]);
    if (/\.(?:js|mjs)$/i.test(rp)) fetches.push({ tag: m[0], path: rp, type: "js", attrs: (m[1] + ' ' + m[3]).replace(/\bsrc\s*=\s*["'][^"']*["']/gi, '').replace(/\s+/g, ' ').trim() });
  }

  if (fetches.length === 0) return html;

  // Fetch all in parallel
  const results = await Promise.all(
    fetches.map(async (f) => {
      try {
        const file = await getWorkspaceFile(f.path, wsId);
        if (file?.content && file.content.length > 0 && file.content.length <= MAX_INLINE_BYTES) {
          return { ...f, content: file.content };
        }
      } catch { /* skip */ }
      return { ...f, content: null };
    })
  );

  // Replace tags
  let result = html;
  for (const r of results) {
    if (r.content == null) continue;
    if (r.type === "css") {
      result = result.replace(r.tag, `<style>${r.content}</style>`);
    } else {
      const attrs = r.attrs;
      const open = attrs ? `<script ${attrs}>` : "<script>";
      result = result.replace(r.tag, `${open}${r.content}</script>`);
    }
  }
  return result;
}

/** Trigger a browser download by clicking a transient anchor. */
export function triggerDownload(url: string): void {
	const a = document.createElement("a");
	a.href = url;
	a.rel = "noopener";
	// download attr is advisory; the server sets Content-Disposition with the real name.
	a.download = "";
	document.body.appendChild(a);
	a.click();
	a.remove();
}
