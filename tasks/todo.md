# clawdcursor-talk — plan (2026-11-14)

A floating bubble for testing clawdcursor by talking to it. LOCAL ONLY: no git remote, never pushed, never published
(`"private": true`). clawdcursor itself is not changed at all: this app only runs the user's own Claude Code with
clawdcursor as its only tools.

## Decided by the owner
- Floating, transparent, always-on-top bubble (Windows first, but built OS-agnostic).
- Buttons: Speak (the main blob), Type, Log. No Stop (clawdcursor's pill already has it).
- The Type box has a model chip: Sonnet / Haiku / Default (default chip = Sonnet).
- Speech: Whisper, downloaded with one click the first time Speak is pressed; OS-agnostic; nothing native installed.
- Gooey look: Libraries.dev `liquid-gooey` with the owner's values EXACTLY:
  `<Liquid blur={13.5} contrast={40} fill="#e9e9e9" waviness={8}>`, items at `x={open ? -54 : 0} y={open ? -34 : 0}`
  and `x={0} y={open ? -64 : 0}` (delay 40), both `transition={{ duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}`,
  third item = the main button. Speak is the main item; Type and Log are the two that fan out.

## Shape
- `src/main.ts` — Node host. A 127.0.0.1 HTTP server (random port + random token) serves the built UI and an event
  stream; opens the window with `@webviewjs/webview` (wry: WebView2 / WKWebView / WebKitGTK): frameless, transparent,
  always on top, small, bottom-right of the primary display, draggable. WebView data folder under ~/.clawdcursor-talk/.
- `src/brain.ts` — one run at a time. Spawns the user's own `claude -p` with `--input-format stream-json
  --output-format stream-json --verbose`, `--mcp-config` (a temp JSON with ONLY clawdcursor: `clawdcursor mcp --compact`,
  command overridable by CLAWD_TALK_CLAWDCURSOR so a dev build can be tested), `--strict-mcp-config`, built-in tools off,
  `--allowedTools mcp__clawdcursor__*`, `--model`, a short `--append-system-prompt`, `--resume <session>` for follow-ups.
  Env: drop ANTHROPIC_API_KEY / ANTHROPIC_* / CLAUDECODE / CLAUDE_CODE_* (so the user's plan login is used — the #420
  lesson). Pre-spawn when Speak is pressed so Claude's startup overlaps the talking. Kill the child on exit.
  Parses events into: a one-line caption (current step, then the answer) and log entries (each clawdcursor call + its
  confirmed / unverified / refused / failed line).
- `src/ui/` — React + liquid-gooey. Hover (or busy) = `open`. Caption under the bubble. Type: one-line input + model chip.
  Log: a small scrollable panel.
- Speech in the page: `@huggingface/transformers` Whisper (multilingual base, quantized, ~80 MB). First press: caption
  asks "Speech needs a one-time download (~80 MB)" with a Download button; then cached in the WebView's storage.
  Press-and-hold to talk (tap also works), mic via getUserMedia at 16 kHz.

## Steps
- [x] Scaffold (package.json private, tsconfig, esbuild for the UI, vitest), git init with no remote
- [x] brain.ts + tests (arg building, env stripping, stream-json parsing into caption/log) — offline
- [x] UI: gooey bubble, caption, Type + model chip, Log
- [x] Speech: one-click Whisper download, record, transcribe
- [x] host: webview window + local server + event stream
- [x] typecheck + tests green; README with `npm install`, `npm start`
- [ ] ONE announced on-screen run by the main session (window, Type a request, Speak a request, Log)

## Review
(after the run)
