"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { FileText, X, Loader2 } from "lucide-react";
import {
  getWorkspaceFile,
  getOfficePreview,
  getPptxPreview,
  rawUrl,
} from "@/lib/api/workspace";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import type { WorkspaceFileDetail, OfficePreview, PptxPreview } from "@/lib/api/types";
import { kindFromName, kindIcon, kindLabel } from "./file-card";
import { Markdown } from "./markdown";
import { formatBytes } from "@/lib/format";

type Doc = {
  kind: string;
  name: string;
  detail?: WorkspaceFileDetail;
  office?: OfficePreview;
  pptx?: PptxPreview;
  raw?: string;
};

function loadDoc(workspaceId: string | undefined, path: string): Promise<Doc> {
  const kind = kindFromName(path);
  const name = path.split("/").pop() ?? path;
  if (kind === "ppt") {
    return getPptxPreview(workspaceId, path).then((pptx) => ({ kind, name, pptx }));
  }
  if (kind === "doc" || kind === "xls") {
    return getOfficePreview(workspaceId, path).then((office) => ({ kind, name, office }));
  }
  if (kind === "pdf" || kind === "html") {
    return Promise.resolve({ kind, name, raw: rawUrl(workspaceId, path) });
  }
  if (kind === "image") {
    return Promise.resolve({ kind, name, raw: rawUrl(workspaceId, path) });
  }
  return getWorkspaceFile(workspaceId, path).then((detail) => ({ kind, name, detail }));
}

/**
 * The doc-preview column (prototype 展开工作区-2), rendered between the chat and
 * the artifact panel once a workspace file is selected. Office files render as
 * paginated text; pptx renders slide SVGs; images/pdf stream raw bytes.
 */
interface DocState {
  path: string;
  doc: Doc | null;
  error: string | null;
}

const EMPTY: DocState = { path: "", doc: null, error: null };

export function DocPreview() {
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setSelectedPath = useWorkspaceStore((s) => s.setSelectedPath);
  const [state, setState] = useState<DocState>(EMPTY);

  // Fetch is only ever committed from the async continuation (never
  // synchronously in the effect body) to satisfy the set-state-in-effect rule.
  useEffect(() => {
    if (!selectedPath) return;
    let alive = true;
    loadDoc(workspaceId ?? undefined, selectedPath)
      .then((d) => {
        if (alive) setState({ path: selectedPath, doc: d, error: null });
      })
      .catch((e) => {
        if (alive) setState({ path: selectedPath, doc: null, error: (e as Error).message });
      });
    return () => {
      alive = false;
    };
  }, [selectedPath, workspaceId]);

  if (!selectedPath) return null;

  const name = selectedPath.split("/").pop() ?? selectedPath;
  const kind = kindFromName(name);
  const stale = state.path !== selectedPath;
  // If we haven't finished loading the *current* path yet, show the spinner —
  // even when the previous file errored (state.error is that file's error). A
  // stale error must not leave the pane blank while the new file loads.
  const loading = stale;
  const failed = state.path === selectedPath && !!state.error;

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-border/70 bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground">{kindIcon(kind)}</span>
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        </div>
        <button
          type="button"
          aria-label="关闭预览"
          onClick={() => setSelectedPath(null)}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
        {failed && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-destructive">
            <FileText className="size-5" />
            {state.error}
          </div>
        )}
        {loading && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载预览…
          </div>
        )}
        {!loading && !failed && state.doc && <DocBody doc={state.doc} />}
      </div>
    </div>
  );
}

function DocBody({ doc }: { doc: Doc }) {
  if (doc.office) {
    const off = doc.office;
    return (
      <div className="p-4">
        <div className="rounded bg-white px-8 py-10 text-[#1f2328] shadow-sm">
          <h1 className="text-center text-xl font-semibold">{off.name}</h1>
          <div className="mx-auto my-4 h-px w-16 bg-black/10" />
          <div className="space-y-3 whitespace-pre-line text-[13px] leading-6">
            {off.text}
          </div>
          {off.pages?.map((p) => (
            <div
              key={p.index}
              className="mt-5 rounded border-t border-black/5 pt-4 text-[13px] leading-6 text-[#1f2328]"
            >
              <div className="mb-1 text-[11px] uppercase tracking-wide text-black/40">
                第 {p.index} 页
              </div>
              <div className="whitespace-pre-line">{p.text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (doc.pptx) {
    return (
      <div className="p-4">
        <div className="grid grid-cols-1 gap-4">
          {doc.pptx.slides.map((s) => (
            <div
              key={s.index}
              className="overflow-hidden rounded-lg border border-border/60 bg-white shadow-sm"
            >
              <Image
                src={`data:image/svg+xml;utf8,${encodeURIComponent(s.svg)}`}
                alt={`第 ${s.index} 页`}
                width={960}
                height={540}
                unoptimized
                className="block h-full w-full"
              />
              <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
                第 {s.index} / {doc.pptx!.slideCount} 页
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (doc.raw) {
    return (
      <div className="h-full">
        <iframe
          src={doc.raw}
          title={doc.name}
          className="h-full w-full border-0 bg-white"
        />
      </div>
    );
  }

  const detail = doc.detail;
  if (detail?.content) {
    if (detail.kind === "markdown") {
      return (
        <div className="bg-white p-6">
          <Markdown content={detail.content} />
        </div>
      );
    }
    return (
      <pre className="bg-white p-6 text-[13px] leading-6 text-[#1f2328]">
        {detail.content}
      </pre>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      <FileText className="size-5" />
      <span>{kindLabel(doc.kind)}文件暂不支持预览。</span>
      {detail && <span className="text-[11px]">{formatBytes(detail.size)}</span>}
    </div>
  );
}
