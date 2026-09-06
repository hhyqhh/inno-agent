"use client";

import type { ReactNode, ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { CodeBlock } from "./code-block";

/** Flatten a React node tree to a plain string (extract code text). */
function textOf(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in (node as ReactElement)) {
    const el = node as ReactElement<{ children?: ReactNode; className?: string }>;
    return textOf(el.props.children);
  }
  return "";
}

/** Pull a block code element's language + text out of the `pre` child. */
function codeProps(node: ReactNode): { lang: string; code: string } {
  let lang = "text";
  let code = "";
  if (node && typeof node === "object" && "props" in (node as ReactElement)) {
    const el = node as ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    const cls = el.props.className || "";
    lang = /language-(\w+)/i.exec(cls)?.[1] || lang;
    code = textOf(el.props.children).replace(/\n$/, "");
  }
  return { lang, code };
}

/**
 * Assistent-message markdown renderer (docs/frontend-rewrite-plan.md §4.4).
 * GFM + math (KaTeX) with a custom block-code renderer for copy/download.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: ({ children }) => {
            const { lang, code } = codeProps(children);
            return <CodeBlock lang={lang} code={code} />;
          },
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className || "");
            if (isBlock) return <code className={className}>{children}</code>;
            return <code>{children}</code>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
