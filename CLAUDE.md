# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is an npm workspaces monorepo (Node.js >=20.6.0, ES modules) for **Inno Agent**, a personal learning agent built on the PI SDK.

- `apps/inno-agent/` — backend (CLI + HTTP server), TypeScript, compiles to `dist/`.
- `apps/inno-agent/web/` — frontend (React 19 + Lit + Tailwind 4 + Vite), workspace `inno-agent-web`.
- `runtime/` — local runtime state (config, data, skills); gitignored. Mapped to `INNO_*` env vars.
- `workspace/` — default agent working directory; gitignored.

PI SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) are pulled from npm.

## Common Commands

All commands are run from the repo root and use `npm --workspace` under the hood.

```bash
# Build app + web
npm run build

# Start HTTP server (serves API + web/dist on port 3000)
npm run server -- --home ./runtime --workspace ./workspace --port 3000

# Start CLI (terminal agent, no HTTP)
npm run start -- --home ./runtime --workspace ./workspace

# Dev: run server and Vite dev separately
npm run dev:server      # backend on :3000
npm run web:dev         # Vite on :5173, proxies /api -> :3000
```

There is no top-level lint or test runner wired up. `vitest` is a dev dependency but no test scripts are defined.

### Dev restart rules (from `apps/inno-agent/README.md`)

- Changes to `src/server.ts` or backend API → `npm run build` + restart server.
- Changes to `web/vite.config.ts` → restart Vite.
- Changes under `web/src/` → Vite HMR usually handles it.
- If upload/Wiki/proxy behavior misbehaves, fully restart both. Health checks: `curl localhost:3000/health`, `curl localhost:5173/api/wiki/pages`.

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

Derived paths inside `dataDir`: `learner/`, `sessions/`, `jobs/`, `l2/`, `channels/`. `applyRuntimeEnvironment` re-exports the resolved paths back into `process.env` plus `PI_CODING_AGENT_SESSION_DIR` so PI SDK code picks them up.

When editing path-related code, change `runtime.ts` rather than hard-coding paths in `cli.ts`/`server.ts`.

## Architecture

### Agent core (PI SDK + Inno extension)

The agent loop is provided by `@earendil-works/pi-coding-agent` (npm). Inno wraps it with an extension factory in `apps/inno-agent/src/agent/inno-extension.ts`, which:

1. Registers model providers from `config.json` via `pi.registerProvider` (e.g. an InnoSpark Anthropic-compatible endpoint).
2. Registers three tool groups: **learner tools** (L1), **scheduler tools**, **L2 wiki tools**.
3. Hooks `before_agent_start` to prepend `INNO_SYSTEM_PROMPT` + an L1 context pack (profile + recent events) to the system prompt for every turn.
4. Hooks `session_start` to install custom TUI header/title.
5. Persists `model_select` events back to `config.json`.

`cli.ts` calls PI's `main(...)` with this extension and forces `--no-skills --skill <skillsDir>` so only the project's skills directory is loaded.

`server.ts` (HTTP) goes through `agent/pi-runner.ts`, which is a server-side facade around PI session APIs (`initSession`, `createNewSession`, `runPromptStreaming`, `completePromptOnce`, `switchModel`, etc.) and is shared by REST + SSE endpoints.

### Memory system

Two layers, both file-backed under `dataDir`:

- **L1 learner profile** (`src/memory/learner/`): `profile-store.ts` + `events`, summarized into a `ContextPack` injected each turn. `auto-profile.ts`/`profile-updater.ts` mutate the profile from tool calls.
- **L2 wiki memory** (`src/memory/l2/`): a structured wiki with `manifest-store.ts`, `raw-store.ts`, `wiki-maintainer.ts` (parses frontmatter), `wiki-linker.ts`, `wiki-query.ts`, plus a `summarizer.ts` and `source-converter.ts`. Exposed both to the agent (as tools) and to the web UI via `/api/wiki/*` (pages list, page CRUD, graph, stats).

### Scheduler

`src/scheduler/` implements cron-driven background jobs. `JobStore` persists `jobs.json` and appends `runs.jsonl` per execution. `CronScheduler` (uses `cron-parser`) triggers `job-runner.executeJob`. Jobs can also be invoked manually via `/api/jobs/:id/run` or from the agent itself via the `run_scheduled_job` tool. On boot, `normalizePersistedJobs` backfills `nextRunAt`/`lastStatus`/`runCount` fields, and `migrateReminderChannels` repoints legacy `push_reminder` jobs to the registered default Feishu target.

### Channels

`src/channels/` defines a `ChannelRegistry` and currently registers `FeishuChannel` when `config.feishu.appId` is set and `config.channels.feishu.enabled` is true. The registry persists default targets at `<dataDir>/channels/default-targets.json` and is passed into scheduler tools so reminders can be pushed back out.

### HTTP server (`src/server.ts`)

Plain Node `http.createServer` (no framework). Streaming chat is SSE on `POST /api/chat/stream`. Skills upload (`POST /api/skills/upload`) accepts `<skill-name>.zip` and unpacks into `skillsDir/<name>/` via `spawnSync('unzip', ...)`. Static frontend is served from `paths.webDistDir = apps/inno-agent/web/dist` when present. Full route table is in `apps/inno-agent/README.md`.

### Web UI

Hybrid React + Lit. Mounts in `web/src/main.tsx` → `react/App.tsx`. State lives in framework-agnostic `stores/` (small `EventEmitter`-based stores: `chat-store`, `sessions-store`, `wiki-store`, `jobs-store`, `skills-store`, `settings-store`, `workspace-store`, `graph-store`, `app-store`). REST/SSE calls go through `web/src/api/`. Some legacy Lit components remain under `components/`. Tailwind 4 via `@tailwindcss/vite`.

## Configuration

Runtime config lives at `<configDir>/config.json` (template: `config.example.json` at repo root). It declares `defaultProvider`, `defaultModel`, a `providers` map (each with `baseUrl`, `api` ∈ {`openai-completions`, `anthropic-messages`}, `apiKey`, `models[]`), optional `server.port`, and optional `channels.feishu` / `feishu` blocks. The server hot-rewrites this file when the user switches model via the UI.
