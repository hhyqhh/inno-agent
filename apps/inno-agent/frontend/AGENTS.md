<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- Manually maintained project constraints (NOT re-written by `next dev`). Read before writing any code in this directory. -->

## Inno Agent frontend — project constraints

**This is a fresh Next.js rewrite of the product's web UI.** Treat the facts below as non-negotiable.

### Stack
- TypeScript (strict) + **Next.js 16.3.4 (App Router, `app/`)** + **Tailwind CSS v4** + shadcn/ui (**not installed yet** — `npx shadcn@latest init` before using any shadcn component).
- `@/*` → project root. Node >= 20.9, TS >= 5.1.
- Tailwind is **v4**: `globals.css` uses `@import "tailwindcss";`, PostCSS plugin is `@tailwindcss/postcss`, there is **no `tailwind.config.js`** (theme lives in `@theme` / `@theme inline` in `globals.css`). Do not write v3-style config or `@tailwind base;`.

### Boundaries — do NOT touch
- `apps/inno-agent/src` (backend, HTTP on :3000) — call it over HTTP only, never `import` from it.
- `apps/inno-agent/web` (old Vite + React + Lit frontend) — reference for behavior only; rewrite with Next idioms, do not copy its code or deps.
- Only modify `apps/inno-agent/frontend/`.

### Next.js 16 (breaking changes — read docs before coding)
Read `node_modules/next/dist/docs/01-app/...` for the feature at hand, especially `02-guides/upgrading/version-16.md`. Do not rely on training-data conventions. Key traps:
- `params` / `searchParams` / `cookies()` / `headers()` are **async-only**. Use `await props.params`, `PageProps<'/route'>` / `LayoutProps` / `RouteContext` (run `npx next typegen`).
- `middleware.ts` → `proxy.ts` (`export function proxy`); `proxy` is `nodejs` only (no `edge`).
- `next lint` is removed → use `npm run lint` (= `eslint`). `next build` does not lint.
- Turbopack is default (no `--turbopack`); config is top-level `turbopack`, not `experimental.turbopack`.
- No `serverRuntimeConfig`/`publicRuntimeConfig` → `process.env` / `NEXT_PUBLIC_*`. `images.domains` → `images.remotePatterns`. Parallel route slots need a `default.js`.

### Design source of truth
Match `prototype/*.png` exactly (open them as images; do not invent UI). Two top states: 未登录 (hero search + skill cards) and 已登录 (workspace list + avatar menu). Expanded workspace is a three-column chat UI (tool-status indicators, copyable code blocks, file cards 预览/下载, 下一步建议 links, right panel toggling 聊天记录 ↔ 工作区产物). Accent is indigo/violet; map brand color to shadcn `--primary` via `@theme`.

### Verify every change
- `npm run build` (Turbopack + typecheck) passes.
- `npm run lint` passes.
- Default Server Component; add `'use client'` only for interactive components.
