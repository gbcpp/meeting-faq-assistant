# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A thin web wrapper around the `Codex` CLI, purpose-built as a browser front-end for the `jrtc-faq` skill (JRTC 会议问题排查). `server.js` spawns the `Codex` binary as a subprocess per request and streams its output to the browser over SSE. There is no build step and no framework beyond Express.

## Commands

```bash
npm install                       # install express
node server.js                    # start on http://127.0.0.1:3000
npm start                         # same thing
```

There are no tests, linter, or build. `npm test` is a placeholder that exits 1.

Runtime environment variables (all optional):
- `WORK_DIR` — cwd for the spawned `Codex` process (defaults to server cwd). This is the directory the agent operates in, so it must be a place where the `jrtc-faq` skill and its Grafana MCP are available.
- `HOST` — bind address (default `127.0.0.1`; set `0.0.0.0` to expose on the LAN).
- `PORT` — HTTP port (default 3000).
- `SESSION_FILE` — session map persistence path (default `./sessions.json`).
- `MODEL` — passed to `Codex --model` for cost control, e.g. `Codex-sonnet-4-6`.
- `ANTHROPIC_API_KEY` — needed unless the machine is already logged in via `Codex`.

## Architecture

Single request flow, all in `server.js`:

1. Browser opens `GET /api/run?prompt=...&session=<tab-id>` as an `EventSource` (SSE).
2. Server spawns `Codex -p <prompt> --output-format stream-json --include-partial-messages ...` and parses the NDJSON stdout line-by-line.
3. Each `Codex` event type is translated into a named SSE event the front-end listens for: `init`, `delta` (token-level text), `thinking` (a bare signal emitted on `thinking_delta`, used only to keep the spinner alive), `tool` (tool_use), `tool_result`, `stderr`, `done`, `exit`. The `system/api_retry` sub-event is forwarded as `stderr` so silent CLI retries (expired auth / network) surface in the page instead of leaving it spinning.
4. Browser (`index.html`, no framework) accumulates `delta` text into a markdown buffer rendered with marked + DOMPurify; tool calls/results render as separate collapsible blocks (click to expand/collapse).

### Two mechanisms that are central to the design

**Forced skill routing.** The server hard-codes that every query must go through the `jrtc-faq` skill, enforced in two layers: `--append-system-prompt` (`SYSTEM_APPEND`, system-level, higher weight) and a `wrapPrompt()` prefix on the user text. `--allowedTools` is restricted to `mcp__grafana-remote`, `Read`, `Grep`, `Glob`. Note: slash commands (`/xxx`) do **not** work under `-p` mode — do not add them.

**Session continuity.** The browser generates a stable per-tab id (`tab-<uuid>` in `sessionStorage`) and sends it as `session`. The server maps that id to `Codex`'s real `session_id` (captured from the `init` event) in the `sessions` Map, and passes `--resume <sid>` on the next request from the same tab. This map is persisted to `SESSION_FILE` (debounced 500ms write) and capped at `MAX_SESSIONS=500`, evicting least-recently-used entries. The "＋" button in the UI mints a fresh tab id to start a clean context.

### Lifecycle detail

`req.on('close')` sends `SIGTERM` to the child — closing the browser tab kills the underlying `Codex` process. tool_result text is truncated to 2000 chars server-side to avoid overwhelming the page.

### Front-end spinner state machine

The page shows a single spinner whose label tracks the current phase, driven by the SSE event stream: `思考中…` on start / `thinking` / after a `tool_result`, switching to `工具执行中…` on a `tool` event, and hidden as soon as `delta` text starts flowing. `done`/`exit`/`onerror` remove it. A `tool` event resets the markdown buffer (`mdBuffer=''`, `mdEl=null`) so text after a tool call starts a fresh reply block. Theme (light/dark) defaults to **dark** and is persisted in `localStorage`; the CSS is fully variablized under `[data-theme]`, so styling changes should go through the `:root`/`[data-theme="dark"]` custom-property blocks, not hard-coded colors.

Note: `AGENTS.md` and `sessions.json` are git-ignored.
