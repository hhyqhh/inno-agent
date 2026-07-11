# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

### Build & Run Commands

```bash
# Build everything (backend + frontend)
npm run build

# Development (two terminals)
npm run dev:server      # Backend on :3000
npm run web:dev         # Frontend on :5173 (proxies /api → :3000)

# Production
npm run server -- --home ./runtime --workspace ./workspace --port 3000

# CLI mode (no HTTP)
npm run start -- --home ./runtime --workspace ./workspace

# Dev restart helper (restart-dev.sh)
npm run restart         # Full build + restart (default: dev mode)
npm run restart:fast    # Skip build, restart only

# restart-dev.sh subcommands
bash restart-dev.sh restart            # Build + restart services
bash restart-dev.sh restart --skip-build  # Restart without rebuilding
bash restart-dev.sh restart --sandbox  # Restart with pi-sandbox enabled
bash restart-dev.sh start              # Start services without building
bash restart-dev.sh stop               # Stop all services
bash restart-dev.sh status             # Show service status (PID + health)
bash restart-dev.sh logs server        # Tail server.log
bash restart-dev.sh logs vite          # Tail vite.log
bash restart-dev.sh logs both          # Tail both logs (default)
bash restart-dev.sh smoke              # Run smoke tests (health + session + WS probe)
bash restart-dev.sh build              # Run npm run build only

# restart-dev.sh modes
bash restart-dev.sh --mode dev         # Backend (:3000) + Vite (:5173) with HMR (default)
bash restart-dev.sh --mode prod        # Backend only, serves built web/dist
```

### Testing

No test suite exists. The TypeScript build (`npm run build`) serves as the sanity check. No ESLint or Prettier configuration exists.

### First-Time Setup

```bash
mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json — set providers[*].apiKey
```

## Repository Layout

This is an npm workspaces monorepo (Node.js >=20.6.0, ES modules) for **Inno Agent**, a personal learning agent built on the PI SDK.

```
apps/inno-agent/          Backend (CLI + HTTP server), TypeScript → dist/
apps/inno-agent/web/      Frontend (React 19 + Lit + Tailwind 4 + Vite)
electron/                 Electron main process for desktop builds
build/                    Desktop app icons
scripts/                  Electron build hooks + self-hosted content hub server
docs/                     Screenshots, use-case guides, SYSTEM_DEPENDENCIES.md
runtime/                  Local runtime state (config, data, skills); gitignored
workspace/                Default agent working directory; gitignored
```

### Key Dependencies

- **PI SDK** (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) — agent runtime, pulled from npm
- `ws` — WebSocket for terminal sessions
- `node-pty` — PTY for in-browser terminal
- `cron-parser` — scheduler
- `@larksuiteoapi/node-sdk` — Feishu integration
- `typebox` — validation
- `undici` — HTTP client (with 15-min body timeout safety net)
- `pi-subagents` — optional subagent support
- `pi-sandbox` — optional OS-level sandboxing (requires `ripgrep`)

### TypeScript Configuration

Three self-contained tsconfig files (no `extends` chain):

- **`tsconfig.base.json`** — reference base: `ES2022`, `Node16` module, strict mode
- **`apps/inno-agent/tsconfig.json`** — backend: `outDir: ./dist`, `rootDir: ./src`, compiles `src/foo.ts` → `dist/foo.js`
- **`apps/inno-agent/web/tsconfig.json`** — frontend: `ESNext` module, `bundler` resolution, `noEmit: true` (Vite handles bundling)

Use `tsx` (dev dependency) to run TypeScript files directly: `npx tsx some-script.ts`

## Architecture

### Core Design Philosophy

Inno Agent is a **personal learning agent** — not a general coding agent. Key principles:

- **Layered memory**: L1 (learner profile), L2 (wiki knowledge base), L3 (session records with cross-conversation retrieval) have different lifecycles
- **Tools over replies**: Durable facts are written to L1/L2 via tools, making personalization evidence-driven
- **Open learner model**: L1 profile is inspectable and editable; the system prompt forbids unevidenced labels
- **PI SDK kernel unchanged**: All learning behavior added through registered tools and `createInnoExtension`

### Data Flow

```
User Interfaces      CLI · Web UI (React) · Feishu · WeChat · QQ
        ↓
Application Layer    Channel adapters · HTTP API (SSE) · Memory orchestration
                     Cron scheduler · Practice Lab · WebSocket terminal
        ↓
Agent Runtime        Pi AgentSession · registered tools · inno extension
(Pi SDK, unmodified) General LLM provider ──or── distilled educational model
        ↓
Layered Memory       L1 learner profile · L2 native wiki · L3 session records
```

### Key Architectural Patterns

**Lazy Bootstrap**: `server.ts` defers all directory creation, store initialization, and agent session setup until the first meaningful API request (not `/health` or static files). `ensureBootstrapped()` is idempotent and handles concurrent requests via a shared promise.

**Prompt Queue Serialization**: All prompt operations in `pi-runner.ts` go through `enqueue()`, a serial queue ensuring only one prompt runs at a time (PI SDK session is single-threaded). `completePromptOnce` intentionally bypasses the queue for stateless metadata completions (like session titles).

**Session File Persistence**: PI SDK creates session files lazily (on first assistant message). `persistPendingUserTurn()` handles race conditions by appending placeholder messages when prompts are aborted before completion.

**Source-Map-Support**: Both `server.ts` and `cli.ts` import `source-map-support/register.js` as their first import. Critical for debugging — without it, stack traces show compiled JS locations instead of TypeScript source.

**Two-Layer Timeout**: Undici HTTP client sets `bodyTimeout: 900_000` (15 min) as safety net. Provider-level timeout (`retry.provider.timeoutMs`, default 10 min) fires first. Prevents hung connections from leaking.

**Skills Reload**: When skills are uploaded/modified, `scheduleSkillsReload()` fires `reloadResources()` without awaiting. Awaiting would block the HTTP response indefinitely because reload is serialized behind the agent prompt queue.

### Key Source Files

#### Agent Core (`apps/inno-agent/src/agent/`)

- **`inno-extension.ts`** — Extension factory that registers providers, tools, and hooks. Loads per-workspace context (`agent.md` + `.skills/`)
- **`system-prompt.ts`** — Core educational instruction prompt (Chinese-only) injected every turn. Defines L1/L2/L3 memory usage rules, teaching strategies, and behavioral guidelines
- **`pi-runner.ts`** — Server-side facade around PI session APIs. Handles auto-retry on LLM API failures
- **`provider-sync.ts`** — Syncs providers from config into PI runtime
- **`question-bridge.ts`** — Bridges `ask_user_question` tool calls to web UI
- **`practice-tools.ts`** — Practice Lab tools (run commands, read run records)
- **`document-tools.ts`** — File uploads, workspace file reading, document preview
- **`observability-extension.ts`** — Two-layer observability for session lifecycle and per-turn execution

#### Memory System (`apps/inno-agent/src/memory/`)

- **L1 Learner Profile** (`learner/`): Evidence-driven profile + event log. `profile-store.ts` persists state; `context-cache.ts` writes precomputed context for fast injection
- **L2 Wiki Memory** (`l2/`): Structured wiki with `manifest-store.ts`, `wiki-maintainer.ts` (parses frontmatter), `wiki-linker.ts`, `document-parser.ts` (PDF, Office, images)
- **L3 Session Recall** (`l3/`): Indexes session JSONL into SQLite (`node:sqlite`) with FTS5. Degrades gracefully on Node <22.5

#### Scheduler (`apps/inno-agent/src/scheduler/`)

Cron-driven background jobs. `JobStore` persists `jobs.json` + `runs.jsonl`. Jobs runnable from agent (`run_scheduled_job`), UI, or API.

#### Channels (`apps/inno-agent/src/channels/`)

- **Feishu** (`feishu/`): Native Lark/Feishu integration
- **QQ/WeChat** (`bridge/`): Bridge/sidecar mode via HTTP
- **WeChat iLink** (`wechat/`): Alternative non-bridge mode with QR login
- **Feishu Registration** (`feishu/feishu-registration.ts`): QR device-flow registration for Feishu app credentials
- `personal-dispatcher.ts` pushes reminders back through channels

#### HTTP Server (`apps/inno-agent/src/server.ts`)

Plain Node `http.createServer` (no framework). Key endpoint categories:

- **Chat**: `POST /api/chat` (sync), `POST /api/chat/stream` (SSE), `POST /api/chat/abort`, `POST /api/chat/question-response`
- **Sessions**: `GET/POST /api/sessions`, `GET /api/sessions/:id`
- **Wiki**: `GET/PUT/DELETE /api/wiki/page`, `GET /api/wiki/pages`, `GET /api/wiki/graph`, `GET /api/wiki/stats`
- **Jobs**: `GET/POST/PATCH/DELETE /api/jobs[/:id]`, `POST /api/jobs/:id/run`, `GET /api/jobs/status`, `GET /api/jobs/runs`
- **Skills**: `GET /api/skills`, `POST /api/skills/upload`, `PATCH/DELETE /api/skills/:name`, `POST /api/skills/reload`
- **Skill Library**: `GET /api/skill-library`, `POST /api/skill-library/import`
- **Workspace**: `GET /api/workspace/tree`, `GET /api/workspace/file`, `PUT /api/workspace/file`, `POST /api/workspace/create`, `POST /api/workspace/rename`, `POST /api/workspace/delete`, `POST /api/workspace/move`, `POST /api/workspace/upload`
- **Workspaces**: `GET/POST /api/workspaces`
- **Learner**: `GET/PATCH /api/learner/profile`, `POST /api/learner/profile/goals`
- **Settings**: `GET /api/settings`, `POST /api/settings/model`, `PUT/PATCH/POST /api/settings/providers`, `PUT /api/settings/channels`, `PUT /api/settings/memory`, `PUT /api/settings/theme`
- **Terminal**: `POST /api/terminal/sessions`, WebSocket `/api/terminal/sessions/:id/ws`
- **L2 Uploads**: `POST /api/l2/raw/upload`
- **Presets**: `GET /api/presets`, `GET /api/preset-library`
- **Channels**: `GET /api/channels`, `POST /api/bridge/messages`, Feishu/WeChat QR registration

Full API route table: [apps/inno-agent/README.md](./apps/inno-agent/README.md)

#### Terminal / Practice Lab (`apps/inno-agent/src/terminal/`)

In-browser terminal (xterm.js over WebSocket) scoped to workspace. `command-resolver.ts` maps file extensions to run commands (`.py` → `python`, `.ts` → `npx tsx`, etc.)

#### Workspace Management (`apps/inno-agent/src/workspace/`)

`workspace-registry.ts` manages multiple workspace directories. Sessions are bound to workspaces. Default workspace is invocation CWD.

### Runtime Path Resolution

Both `cli.ts` and `server.ts` bootstrap through `apps/inno-agent/src/runtime.ts`. Precedence: CLI flag → env var → `~/.inno-agent/...`.

| CLI flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config` | `INNO_CONFIG_FILE` | `<configDir>/config.json` |
| `--data` / `--data-dir` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` / `--skills-dir` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` (via config) | `3000` |

Derived paths inside `dataDir`: `learner/`, `sessions/`, `jobs/`, `l2/`, `l3/`, `channels/`, `preset-cache/`

Session metadata files (under `<dataDir>/sessions/`):
- `channels.json` — channel tags per session (source of truth)
- `meta.json` — topic metadata per session (auto-generated for channel sessions)
- `archives.json` — archive status per session

**Important**: When editing path-related code, change `runtime.ts` rather than hard-coding paths.

### Web UI Architecture

Hybrid React + Lit. Mounts in `web/src/main.tsx` → `react/App.tsx`.

- **State management**: Framework-agnostic `EventEmitter` stores in `web/src/stores/` (chat, sessions, wiki, jobs, skills, settings, workspace, learner, terminal, etc.). Use `useStoreSnapshot` hook (`web/src/react/hooks.ts`) to bridge stores to React components.
- **API layer**: `web/src/api/client.ts` — thin `fetch` wrapper used by all domain-specific API modules
- **Components**: New components should be React (`web/src/react/`). Legacy Lit components in `web/src/components/`
- **Theme system**: Four themes (light, warm, ocean, innospark) in `web/src/themes.css`, persisted to localStorage + backend
- **i18n**: Chinese (`zh-CN`, default) and English (`en`) via `i18next`

Key UI dependencies: `cytoscape` (wiki graph), `@xterm/xterm` (terminal), `@uiw/react-codemirror` (code editor), `@uiw/react-md-editor` (markdown), `motion` (animations), `lucide-react` (icons)

### Vite Configuration (`web/vite.config.ts`)

- `stubLmStudioPlugin` — stubs out unused `@lmstudio/sdk`
- `link-katex-fonts` — symlinks KaTeX fonts for pi-web-ui
- `inno-dev-upload-api` — dev server middleware for L2 uploads
- `manualChunks` — code-splits heavy dependencies

Dev server on port 5173, proxies `/api` and `/health` to `localhost:3000`.

## Configuration

### User-Facing Config (`<configDir>/config.json`)

Template: `config.example.json`. Key sections:
- `providers` — LLM provider configs (baseUrl, api type, apiKey, models)
- `channels` — Feishu, QQ, WeChat integrations
- `feishu` — Feishu app credentials (appId, appSecret) — separate from `channels.feishu`
- `ocrApi` — OCR service config (token, model, baseUrl) for image text extraction
- `memory` — L1/L2/L3 toggles
- `simpleMode` — hides advanced features, surfaces preset workspaces
- `contentHub` — remote source for skills/presets (github or bundle)
- `ui.theme` — persisted theme preference

### Config Manipulation

Centralized in `apps/inno-agent/src/config.ts`. Use these helpers:
- `normalizeConfig` — fills defaults, handles legacy migration
- `saveConfig`, `setDefaultModel`, `upsertProvider`, `deleteProvider`, `deleteModel`
- `getConfiguredPort` — resolves port from CLI > env > config > 3000

**Never write config.json directly** — always go through these helpers.

**Lazy Loading**: Config is loaded on first API request in `server.ts`, not at startup. Port resolution happens before config load (from CLI/env only). Changing config.json while server is running requires explicit reload via settings API.

### PI SDK Settings (`<configDir>/settings.json`)

Managed by `pi-runner.ts`:
- `retry.provider.timeoutMs` (default 600000ms = 10 min) — LLM request timeout
- `defaultProvider` / `defaultModel` — can override config.json defaults

## Development Workflows

### When to Rebuild

- Changes to `src/server.ts` or backend API → `npm run build` + restart server
- Changes to `web/vite.config.ts` → restart Vite
- Changes under `web/src/` → Vite HMR usually handles it
- If upload/Wiki/proxy behavior misbehaves, fully restart both

Health checks: `curl localhost:3000/health`, `curl localhost:5173/api/wiki/pages`

Logs directory: `<home>/logs/` (default `./runtime/logs/`):
- `server.log` — backend output
- `vite.log` — Vite dev server output
- `server.pid` / `vite.pid` — PID files for service management

Smoke test (`bash restart-dev.sh smoke`): verifies health endpoint, workspace list, session creation, terminal creation, and WebSocket upgrade probe.

### Skills Development

Skills are Markdown files loaded from `paths.skillsDir` (defaults to `<home>/skills`). The PI SDK parses YAML frontmatter for metadata.

- `cli.ts` forces `--no-skills --skill <skillsDir>` — loads only project skills
- `server.ts` loads from `paths.skillsDir` via `loadSkillsFromDir`
- Web UI: `POST /api/skills/upload` (zip), `GET/PUT /api/skills/:name/content` (edit)
- Content Hub provides remote skill library (`contentHub` config)

### Workspace Context

Each workspace can have:
- `agent.md` — per-workspace instructions injected each turn
- `.skills/` — private skills merged with global skills
- `.chat-images/` — persisted images uploaded via web UI chat (base64-decoded)

### Presets / Simple Mode

Preset workspaces are templates with `preset.json` + `agent.md` + `.skills/`. Fetched from content hub, cached in `<dataDir>/preset-cache/`. Bundled presets in `apps/inno-agent/presets/` serve as offline fallback.

Simple Mode (`config.simpleMode.enabled`) force-disables L1/L2/L3 memory, hides Notebook/Profile tabs, surfaces presets.

## Docker

### Production Image

Multi-stage build using custom base image (`inno-agent-base:v0.1`):
- Build stage: installs `node-pty` deps, runs `npm ci` + `npm run build`
- Runtime stage: copies `dist/` + production `node_modules`, exposes port 3000

```bash
docker-compose up -d
```

Volume mounts: `runtime/config/`, `runtime/data/`, `runtime/skills/`, `workspace/`

### Base Image (`Dockerfile.base`)

Based on `node:22-bookworm`, pre-installs system dependencies + Miniforge (Python >= 3.11). See [docs/SYSTEM_DEPENDENCIES.md](./docs/SYSTEM_DEPENDENCIES.md).

## Electron Desktop Builds

```bash
npm run electron              # Run locally
npm run electron:build        # Package macOS DMG (arm64)
npm run electron:build:win    # Package Windows NSIS + MSI (x64)
```

`electron/main.js` spawns server as child process (`ELECTRON_RUN_AS_NODE=1`), shows loading window while polling `/health`.

Build scripts:
- `scripts/after-pack.cjs` — fixes `node-pty` permissions after packaging
- `scripts/build-mac.sh` — local macOS packaging with `--bump` option

## CI/CD

GitHub Actions (`.github/workflows/`):
- `release-mac.yml` — macOS DMG on ARM64 (`macos-14` runner)
- `release-win.yml` — Windows NSIS + MSI on x64

Triggered by `v*.*.*` tags or workflow_dispatch.

## Utility Scripts

- **`apps/inno-agent/scripts/pptx_to_svg.py`** — Converts PowerPoint files to per-slide SVG without LibreOffice. Uses only Python stdlib. Set `INNO_PYTHON` env var to override Python executable.
- **`apps/inno-agent/scripts/console_encoding.py`** — UTF-8 stdio helper for the PPTX converter

## Reference Docs

- [README.md](./README.md) — full project overview, design rationale, features
- [QUICKSTART.md](./QUICKSTART.md) — 5-minute setup guide (Chinese)
- [ELECTRON_BUILD.md](./ELECTRON_BUILD.md) — Electron packaging notes (Chinese)
- [apps/inno-agent/README.md](./apps/inno-agent/README.md) — backend API route table
- [docs/SYSTEM_DEPENDENCIES.md](./docs/SYSTEM_DEPENDENCIES.md) — system-level dependency reference

## Important Notes

- The PI SDK kernel is never modified — all learning behavior added through tools and extension hooks
- Web workspace build: `npm run web:build` (runs `tsc && vite build` in the web workspace)
- Config writes must go through `config.ts` helpers, not direct JSON writes
- L3 recall requires Node >= 22.5 (uses `node:sqlite`), degrades gracefully on older versions
- Sandbox mode requires `ripgrep` (`brew install ripgrep`)
- Sandbox configuration: global `<configDir>/sandbox.json`, project-level `<workspaceDir>/.pi/sandbox.json` (higher priority)
- Backend package declares `"inno": "dist/cli.js"` bin entry for global install
- System prompt (`system-prompt.ts`) is Chinese-only — defines L1/L2/L3 memory rules and teaching strategies
- `INNO_VERSION` in `inno-extension.ts` is hardcoded to `"0.0.1"` (not synced with package.json version)
- Auto-topic generation: channel sessions get Chinese topic titles via `completePromptOnce` (fire-and-forget)
- Content Hub: remote source for skills/presets, configurable via `contentHub` in config.json (github or bundle mode)
