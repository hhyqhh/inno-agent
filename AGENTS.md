# Repository Guidelines

## Project Structure & Module Organization

This npm workspaces monorepo contains Inno Agent, a personal learning agent built on the PI SDK. Backend and CLI code live in `apps/inno-agent/src/`, with domains such as `agent/`, `server/`, `memory/`, `scheduler/`, `channels/`, `terminal/`, and `storage/`. The React/Tailwind web UI is in `apps/inno-agent/web/src/`, with API clients in `api/`, stores in `stores/`, and components in `react/`. The replay showcase app is in `apps/showcase/`. Desktop code is in `electron/`, assets in `build/`, scripts in `scripts/`, and notes in `docs/`. Keep local `runtime/` and `workspace/` state uncommitted.

## Build, Test, and Development Commands

Run commands from the repository root.

- `npm install` installs dependencies; Node.js `>=20.6.0` is required.
- `npm test` runs the Vitest suite.
- `npm run build` compiles the backend and web UI.
- `npm run server -- --home ./runtime --workspace ./workspace --port 3000` runs the HTTP API and built frontend.
- `npm run dev:server` starts the backend; pair with `npm run web:dev` for Vite HMR.
- `npm run electron` launches the desktop shell locally.
- `npm run showcase:dev` starts the recorded-session showcase.

## Coding Style & Naming Conventions

Use TypeScript ES modules. Existing source uses tabs, double quotes, semicolons, and explicit return types on exported functions where useful. Keep modules domain-oriented; prefer existing helpers in `apps/inno-agent/src/server/`, `runtime.ts`, or the relevant memory/channel directory over duplicating path or request logic. React component filenames use PascalCase. Tests use descriptive `*.test.ts` or `*.test.tsx` names. There is no ESLint or Prettier config, so match neighboring code.

## Testing Guidelines

Tests use Vitest and usually sit beside the code. Add focused tests for behavior changes, especially around memory, routes, stores, scheduler logic, terminal resolution, and channel dispatch. Run `npm test` before submitting; for UI or type-sensitive changes, also run `npm run build`.

## Commit & Pull Request Guidelines

Recent commits follow Conventional Commit-style prefixes such as `feat(web): ...`, `fix(test): ...`, `docs: ...`, and `chore: release ...`. Keep messages imperative and scoped when helpful. Pull requests should include a behavior summary, tests run, linked issues when applicable, and screenshots for visible UI changes. Update `README.md`, `CLAUDE.md`, or `docs/` when commands, architecture, or contributor facts change.

## Security & Configuration Tips

Start from `config.example.json` and keep provider keys in local runtime config, not source. Use `runtime/` for local data and `workspace/` for agent files. When touching path handling, sandboxing, uploads, or workspace access, preserve existing guards and size limits.
