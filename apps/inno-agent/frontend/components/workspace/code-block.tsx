"use client";

import { useEffect, useState } from "react";
import { Copy, Check, Download } from "lucide-react";
import { codeToHtml } from "shiki";

const LANG_LABEL: Record<string, string> = {
  javascript: "javascript",
  typescript: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  python: "python",
  py: "python",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  markdown: "markdown",
  md: "markdown",
  text: "text",
};

function labelFor(lang: string): string {
  return LANG_LABEL[lang.toLowerCase()] || lang || "text";
}

/**
 * A syntax-highlighted, copyable code block with the prototype's chrome
 * (language label top-left, 复制 / 下载 top-right). Shiki tokenizes lazily in
 * the client; any failure degrades to a plain <pre>.
 */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang: lang || "text", theme: "github-light" })
      .then((h) => {
        if (alive) setHtml(h);
      })
      .catch(() => {
        if (alive) setHtml("");
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code.${lang || "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="group my-3 overflow-hidden rounded-lg border border-border/70 bg-[#fafafb] dark:bg-[#141416]">
      <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-b from-muted/60 to-muted/20 px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">
          {labelFor(lang)}
        </span>
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : (
              <Copy className="size-3.5" />
            )}
            复制
          </button>
          <button
            type="button"
            onClick={download}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted hover:text-foreground"
          >
            <Download className="size-3.5" />
            下载
          </button>
        </div>
      </div>
      {html ? (
        <div
          className="overflow-x-auto p-3 font-mono text-[13px] leading-6 [&_.shiki]:bg-transparent [&_pre]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-6">{code}</pre>
      )}
    </div>
  );
}
