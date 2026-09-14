# Context usage in the chat composer

The conversation composer shows a context ring beside the model picker. Hover or
focus it for the used/maximum token count; click it for a categorized popover.
The welcome composer does not display session usage.

## Data contract

`GET /api/sessions/:id/context-usage` returns aggregate counts only, with
`Cache-Control: no-store`. It never activates a session or exposes prompt text,
message content, tool schemas, credentials, or filesystem paths.

- `ready`: current context tokens, model context window, percentage and breakdown.
- `pending`: Pi has compacted the context and has not yet reported a new total.
- `inactive`: the requested session is not the singleton runtime's current session.
- `unavailable`: no usable context window or usage data.

Unknown values are `null`, not zero. Missing sessions return HTTP 404. The UI
also distinguishes loading and request failure, and retries automatically.

## Counting semantics

The total uses the installed Pi SDK's `getContextUsage()` (provider usage plus
estimated subsequent messages). Before a usable provider response exists, the
initial estimate also includes the effective system prompt and active tool schemas.

Category weights are estimates, rounded and scaled to sum to the current total:

- System: effective system prompt excluding the available-skills catalog.
- Tools & subagents: active non-MCP tool definitions, not subagent context windows.
- Messages: the current message branch, including tool results and loaded skill text.
- Connectors & MCP: active schemas identified by MCP names or adapter provenance.
- Skill catalog: the `<available_skills>` section of the system prompt.

Percentages use the whole context window as their denominator, not the used
portion. Above-capacity totals remain visible; visual ring/bar fills cap at 100%.
These are context occupancy estimates, **not billing or cumulative usage totals**.

## Updates and interactions

Polls every 3 seconds while streaming and every 15 seconds while idle. Also
refreshes when history/message count or streaming state changes, and when a
hidden page becomes visible. Hidden pages do not poll. Requests time out after
10 seconds and are aborted on cleanup. Session/model changes remount the meter
so stale responses cannot leak counts across sessions.

The popover is portaled outside clipping containers, fits the visible viewport,
works with light/dark themes and English/Chinese, closes on outside click or
Escape, and restores keyboard focus when explicitly dismissed.
