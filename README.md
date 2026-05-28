# Inno Agent

A personal learning agent built on the [PI SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with a three-layer memory system, cron-driven background jobs, and pluggable IM channels (Feishu / QQ / WeChat).

Inno Agent ships as both:

- a **terminal CLI** (`inno`) — pure TUI agent, no HTTP.
- a **web UI** (React 19 + Lit + Tailwind 4) backed by a Node HTTP server with SSE streaming, terminal sessions, workspace browser, wiki graph, jobs, skills, and settings.

Both share the same `runtime/` and `workspace/` directories, so config, sessions, memory, skills, and files stay aligned.

## Repository Layout

```text
apps/inno-agent/          Backend (CLI + HTTP server), TypeScript -> dist/
apps/inno-agent/web/      Frontend (React 19 + Lit + Tailwind 4 + Vite)
runtime/                  Local runtime state (config, data, skills) - gitignored
workspace/                Default agent working directory - gitignored
```

The PI SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) are pulled from npm.

## Requirements

- Node.js >= 20.6.0
- npm (workspaces are used, no extra package manager required)

## Quick Start

```bash
git clone <your-fork-url> inno-agent
cd inno-agent

npm install
npm run build

mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json and set providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Open `http://localhost:3000`.

## Run Modes

Web UI:

```bash
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

CLI:

```bash
npm run start -- --home ./runtime --workspace ./workspace
```

Dev (server + Vite HMR on :5173, with `/api` proxied to :3000):

```bash
npm run dev:server     # backend
npm run web:dev        # frontend
```

The included `restart-dev.sh` orchestrates both processes (build, start, stop, status, logs, smoke-test). See `bash restart-dev.sh --help`.

## Runtime Path Resolution

Both CLI and server resolve paths through `apps/inno-agent/src/runtime.ts`. Precedence: **CLI flag > env var > `~/.inno-agent/...`**.

| CLI flag                          | Env var                | Default                       |
| --------------------------------- | ---------------------- | ----------------------------- |
| `--home`                          | `INNO_HOME`            | `~/.inno-agent`               |
| `--config`                        | `INNO_CONFIG_FILE`     | `<configDir>/config.json`     |
| `--config-dir`                    | `INNO_CONFIG_DIR`      | `<home>/config`               |
| `--data` / `--data-dir`           | `INNO_DATA_DIR`        | `<home>/data`                 |
| `--skills` / `--skills-dir`       | `INNO_SKILLS_DIR`      | `<home>/skills`               |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR`   | invocation CWD                |
| `--port`                          | `INNO_PORT` (`config`) | `3000`                        |

## Configuration

`runtime/config/config.json` (template: `config.example.json`):

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
    "qq":     { "enabled": false, "mode": "bridge", "sidecarBaseUrl": "http://127.0.0.1:4318" },
    "wechat": { "enabled": false, "mode": "bridge", "sidecarBaseUrl": "http://127.0.0.1:4319" }
  }
}
```

Each provider has a `baseUrl`, an `api` (`openai-completions` or `anthropic-messages`), an `apiKey`, and a `models[]` list. The server hot-rewrites this file when the user switches model in the UI.

## Architecture

- **Agent core** — `@earendil-works/pi-coding-agent` provides the agent loop. Inno wraps it with an extension factory (`apps/inno-agent/src/agent/inno-extension.ts`) that registers providers, tools (L1 learner, scheduler, L2 wiki), and pre-turn hooks that inject the L1 context pack into the system prompt.
- **Memory (L1)** — `apps/inno-agent/src/memory/learner/`: learner profile + event log, summarized into a `ContextPack` per turn.
- **Memory (L2)** — `apps/inno-agent/src/memory/l2/`: structured wiki memory with frontmatter pages, links, graph, summarizer, and source converter; exposed both as agent tools and via `/api/wiki/*`.
- **Scheduler** — `apps/inno-agent/src/scheduler/`: cron-driven background jobs persisted to `jobs.json` + `runs.jsonl`; runnable from the agent (`run_scheduled_job` tool), the UI, or the cron daemon.
- **Channels** — `apps/inno-agent/src/channels/`: `ChannelRegistry` with Feishu (and bridge-mode QQ / WeChat) so reminders can be pushed back out.
- **HTTP server** — plain Node `http.createServer` with SSE for chat streaming and WebSocket for the in-browser terminal.
- **Web UI** — React 19 + Lit + Tailwind 4. State is in framework-agnostic `EventEmitter`-based stores under `web/src/stores/`. REST/SSE calls live in `web/src/api/`.

See `apps/inno-agent/docs/` for detailed design notes:

- `inno-agent-development-design.md` — overall architecture.
- `learner-profile-memory-design.md` — L1 design.
- `l2-native-wiki-memory-design.md` — L2 design.
- `personal-im-channel-design.md` — Feishu / QQ / WeChat integration.
- `practice-lab-terminal-design.md` — xterm.js practice lab.

## Production Shape

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

A `Dockerfile` and `docker-compose.yml` are provided as starting points.

## Contributing

Issues and PRs welcome. Please run `npm run build` locally before opening a PR — there is no top-level lint or test runner wired up yet, but the TypeScript build doubles as a sanity check.

## License

[MIT](./LICENSE)

This project depends on the PI SDK (`@earendil-works/pi-*` packages by Mario Zechner), which is also MIT-licensed and consumed via npm.
