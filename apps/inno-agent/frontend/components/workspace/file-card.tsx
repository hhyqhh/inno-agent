"use client";

import {
  FileText,
  FileSpreadsheet,
  Presentation,
  Image as ImageIcon,
  File as FileIcon,
  Eye,
  Download,
} from "lucide-react";
import type { AttachmentRef } from "@/lib/api/types";
import { rawUrl } from "@/lib/api/workspace";
import { formatBytes } from "@/lib/format";

const KIND_META: Record<string, { label: string; icon: typeof FileText; tint: string }> = {
  doc: { label: "文档", icon: FileText, tint: "text-blue-600" },
  xls: { label: "表格", icon: FileSpreadsheet, tint: "text-emerald-600" },
  ppt: { label: "演示", icon: Presentation, tint: "text-orange-500" },
  pdf: { label: "PDF", icon: FileText, tint: "text-red-600" },
  image: { label: "图片", icon: ImageIcon, tint: "text-violet-600" },
  file: { label: "文件", icon: FileIcon, tint: "text-muted-foreground" },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? KIND_META.file;
}

/** Derive a kind (`ppt`/`doc`/`xls`/`image`/`pdf`/`file`) from a file name. */
export function kindFromName(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "pptx":
    case "ppt":
      return "ppt";
    case "docx":
    case "doc":
      return "doc";
    case "xlsx":
    case "xls":
      return "xls";
    case "pdf":
      return "pdf";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "image";
    default:
      return "file";
  }
}

export function kindLabel(kind: string): string {
  return kindMeta(kind).label;
}

export function kindIcon(kind: string) {
  const Icon = kindMeta(kind).icon;
  return <Icon className={`size-4 ${kindMeta(kind).tint}`} />;
}

export function kindTint(kind: string): string {
  return kindMeta(kind).tint;
}

/** Size hint without a real value — fall to a generic label for mock data. */
function sizeHint(path: string, size?: number): string | null {
  if (size != null && size > 0) return formatBytes(size);
  return null;
}

/**
 * A workspace file card (prototype 工作区产物 / message attachment). Shows the
 * kind-tinted icon, name, a one-line meta, and optional 预览/下载 actions.
 */
export function FileCard({
  path,
  name,
  kind,
  size,
  meta,
  workspaceId,
  active,
  onPreview,
}: {
  path: string;
  name?: string;
  kind: string;
  size?: number;
  /** Overrides the auto-generated meta line (unused for message attachments). */
  meta?: string;
  workspaceId?: string;
  active?: boolean;
  onPreview?: (path: string) => void;
}) {
  const icon = kindIcon(kind);
  const displayName = name ?? path.split("/").pop() ?? path;
  const autoMeta =
    meta ??
    `${kindMeta(kind).label} · ${sizeHint(path, size) ?? "文档"} · 刚刚生成`;

  return (
    <div
      className={[
        "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left",
        active
          ? "border-primary/40 bg-primary/5"
          : "border-border/70 bg-card hover:border-primary/30",
      ].join(" ")}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
        <div className="truncate text-[11px] text-muted-foreground">{autoMeta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onPreview?.(path)}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Eye className="size-3.5" />
          预览
        </button>
        <a
          href={rawUrl(workspaceId, path, true)}
          download
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="size-3.5" />
          下载
        </a>
      </div>
    </div>
  );
}

export type { AttachmentRef };
