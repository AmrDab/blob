# clawdcursor talk

A small floating bubble for testing clawdcursor by talking to it. It runs your own signed-in Claude Code
(`claude -p`) with clawdcursor as its only tools. Local only: private, no remote, never published.

## Start

```
npm install
npm start
```

`npm start` builds the UI into `dist/` and opens the bubble at the bottom right of the primary display.
Close it from its taskbar button, or with Ctrl+C in the terminal.

Needs `claude` (signed in) and `clawdcursor` on PATH, with clawdcursor's one-time consent already given.

## Use

- **Speak** (the bubble): hold it and talk, or tap to start and tap again to stop. The first time, it asks to download
  the speech model (Whisper base, multilingual, 8-bit: about 81 MB from Hugging Face). After that it is cached in the
  window's storage. Whisper uses the system language (else English).
- **Type** (fans out on hover): a one-line box. Enter sends. The chip picks the model: Sonnet (default), Haiku, or
  Default (whatever Claude Code would pick).
- **Log**: each clawdcursor call and its `[confirmed | unverified | refused | failed]` line.

Follow-up requests continue the same Claude Code session (`--resume`) until the app is closed.

## Settings by environment

- `CLAWD_TALK_CLAWDCURSOR`: the clawdcursor MCP command, to test a dev build, e.g.
  `node C:/path/to/clawdcursor/dist/surface/cli.js mcp --compact` (default `clawdcursor mcp --compact`).
- `CLAWD_TALK_DEVTOOLS=1`: allow the WebView's devtools.

## Files

- `src/main.ts`: the window (`@webviewjs/webview`), a 127.0.0.1 server with a random token for the UI and its event stream.
- `src/brain.ts`: starts `claude -p` (stream-json in and out), strips API-key and host-session env, parses the stream.
- `src/ui/`: React bubble (`liquid-gooey`), caption, Type, Log, and speech (`@huggingface/transformers`).

State lives in `~/.clawdcursor-talk/` (the WebView profile, and `work/`, Claude Code's empty working folder).

`npm test` (offline unit tests) and `npx tsc --noEmit`.
