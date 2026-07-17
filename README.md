# Inno Agent

> An open-source **personal learning agent** with a layered memory system, a proactive scheduler, multi-channel messaging, and a workspace-scoped Practice Lab — built on the [Pi coding-agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) **without modifying its kernel**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178c6.svg)](https://www.typescriptlang.org/)
[![Website](https://img.shields.io/badge/Website-Inno%20Agent-ff6b35.svg)](https://hhyqhh.github.io/inno-agent-website/)

> 🌐 **Homepage:** [https://hhyqhh.github.io/inno-agent-website/](https://hhyqhh.github.io/inno-agent-website/) - project overview, feature walkthrough, and live demos.

> 📄 **Technical Report:** [*Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment*](./docs/inno-agent.pdf) (arXiv, June 2026) — covers the system design, three-layer memory architecture, instructional-design grounding, and preliminary educational post-training results on Qwen3.6 35B.
>
> 📦 **Resource Hub:** [Chloris-Blaxk/inno-agent-hub](https://github.com/Chloris-Blaxk/inno-agent-hub) — the companion repository containing the skill library, workspace preset templates, and community-contributed resources for Inno Agent.

<p align="center">
  <img src="./docs/assets/l2-wiki.png" alt="Inno Agent — L2 wiki knowledge base and graph" width="100%" />
</p>

Inno Agent is a single-learner companion that organizes long-term learning support into three explicit memory layers — an **L1 learner profile**, an **L2 native wiki knowledge base**, and **L3 session records with cross-conversation retrieval** — and wraps them with a learning loop: a cron scheduler, personal IM channels (Feishu / WeChat), and a Practice Lab with an in-browser terminal.

It ships in two forms that share the same `runtime/` and `workspace/` state:

- **Terminal CLI** (`inno`) — a pure TUI agent, no HTTP.
- **Web UI** (React 19 + Lit + Tailwind 4) — backed by a Node HTTP server with SSE streaming, terminal sessions, a workspace browser, the wiki graph, jobs, skills, and settings.

---

## Why Inno Agent

General-purpose coding agents are optimized for open-ended, context-heavy software engineering, which pushes them toward the largest models and longest context windows. Education is a different optimization target: the tasks are more structured, and the value lies in **personalized explanation, misconception diagnosis, exercise generation, feedback, review scheduling, privacy, and low-latency continuous interaction**.

Inno Agent takes a different stance:

- **Layered memory, not a flat chat summary.** Learner state, archived knowledge, and recent dialogue have different lifecycles, so each lives in its own layer with explicit boundaries enforced in the system prompt and storage layout.
- **Durable facts go to tools, not replies.** Anything that affects future teaching is written to L1/L2 via tools, so personalization decisions are evidence-driven and traceable.
- **An open, correctable learner model.** The L1 profile is inspectable and editable by the learner; the system prompt forbids unevidenced labels.
- **The SDK kernel is never modified.** All learning behavior is added through registered tools and a single extension hook (`createInnoExtension`), so the agent runtime stays upstream-compatible.

---

## Features

- 🧠 **Three-layer memory**
  - **L1 — Learner profile**: goals, knowledge states, misconceptions, and preferences, updated from structured learning events and summarized into a short context pack injected before each turn.
  - **L2 — Native wiki**: human-readable, agent-queryable pages (sources, concepts, entities, analysis) with LLM-assisted summarization, entity/concept linking, and PDF/Office/image ingestion.
  - **L3 — Session records + cross-conversation retrieval**: Pi-SDK session history, indexed into SQLite with threshold-gated lexical recall so relevant past conversations can be surfaced across sessions.
- ⏰ **Proactive scheduler** — cron-driven background jobs created in natural language, runnable from the agent, the UI, or the cron daemon.
- 💬 **Personal IM channels** — Feishu (native) plus WeChat (bridge mode), with a unified dispatcher that pushes reminders back out.
- 🧪 **Practice Lab** — a workspace-scoped web terminal (xterm.js over WebSocket) with run records the agent can read.
- 🔌 **Pluggable providers** — any `openai-completions` or `anthropic-messages` endpoint (Anthropic, OpenAI, DeepSeek, Ollama, or a local model); switch models live in the UI.
- 🖥️ **CLI and Web UI** — same runtime, same memory, same skills.
- 🛡️ **Optional OS-level sandbox** — gate the agent's bash and file operations via [pi-sandbox](https://github.com/carderne/pi-sandbox).

---

## Requirements

- **Node.js >= 20.6.0** (cross-conversation L3 retrieval uses the built-in `node:sqlite`, available on Node 22.5+; on older runtimes L3 recall degrades gracefully and the rest of the agent runs normally).
- **npm** (workspaces are used; no extra package manager required).

---

## Quick Start

New here? Start with **[QUICKSTART.md](./QUICKSTART.md)** (5 minutes). The short version:

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

Open **http://localhost:3000**.

---

## Use Cases

Real-world usage guides live in [`docs/use-cases/`](https://github.com/hhyqhh/inno-agent/tree/main/docs/use-cases).

| Guide | Description |
|---|---|
| [Skill Tutorial — Building a Workspace Agent](./docs/use-cases/skill-tutorial.md) | Use `agent.md` and `.skills/` to build a custom learning agent scoped to a workspace, with a concrete English study example |

---

## Run Modes

**Web UI** (serves the API and the built frontend):

```bash
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

**CLI** (terminal agent, no HTTP):

```bash
npm run start -- --home ./runtime --workspace ./workspace
```

**Dev** (backend + Vite HMR on :5173, with `/api` proxied to :3000):

```bash
npm run dev:server     # backend
npm run web:dev        # frontend
```

**Sandbox** (OS-level isolation of bash/file operations; requires `ripgrep`):

```bash
npm run server:sandbox -- --home ./runtime --workspace ./workspace --port 3000
```

The included `restart-dev.sh` orchestrates both processes (build, start, stop, status, logs, smoke-test). Run `bash restart-dev.sh --help`.

---

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
    "wechat": { "enabled": false, "mode": "bridge", "sidecarBaseUrl": "http://127.0.0.1:4319" }
  }
}
```

Each provider has a `baseUrl`, an `api` (`openai-completions` or `anthropic-messages`), an `apiKey`, and a `models[]` list. The server hot-rewrites this file when you switch model in the UI.

### Runtime path resolution

Both CLI and server resolve paths through `apps/inno-agent/src/runtime.ts`. Precedence: **CLI flag > env var > `~/.inno-agent/...`**.

| CLI flag                          | Env var                | Default                   |
| --------------------------------- | ---------------------- | ------------------------- |
| `--home`                          | `INNO_HOME`            | `~/.inno-agent`           |
| `--config`                        | `INNO_CONFIG_FILE`     | `<configDir>/config.json` |
| `--config-dir`                    | `INNO_CONFIG_DIR`      | `<home>/config`           |
| `--data` / `--data-dir`           | `INNO_DATA_DIR`        | `<home>/data`             |
| `--skills` / `--skills-dir`       | `INNO_SKILLS_DIR`      | `<home>/skills`           |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR`   | invocation CWD            |
| `--port`                          | `INNO_PORT` (`config`) | `3000`                    |

### Content Hub (skill library + workspace presets)

The global **skill library** and the Simple Mode **workspace presets** (an `agent.md` + `.skills/` bundle, surfaced as one-click cards on the welcome screen) are both fetched from a remote **content hub**. By default this is the public GitHub repo [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub); you can point it at a private GitHub repo or a self-hosted bundle service instead — a config change, no code change.

Configure it in `runtime/config/config.json` (or via the UI: **Settings → Content Hub**):

```jsonc
// Default: pull from a GitHub repo
{
  "contentHub": {
    "type": "github",
    "owner": "Chloris-Blaxk",
    "repo": "inno-agent-hub",
    "ref": "main",
    "skillsPath": "skill-library",        // dir holding <skill>/SKILL.md
    "presetsPath": "workspace-templates",  // dir holding <preset>/preset.json
    "token": ""                            // optional PAT: private repos / higher rate limit
  }
}
```

```jsonc
// Or: pull from a self-hosted bundle service (private deployments)
{
  "contentHub": {
    "type": "bundle",
    "baseUrl": "http://localhost:8787",
    "token": ""                            // optional Bearer credential
  }
}
```

Presets are downloaded on first use and cached under `<dataDir>/preset-cache/`; the templates bundled with the app serve as an offline fallback. A legacy `github.token` is migrated into `contentHub.token` automatically.

**Self-hosting:** a zero-dependency local bundle service lives in [`scripts/content-hub-server/`](./scripts/content-hub-server/) — back it with your private git repo of skills + templates. See its [README](./scripts/content-hub-server/README.md) for the layout and run commands:

```bash
CONTENT_DIR=/path/to/content node scripts/content-hub-server/server.mjs
```

---

## Repository Layout

```text
apps/inno-agent/          Backend (CLI + HTTP server), TypeScript -> dist/
apps/inno-agent/web/      Frontend (React 19 + Lit + Tailwind 4 + Vite)
scripts/content-hub-server/  Self-hosted Content Hub bundle service (skills + presets)
runtime/                  Local runtime state (config, data, skills) - gitignored
workspace/                Default agent working directory - gitignored
```

The Pi SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) are pulled from npm.

---

## Architecture

Inno Agent is a single-user system with four layers: **user interfaces → application layer → Pi agent runtime → layered memory.**

```text
User Interfaces      CLI · Web UI (React) · Feishu · WeChat
        ↓
Application Layer    Channel adapters · HTTP API (SSE) · Memory orchestration
                     Cron scheduler · Practice Lab · WebSocket terminal
        ↓
Agent Runtime        Pi AgentSession · registered tools · inno extension
(Pi SDK, unmodified) General LLM provider  ──or──  distilled educational model
        ↓
Layered Memory       L1 learner profile · L2 native wiki · L3 session records
```

- **Agent core** — `@earendil-works/pi-coding-agent` provides the loop. Inno wraps it with `apps/inno-agent/src/agent/inno-extension.ts`, which registers providers and tools (L1 learner, L2 wiki, L3 recall, scheduler, practice lab) and a `before_agent_start` hook that injects the L1 context pack — and, when relevant, threshold-gated L3 recall — into the system prompt.
- **L1 — learner memory** (`src/memory/learner/`): evidence-driven profile + event log, summarized into a `ContextPack` per turn.
- **L2 — wiki memory** (`src/memory/l2/`): structured wiki pages with frontmatter, links, graph, summarizer, and document ingestion; exposed as agent tools and via `/api/wiki/*`.
- **L3 — session memory** (`src/memory/l3/` + Pi `SessionManager`): the SDK owns session JSONL files; Inno layers a SQLite index (`node:sqlite` + FTS5) on top for cross-conversation recall, surfaced both automatically (above a relevance threshold) and via the `l3_recall` tool.
- **Scheduler** (`src/scheduler/`): cron jobs persisted to `jobs.json` + `runs.jsonl`; runnable from the agent (`run_scheduled_job`), the UI, or the daemon.
- **Channels** (`src/channels/`): `ChannelRegistry` with Feishu (and bridge-mode WeChat) so reminders can be pushed back out.
- **HTTP server** (`src/server.ts`): plain Node `http.createServer` with SSE for chat streaming and WebSocket for the in-browser terminal.
- **Web UI** (`web/src/`): React 19 + Lit + Tailwind 4. State lives in framework-agnostic `EventEmitter` stores under `web/src/stores/`; REST/SSE calls in `web/src/api/`.

The backend API route table and runtime details are in [`apps/inno-agent/README.md`](./apps/inno-agent/README.md).

---

## Deployment

A typical production layout separates code, config, data, and workspace:

```text
/opt/inno-agent              # this repository
/etc/inno-agent/config.json  # config
/var/lib/inno-agent/data     # sessions, jobs, memory, downloads
/var/lib/inno-agent/skills   # uploaded skills
/srv/inno-workspace          # files the agent should work on
```

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_DATA_DIR=/var/lib/inno-agent/data \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

A [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml) are provided as starting points.

---

## Contributing

Issues and PRs are welcome. Before opening a PR, please run `npm run build` locally — there is no top-level lint or test runner wired up yet, but the TypeScript build doubles as a sanity check. Keep changes focused, match the existing code style, and update the relevant docs when behavior changes.

---

## Community

Join the WeChat user group to ask questions, share use cases, and follow updates. Scan the QR code below:

<p align="center">
  <img src="./docs/assets/wechat-community-qr.png" alt="Inno Agent WeChat community group QR code" width="240" />
</p>

---

## License

[MIT](./LICENSE).

This project depends on the Pi SDK (`@earendil-works/pi-*` packages by Mario Zechner), which is also MIT-licensed and consumed via npm.

---

## Citation

If you use Inno Agent in your research, please cite it as follows:

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent}},
  note         = {Accessed: 2026-07-17}
}
```
