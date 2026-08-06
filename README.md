# Inno Agent

> An open-source **personal learning agent** with layered memory, a proactive scheduler, multi-channel messaging, and a workspace-scoped Practice Lab — built on the [Pi coding-agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) **without modifying its kernel**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent.svg)](https://github.com/hhyqhh/inno-agent/releases)
[![Website](https://img.shields.io/badge/Website-Inno%20Agent-ff6b35.svg)](https://hhyqhh.github.io/inno-agent-website/)

**English** | [简体中文](./README.zh-CN.md)

🌐 **[Homepage](https://hhyqhh.github.io/inno-agent-website/)** · 📄 **[Technical Report](./docs/inno-agent.pdf)** (arXiv, June 2026) · 📦 **[Resource Hub](https://github.com/Chloris-Blaxk/inno-agent-hub)** (skill library + workspace presets)

<p align="center">
  <img src="./docs/assets/l2-wiki.png" alt="Inno Agent — L2 wiki knowledge base and graph" width="100%" />
</p>

Inno Agent is a single-learner companion that organizes long-term learning support into three explicit memory layers — an **L1 learner profile**, an **L2 native wiki knowledge base**, and **L3 session records with cross-conversation retrieval** — and wraps them in a learning loop: a cron scheduler, personal IM channels (Feishu / WeChat), and a Practice Lab with an in-browser terminal.

It ships in three forms that share the same runtime state:

- **Desktop app** (Electron) — one-click install for macOS and Windows.
- **Web UI** (React 19 + Tailwind 4) — Node HTTP server with SSE streaming, terminal, wiki graph, jobs, skills, and settings.
- **Terminal CLI** (`inno`) — a pure TUI agent, no HTTP.

## Why Inno Agent

General-purpose coding agents optimize for open-ended software engineering. Education is a different target: the value lies in **personalized explanation, misconception diagnosis, exercise generation, feedback, review scheduling, privacy, and low-latency continuous interaction**. Inno Agent's stances:

- **Layered memory, not a flat chat summary** — learner state, archived knowledge, and recent dialogue have different lifecycles and live in separate layers.
- **Durable facts go to tools, not replies** — anything that affects future teaching is written to L1/L2 via tools, so personalization is evidence-driven and traceable.
- **An open, correctable learner model** — the L1 profile is inspectable and editable by the learner; unevidenced labels are forbidden.
- **The SDK kernel is never modified** — all learning behavior is added through registered tools and one extension hook, keeping the runtime upstream-compatible.

## Features

- 🧠 **Three-layer memory**
  - **L1 learner profile** — goals, knowledge states, misconceptions, preferences; summarized into a context pack injected each turn.
  - **L2 native wiki** — human-readable, agent-queryable pages with hybrid retrieval (lexical BM25 + knowledge graph), LLM-assisted summarization, and PDF/Office/image ingestion.
  - **L3 session recall** — session history indexed into SQLite (FTS5) with threshold-gated cross-conversation retrieval.
- ⏰ **Proactive scheduler** — cron jobs created in natural language, runnable from the agent, the UI, or the daemon.
- 💬 **Personal IM channels** — Feishu (native) plus WeChat (iLink QR login or bridge mode), with a unified dispatcher for reminders.
- 🧪 **Practice Lab** — workspace-scoped web terminal (xterm.js over WebSocket) with run records the agent can read.
- 🎯 **Simple Mode + presets** — one-click preset workspaces (lesson plan, PPT creation, scenario explain) for non-technical users.
- 🧩 **Skill system + content hub** — browse and import skills/presets from a remote hub (GitHub repo or self-hosted bundle service).
- 🔌 **Pluggable providers** — any `openai-completions` or `anthropic-messages` endpoint (Anthropic, OpenAI, DeepSeek, Ollama, local models); switch models live in the UI.
- 🌍 **i18n & themes** — Chinese/English UI, four themes.
- 🛡️ **Optional OS-level sandbox** — gate bash/file operations via [pi-sandbox](https://github.com/carderne/pi-sandbox); optional subagents via `pi-subagents`.

## Quick Start

### Option A — Desktop app (easiest)

Download the latest installer from [**GitHub Releases**](https://github.com/hhyqhh/inno-agent/releases):

- **macOS** (Apple Silicon): `Inno.Agent-x.y.z-arm64.dmg` — unsigned; right-click → Open on first launch.
- **Windows** (x64): `Inno.Agent.Setup.x.y.z.exe` or `.msi`.

On first launch a default config is created at `~/.inno-agent/config/config.json` — add your provider API key there (or via the in-app settings).

### Option B — From source

```bash
git clone https://github.com/hhyqhh/inno-agent.git
cd inno-agent

npm install      # pulls the Pi SDK from npm
npm run build    # compiles backend + web

mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json and set providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Open **http://localhost:3000**. See **[QUICKSTART.md](./QUICKSTART.md)** (中文) for a 5-minute walkthrough with provider examples.

### Option C — Docker

```bash
docker compose up -d   # serves on :3000, mounts runtime/ and workspace/
```

## Run Modes

```bash
npm run server          # Web UI (API + built frontend on :3000)
npm run start           # CLI (terminal agent, no HTTP)
npm run electron        # Desktop app locally
npm run server:sandbox  # Web UI with OS-level sandbox (requires ripgrep)

# Dev: backend on :3000 + Vite HMR on :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` orchestrates the dev lifecycle (build, start, stop, status, logs, smoke-test) — run `bash restart-dev.sh --help`.

## Configuration

`runtime/config/config.json` (template: [`config.example.json`](./config.example.json)):

```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "innospark": {
      "baseUrl": "https://api.example.com",
      "api": "anthropic-messages",
      "apiKey": "replace-me",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false },
    "wechat": { "enabled": false, "mode": "ilink" }
  },
  "memory": { "l1Enabled": true, "l2Enabled": true, "l3Enabled": true },
  "ui": { "theme": "light", "closeBehavior": "ask" }
}
```

Each provider declares a `baseUrl`, an `api` (`openai-completions` or `anthropic-messages`), an `apiKey`, and a `models[]` list. The server hot-rewrites this file when you switch models in the UI.

### Runtime paths

Both CLI and server resolve paths through `apps/inno-agent/src/runtime.ts`. Precedence: **CLI flag > env var > `~/.inno-agent/...`**.

| CLI flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` | `3000` |

### Content Hub

The skill library and Simple Mode presets are fetched from a remote **content hub** — by default the public GitHub repo [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub). Point `contentHub` in `config.json` (or **Settings → Content Hub**) at a private GitHub repo (`"type": "github"`) or a self-hosted bundle service (`"type": "bundle"`) — a zero-dependency bundle server lives in [`scripts/content-hub-server/`](./scripts/content-hub-server/). Presets are cached locally; bundled templates serve as an offline fallback.

## Architecture

Four layers: **user interfaces → application layer → Pi agent runtime → layered memory.**

```text
User Interfaces      CLI · Web UI (React) · Desktop · Feishu · WeChat
        ↓
Application Layer    Channel adapters · HTTP API (SSE) · Memory orchestration
                     Cron scheduler · Practice Lab · WebSocket terminal
        ↓
Agent Runtime        Pi AgentSession · registered tools · inno extension
(Pi SDK, unmodified) General LLM provider  ──or──  distilled educational model
        ↓
Layered Memory       L1 learner profile · L2 native wiki · L3 session records
```

- **Agent core** — `@earendil-works/pi-coding-agent` provides the loop. [`inno-extension.ts`](./apps/inno-agent/src/agent/inno-extension.ts) registers providers and tools (L1/L2/L3, scheduler, practice lab, documents, OCR) and a `before_agent_start` hook that injects the L1 context pack and threshold-gated L3 recall into the system prompt.
- **Memory** — L1 (`src/memory/learner/`): evidence-driven profile + event log. L2 (`src/memory/l2/`): structured wiki with graph, summarizer, ingestion, and hybrid retrieval; exposed via agent tools and `/api/wiki/*`. L3 (`src/memory/l3/`): a SQLite FTS5 index layered over Pi session JSONL files.
- **Scheduler** (`src/scheduler/`) — cron jobs persisted to `jobs.json` + `runs.jsonl`.
- **Channels** (`src/channels/`) — `ChannelRegistry` with Feishu, WeChat (iLink / bridge), and QQ (bridge).
- **HTTP server** (`src/server.ts`) — plain Node `http.createServer` with SSE chat streaming and a WebSocket terminal; route table in [`apps/inno-agent/README.md`](./apps/inno-agent/README.md).
- **Web UI** (`web/src/`) — React 19 + Tailwind 4. Framework-agnostic `EventEmitter` stores in `web/src/stores/`; REST/SSE calls in `web/src/api/`.

## Repository Layout

```text
apps/inno-agent/           Backend (CLI + HTTP server), TypeScript → dist/
apps/inno-agent/web/       Frontend (React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   Bundled preset workspaces (offline fallback)
electron/                  Electron main process (desktop app)
scripts/content-hub-server/  Self-hosted Content Hub bundle service
runtime/                   Local runtime state (config, data, skills) — gitignored
workspace/                 Default agent working directory — gitignored
```

## Deployment

Typical production layout, separating code, config, data, and workspace:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_DATA_DIR=/var/lib/inno-agent/data \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

A [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml) are provided as starting points; see [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md) for the full dependency reference. Desktop packaging notes are in [`ELECTRON_BUILD.md`](./ELECTRON_BUILD.md).

## Use Cases & Docs

- [Skill Tutorial — Building a Workspace Agent](./docs/use-cases/skill-tutorial.md) — use `agent.md` and `.skills/` to build a custom learning agent scoped to a workspace.
- [QUICKSTART.md](./QUICKSTART.md) — 5-minute setup guide (中文).
- [apps/inno-agent/README.md](./apps/inno-agent/README.md) — backend API route table (中文).

## Contributing

Issues and PRs are welcome. Before opening a PR, run `npm run build` locally — the TypeScript build doubles as the sanity check (no lint/test runner is wired up yet). Keep changes focused, match the existing code style, and update docs when behavior changes.

## Community

Join the WeChat user group to ask questions, share use cases, and follow updates:

<p align="center">
  <img src="./docs/assets/wechat-community-qr-2026-08-03.png" alt="Inno Agent WeChat community group QR code" width="240" />
</p>

## License

[MIT](./LICENSE). This project depends on the Pi SDK (`@earendil-works/pi-*` packages by Mario Zechner), also MIT-licensed and consumed via npm.

## Citation

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent}}
}
```
