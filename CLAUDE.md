# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is an npm workspaces monorepo (Node.js >=20.6.0, ES modules) for **Inno Agent**, a personal learning agent built on the PI SDK.

- `apps/inno-agent/` — backend (CLI + HTTP server), TypeScript, compiles to `dist/`.
- `apps/inno-agent/web/` — frontend (React 19 + Lit + Tailwind 4 + Vite), workspace `inno-agent-web`.
- `electron/` — Electron main process (`main.js` + `loading.html`) for desktop builds.
- `build/` — desktop app icons (`icon.icns`, `icon.png`, `icon.svg`).
- `scripts/` — Electron build hooks (`after-pack.cjs`, `build-mac.sh`).
- `docs/` — screenshots and use-case guides.
- `runtime/` — local runtime state (config, data, skills); gitignored. Mapped to `INNO_*` env vars.
- `workspace/` — default agent working directory; gitignored.

PI SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) are pulled from npm.

Key dependencies: `ws` (WebSocket), `node-pty` (PTY terminal), `cron-parser` (scheduler), `@larksuiteoapi/node-sdk` (Feishu), `typebox` (validation), `undici` (HTTP client), `@juicesharp/rpiv-ask-user-question` (bridges agent `ask_user_question` tool calls to the web UI), `pi-subagents` (optional subagent support), `pi-sandbox` (optional OS-level sandboxing).

`vitest` is a dev dependency but no test scripts or test files exist — the TypeScript build (`npm run build`) serves as the sanity check. No ESLint or Prettier configuration exists.

### TypeScript configs

Three tsconfig files, each self-contained (no `extends` chain):

- **`tsconfig.base.json`** (repo root) — reference base: `ES2022` target, `Node16` module/resolution, strict mode, `sourceMap`, `declaration` + `declarationMap`, `experimentalDecorators`, `emitDecoratorMetadata`, `resolveJsonModule`, `useDefineForClassFields: false`. Not directly referenced by the other configs but documents the shared settings.
- **`apps/inno-agent/tsconfig.json`** — backend: `outDir: ./dist`, `rootDir: ./src`, `types: ["node"]`. Compiles `src/foo.ts` → `dist/foo.js`. The compiled server entry point is `dist/server.js` and CLI entry is `dist/cli.js`.
- **`apps/inno-agent/web/tsconfig.json`** — frontend: `ESNext` module, `bundler` resolution, `lib` includes DOM/DOM.Iterable, `jsx: "react-jsx"`, `noEmit: true`, `isolatedModules: true`, `experimentalDecorators: true`, `useDefineForClassFields: false` (both needed for Lit decorator syntax in legacy components). TypeScript is only for type-checking during `vite build` — Vite handles the actual bundling.

`tsx` is available as a dev dependency for running TypeScript files directly without compilation (e.g., `npx tsx some-script.ts`).

### Reference docs

- **[README.md](./README.md)** — full project overview, design rationale, features, deployment, contributing.
- **[QUICKSTART.md](./QUICKSTART.md)** — 5-minute setup guide (Chinese) with provider config examples.
- **[ELECTRON_BUILD.md](./ELECTRON_BUILD.md)** — Electron packaging notes (Chinese).
- **[apps/inno-agent/README.md](./apps/inno-agent/README.md)** — backend API route table and project structure (Chinese).

## Common Commands

All commands are run from the repo root and use `npm --workspace` under the hood.

```bash
# Build backend + web
npm run build

# Start HTTP server (serves API + web/dist on port 3000)
npm run server -- --home ./runtime --workspace ./workspace --port 3000

# Start CLI (terminal agent, no HTTP)
npm run start -- --home ./runtime --workspace ./workspace

# Sandbox mode (pi-sandbox enabled, isolates agent tool execution)
npm run sandbox -- --home ./runtime --workspace ./workspace
npm run server:sandbox -- --home ./runtime --workspace ./workspace --port 3000

# Dev: run server and Vite dev separately
npm run dev:server      # backend on :3000
npm run web:dev         # Vite on :5173, proxies /api -> :3000

# Watch mode (TypeScript recompile on change)
npm run dev             # `tsc --watch` in apps/inno-agent (backend only, does not rebuild frontend)

# Run a TypeScript file directly without building
npx tsx some-script.ts

# restart-dev.sh orchestration
npm run restart         # full build + dev restart
npm run restart:fast    # skip build, restart only
```

### First-run setup

```bash
mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json — set providers[*].apiKey
```

An `.env.example` file is provided at the repo root with default `INNO_*` env var values for local development.

### Dev restart rules

- Changes to `src/server.ts` or backend API → `npm run build` + restart server.
- Changes to `web/vite.config.ts` → restart Vite.
- Changes under `web/src/` → Vite HMR usually handles it.
- If upload/Wiki/proxy behavior misbehaves, fully restart both. Health checks: `curl localhost:3000/health`, `curl localhost:5173/api/wiki/pages`.

### restart-dev.sh

The `restart-dev.sh` script at the repo root orchestrates the full dev lifecycle:

```bash
bash restart-dev.sh              # build + dev mode start both frontend and backend
bash restart-dev.sh --skip-build # skip compilation, restart processes only
bash restart-dev.sh status       # show process health and port status
bash restart-dev.sh logs server  # tail backend logs
bash restart-dev.sh logs web     # tail frontend logs
bash restart-dev.sh smoke        # run health/session/WS smoke tests
bash restart-dev.sh stop         # stop all managed processes
bash restart-dev.sh --help       # list all options
```

Supports `--mode dev|prod`, `--skip-build`, `--sandbox`/`--no-sandbox`, `--port <N>`. Equivalent npm shortcuts: `npm run restart` (full), `npm run restart:fast` (skip build).

### Electron desktop builds

```bash
npm run electron              # Run desktop app locally
npm run electron:build        # Package macOS DMG (arm64)
npm run electron:build:win    # Package Windows NSIS + MSI (x64)
```

`electron/main.js` spawns the Node server as a child process (`ELECTRON_RUN_AS_NODE=1`), shows a loading window while polling `/health`, then opens the main window. First launch creates a default config at `~/.inno-agent/config/config.json`.

### Electron build scripts

- **`scripts/after-pack.cjs`** — electron-builder hook that fixes `node-pty`'s `spawn-helper` executable permissions after packaging. Without this, the in-app terminal fails on macOS/Linux. Declared in `package.json`'s `build.afterPack`.
- **`scripts/build-mac.sh`** — local macOS packaging script (alternative to CI). Supports `--bump patch|minor|major` for version increment and `--open` to open the output DMG.

### CI/CD

GitHub Actions workflows (`.github/workflows/`):
- `release-mac.yml` — macOS Electron DMG builds on ARM64, triggered by `v*.*.*` tags or workflow_dispatch.
- `release-win.yml` — Windows NSIS + MSI builds on x64, same trigger.

## Design Philosophy

Inno Agent is a **personal learning agent** — not a general coding agent. Key stances that shape the codebase:

- **Layered memory, not a flat chat summary.** Learner state (L1), archived knowledge (L2), and recent dialogue (L3) have different lifecycles — each lives in its own layer with explicit boundaries enforced in the system prompt and storage layout.
- **Durable facts go to tools, not replies.** Anything that affects future teaching is written to L1/L2 via tools, so personalization decisions are evidence-driven and traceable.
- **An open, correctable learner model.** The L1 profile is inspectable and editable by the learner; the system prompt forbids unevidenced labels.
- **The PI SDK kernel is never modified.** All learning behavior is added through registered tools and a single extension hook (`createInnoExtension`), keeping the agent runtime upstream-compatible.

## Runtime Path Resolution

Both `cli.ts` and `server.ts` bootstrap through `apps/inno-agent/src/runtime.ts`. This is the single source of truth for where data lives.

Precedence: CLI flag → env var → `~/.inno-agent/...`.

| CLI flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config` | `INNO_CONFIG_FILE` | `<configDir>/config.json` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` / `--data-dir` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` / `--skills-dir` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` (via config) | `3000` |

Derived paths inside `dataDir`: `learner/`, `sessions/`, `jobs/`, `l2/`, `l3/`, `channels/`. `applyRuntimeEnvironment` re-exports the resolved paths back into `process.env` plus `PI_CODING_AGENT_SESSION_DIR` so PI SDK code picks them up. It also sets `PI_CODING_AGENT_DIR` to `configDir` so pi-sandbox reads `sandbox.json` from the config directory.

When editing path-related code, change `runtime.ts` rather than hard-coding paths in `cli.ts`/`server.ts`.

## Architecture

### Agent core (PI SDK + Inno extension)

The agent loop is provided by `@earendil-works/pi-coding-agent` (npm). Inno wraps it with an extension factory in `apps/inno-agent/src/agent/inno-extension.ts`, which:

1. Registers model providers from `config.json` via `pi.registerProvider` (e.g. an InnoSpark Anthropic-compatible endpoint).
2. Registers six tool groups: **learner tools** (L1), **scheduler tools**, **L2 wiki tools**, **L3 recall tools**, **practice lab tools**, **document tools**.
3. Hooks `before_agent_start` to prepend `INNO_SYSTEM_PROMPT` + an L1 context pack (profile + recent events) + threshold-gated L3 recall to the system prompt for every turn.
4. Hooks `session_start` to install custom TUI header/title.
5. Persists `model_select` events back to `config.json`.

Key files in `apps/inno-agent/src/agent/`:
- `system-prompt.ts` — defines `INNO_SYSTEM_PROMPT`, the core educational instruction prompt injected every turn.
- `inno-extension.ts` — extension factory that wires everything together (tools, hooks, skills).
- `pi-runner.ts` — server-side facade around PI session APIs (`initSession`, `createNewSession`, `runPromptStreaming`, `completePromptOnce`, `switchModel`, etc.), shared by REST + SSE endpoints.
- `provider-sync.ts` — syncs providers from config into PI runtime and subagents.
- `question-bridge.ts` — bridges `ask_user_question` tool calls from agent to web UI via an EventEmitter.
- `practice-tools.ts` — Practice Lab tools (run commands, read run records).
- `document-tools.ts` — file uploads, workspace file reading, document preview (CSV, Office formats).

`cli.ts` calls PI's `main(...)` with this extension and forces `--no-skills --skill <skillsDir>` so only the project's skills directory is loaded.

`server.ts` (HTTP) goes through `agent/pi-runner.ts`. Both entry points import `source-map-support/register` at the top to produce readable error stacks from compiled JS, and both call `applyRuntimeEnvironment` from `runtime.ts` to resolve and export paths into `process.env` before anything else runs.

The Electron main process (`electron/main.js`) spawns the server as a child process with `ELECTRON_RUN_AS_NODE=1` and passes `--server` as the first argument to ensure server mode.

### Storage layer (`src/storage/`)

`file-store.ts` is the general-purpose JSON file persistence layer. Used by multiple subsystems (learner profile, jobs, wiki manifest) as a thin typed wrapper over `readFileSync`/`writeFileSync` with atomic writes.

### Memory system

Three layers, all file-backed under `dataDir`:

- **L1 learner profile** (`src/memory/learner/`): evidence-driven profile + event log. `profile-store.ts` persists learner state; `profile-updater.ts`/`auto-profile.ts` mutate the profile from tool calls. Summarized into a `ContextPack` injected each turn. The learner can inspect and edit their profile directly.
- **L2 wiki memory** (`src/memory/l2/`): a structured wiki with `manifest-store.ts`, `raw-store.ts`, `wiki-maintainer.ts` (parses frontmatter), `wiki-linker.ts`, `wiki-query.ts`, plus a `summarizer.ts`, `source-converter.ts`, and `document-parser.ts` (handles PDF, Office documents, images). Exposed both to the agent (as tools) and to the web UI via `/api/wiki/*` (pages list, page CRUD, graph, stats).
- **L3 cross-conversation recall** (`src/memory/l3/`): indexes PI session JSONL files into SQLite (`node:sqlite`) with FTS5 full-text search for lexical retrieval. `sqlite-store.ts` manages the schema (chunks + embeddings tables). `indexer.ts` extracts messages from session files. `recall.ts` performs threshold-gated retrieval (`l3_recall` tool). Degrades gracefully on Node <22.5 (where `node:sqlite` is unavailable) — L3 recall is simply disabled.

### Scheduler

`src/scheduler/` implements cron-driven background jobs. `JobStore` persists `jobs.json` and appends `runs.jsonl` per execution. `CronScheduler` (uses `cron-parser`) triggers `job-runner.executeJob`. Jobs can also be invoked manually via `/api/jobs/:id/run` or from the agent itself via the `run_scheduled_job` tool. On boot, `normalizePersistedJobs` backfills `nextRunAt`/`lastStatus`/`runCount` fields, and `migrateReminderChannels` repoints legacy `push_reminder` jobs to the registered default Feishu target.

### Channels

`src/channels/` defines a `ChannelRegistry` and registers channels when their respective config blocks are present:

- **Feishu** (`feishu/feishu-channel.ts`): native Lark/Feishu integration via `@larksuiteoapi/node-sdk`.
- **QQ** and **WeChat** (`bridge/bridge-channel.ts`): bridge/sidecar mode — the agent communicates with an external sidecar process over HTTP, which handles the actual IM protocol. Each has a `sidecarBaseUrl` in config. Inbound messages arrive via `bridge/bridge-server.ts`, a local HTTP server that receives callbacks from sidecars.
- **WeChat iLink** (`wechat/ilink-client.ts`): alternative non-bridge WeChat mode using iLink protocol instead of a sidecar.
- `personal-dispatcher.ts` pushes reminders and messages back out through registered channels.
- `channel-tools.ts` exposes agent tools (`send_file_to_channel`, etc.) for interacting with channels.
- `dedupe-store.ts` prevents duplicate message delivery; `run-log.ts` tracks channel operation outcomes.

### HTTP server (`src/server.ts`)

Plain Node `http.createServer` (no framework). Key endpoints:
- `POST /api/chat/stream` — SSE streaming chat.
- `POST /api/chat` — non-streaming chat (full response).
- `GET/PUT /api/wiki/*` — wiki CRUD, graph, stats.
- `GET/POST/PATCH/DELETE /api/jobs[/:id]` — job management; `POST /api/jobs/:id/run` for manual execution.
- `GET /api/sessions` / `GET /api/sessions/:id` — session listing.
- `GET /api/skills` — list loaded skills.
- `POST /api/skills/upload` — accepts `<skill-name>.zip`, unpacks into `skillsDir/<name>/` via `spawnSync('unzip', ...)`.
- `PATCH /api/skills/:name` — enable/disable a skill.
- `DELETE /api/skills/:name` — remove a skill.
- `POST /api/skills/reload` — reload PI resources after skill changes.
- `GET /api/settings` — current config (redacted API keys).
- `GET /health` — health check (polled by Electron loading screen).
- WebSocket upgrade for `/api/terminal` — xterm.js in-browser terminal.

Static frontend is served from `paths.webDistDir = apps/inno-agent/web/dist` when present. Skills are loaded from `paths.skillsDir` (defaults to `<home>/skills` but can be pointed at `.inno/skills/` for project-local skills).

### Terminal / Practice Lab (`src/terminal/`)

In-browser terminal (xterm.js over WebSocket) scoped to a workspace. `terminal-session-manager.ts` manages PTY sessions via `node-pty` (`local-pty-backend.ts`). `run-record-store.ts` persists run records that the agent can read (via practice tools in `agent/practice-tools.ts`), enabling the agent to observe command outputs in the Practice Lab.

### Workspace management (`src/workspace/`)

`workspace-registry.ts` manages multiple workspace directories. Each workspace has a `WorkspaceMeta` record (id, name, path, temp flag) persisted in `workspaces.json`. Sessions are bound to workspaces. The default workspace is the invocation CWD. Temp workspaces are auto-created for one-off tasks and cleaned up later.

### Document tools (`agent/document-tools.ts`)

Handles file uploads, workspace file reading, and document preview (CSV, Office formats). Uses `@llamaindex/liteparse` for document parsing. Works alongside the L2 wiki's `document-parser.ts` for ingestion into the knowledge base.

### Subagents (`pi-subagents`)

Optional subagent support via `pi-subagents` package, configured with `subagents.enabled` in `config.json`. When enabled, the agent can spawn sub-agents for parallel or isolated tasks.

### Skills loading

Skills are loaded from `paths.skillsDir`, which defaults to `<home>/skills` but is pointed at `.inno/skills/` for development. Skills are Markdown files that declare agent capabilities, tool restrictions, and custom instructions. The PI SDK parses skill YAML frontmatter for metadata.

- `cli.ts` forces `--no-skills --skill <skillsDir>` — disables PI's built-in skills, loads only from the project's skills directory.
- `server.ts` loads skills from `paths.skillsDir` via `loadSkillsFromDir`.
- The web UI lists skills via `GET /api/skills` and allows upload of `<skill-name>.zip` files via `POST /api/skills/upload` (unzips into skills dir).
- Skills are re-indexed on server startup and after upload/reload.

### Sandbox (`pi-sandbox`)

Optional OS-level sandbox for agent bash/file operations, enabled with `--sandbox` flag (requires `ripgrep`). Configured via:

- **Global**: `<configDir>/sandbox.json` (typically `runtime/config/sandbox.json`)
- **Project-level** (higher priority): `<workspaceDir>/.pi/sandbox.json`

Configuration supports `network.allowedDomains` and `filesystem` policies (`allowRead`, `denyRead`, `allowWrite`, `denyWrite`) with glob patterns. Intercepted operations trigger interactive prompts (allow once/project/globally).

The `PI_CODING_AGENT_DIR` env var is set to `configDir` in `runtime.ts` so pi-sandbox can locate its config.

### Web UI

Hybrid React + Lit. Mounts in `web/src/main.tsx` → `react/App.tsx`. State lives in framework-agnostic `stores/` (small `EventEmitter`-based stores: `chat-store`, `sessions-store`, `wiki-store`, `jobs-store`, `skills-store`, `settings-store`, `workspace-store`, `workspaces-store`, `learner-store`, `notebook-store`, `terminal-store`, `graph-store`, `app-store`). Each store extends `EventEmitter` — components subscribe to change events and re-render on state mutation. REST/SSE calls go through `web/src/api/`. Some legacy Lit components remain under `components/`. Tailwind 4 via `@tailwindcss/vite`.

**Component convention**: New components should be React (in `web/src/react/`). The `web/src/components/` directory holds legacy Lit Web Components that predate the React migration. Do not add new Lit components.

**Store pattern**: Each store in `web/src/stores/` extends `EventEmitter` and manages a domain (chat, sessions, wiki, etc.). React components import the store singleton, read state snapshots, and subscribe to change events (typically via `useEffect` or a shared `hooks.ts`). All API calls happen through `web/src/api/client.ts`, a thin `fetch` wrapper that all domain-specific API modules (`api/chat.ts`, `api/wiki.ts`, etc.) use. Stores never call `fetch` directly — they go through the `api/` layer.

Key UI dependencies: `cytoscape` (wiki graph), `@xterm/xterm` (in-browser terminal), `@uiw/react-codemirror` (code editor), `@uiw/react-md-editor` (markdown editor), `motion` (animations).

**i18n**: The UI supports Chinese (`zh-CN`, default) and English (`en`), managed by `i18next` + `react-i18next` in `web/src/i18n/`. Locale is persisted to `localStorage` under `inno.locale`.

### Vite config (`web/vite.config.ts`)

The Vite config has three custom plugins and code-splitting:

- **`stubLmStudioPlugin`** — stubs out `@lmstudio/sdk` (a pi-web-ui dependency not used by inno-agent) to avoid bundling it.
- **`link-katex-fonts`** — creates a symlink `node_modules/@earendil-works/pi-web-ui/dist/fonts` → `node_modules/katex/dist/fonts` so Vite resolves KaTeX font URLs from pi-web-ui's built CSS.
- **`inno-dev-upload-api`** — Vite dev server middleware on `POST /api/l2/raw/upload` for L2 raw file uploads during development (proxies to the backend in production).
- **`manualChunks`** — code-splits `codemirror`, `markdown-editor`, `cytoscape`, and `katex` into separate bundles.

Vite dev server runs on port 5173 and proxies `/api` and `/health` to `http://localhost:3000`.

### Logger (`src/logger.ts`)

Pino-based logger with daily rotation to `<INNO_DATA_DIR>/log/server-YYYY-MM-DD.log`. Uses `pino-caller` to annotate each log entry with the TypeScript source location. The log directory and file are created lazily on the first write call (not at process startup). Log level is controlled via `LOG_LEVEL` env var (defaults to `"info"`). The `DailyRotateStream` custom `Writable` checks the date on each write and rotates to a new file when the day changes.

## Docker

A multi-stage `Dockerfile` and `docker-compose.yml` are provided as deployment starting points:

- **Build stage** (`node:22-bookworm-slim`): installs build tools for `node-pty` native deps (python3, make, g++), runs `npm ci` + `npm run build`, then `npm prune --production`.
- **Runtime stage**: copies only `dist/` artifacts and production `node_modules`. Sets `NODE_ENV=production` and all `INNO_*` env vars for a production layout (`/etc/inno-agent` for config, `/var/lib/inno-agent` for data/skills, `/srv/inno-workspace` for workspace). Exposes port 3000.
- **`docker-compose.yml`**: single service mapping port 3000, with volume mounts for `runtime/config/`, `runtime/data/`, `runtime/skills/`, and `workspace/`.
- **`.dockerignore`**: excludes `node_modules/`, `dist/`, `runtime/`, `workspace/`, `.env`, `.git`.

## Configuration

Runtime config lives at `<configDir>/config.json` (template: `config.example.json` at repo root). It declares `defaultProvider`, `defaultModel`, a `providers` map (each with `baseUrl`, `api` ∈ {`openai-completions`, `anthropic-messages`}, `apiKey`, `models[]`), optional `server.port`, optional `channels.feishu` / `channels.qq` / `channels.wechat` blocks, optional `bridge.token` (for bridge-mode channels), and optional `subagents.enabled`. The server hot-rewrites this file when the user switches model via the UI.

Model config supports `reasoning` (boolean), `contextWindow`, and `maxTokens` per model entry.

Full config.json structure (see `config.example.json`):
```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": { /* ... */ },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false, "personalOnly": true, "allowedUserIds": [] },
    "qq":     { "enabled": false, "mode": "bridge", "personalOnly": true, "allowedUserIds": [], "sidecarBaseUrl": "http://127.0.0.1:4318" },
    "wechat": { "enabled": false, "mode": "bridge", "personalOnly": true, "allowedUserIds": [], "sidecarBaseUrl": "http://127.0.0.1:4319" }
  },
  "bridge": { "token": "replace-me" },
  "subagents": { "enabled": false },
  "memory": { "l3Enabled": true }
}
```

`memory.l3Enabled` gates cross-conversation recall (L3). `bridge.token` is the shared secret for bridge-mode IM channels (QQ, WeChat). Each channel supports `personalOnly` (restrict to specified users) and `allowedUserIds` (whitelist of user IDs).

**Config manipulation** is centralized in `apps/inno-agent/src/config.ts` (`normalizeConfig`, `saveConfig`, `setDefaultModel`, `upsertProvider`, `deleteProvider`, `getConfiguredPort`). It handles legacy config migration (`openai` → `providers.openai-custom`) and normalizes missing fields with sensible defaults. All config writes should go through these helpers rather than directly writing the JSON file.

The backend package declares a `bin` entry (`"inno": "dist/cli.js"`), so after a global install the `inno` command is available.
