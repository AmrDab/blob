# Pronto

A tiny floating bubble on your desktop. Tell it what to do, by voice or by typing, and it does it on your computer.

Pronto runs **your own Claude Code** (signed in with your Claude plan, no API key) and gives it
[clawdcursor](https://github.com/AmrDab/clawdcursor) as its hands: it reads apps by name, clicks, types, and checks
every step.

> Early and in progress. Windows first; macOS and Linux are planned.

## Install

Needs [Node.js](https://nodejs.org) 20+, [Claude Code](https://claude.com/claude-code) signed in, and
[clawdcursor](https://github.com/AmrDab/clawdcursor) (`npm i -g clawdcursor`, then accept its one-time consent).

```
git clone https://github.com/AmrDab/pronto.git
cd pronto
npm install
npm start
```

The bubble opens at the bottom right of your main screen. Close it from its taskbar button.

## Use

- **Speak** (the bubble): hold it and talk, or tap to start and tap again to stop. The first time, it asks once to
  download the speech model (Whisper base, about 81 MB). Speech is turned into text on your computer.
- **Type** (fans out on hover): a one-line box. Enter sends. The chip picks the model: Sonnet, Haiku, or your default.
- **Log**: each step Pronto took and whether it was confirmed.

Follow-up requests continue the same conversation until you close Pronto.

## Settings

- `PRONTO_CLAWDCURSOR`: the clawdcursor command to use (default `clawdcursor mcp --compact`), e.g. a dev build:
  `node C:/path/to/clawdcursor/dist/surface/cli.js mcp --compact`.
- `PRONTO_DEVTOOLS=1`: allow the window's devtools.

State lives in `~/.pronto/`.

## Develop

`npm test` runs the offline unit tests; `npx tsc --noEmit` type-checks.

- `src/main.ts`: the window (`@webviewjs/webview`) and a 127.0.0.1 server (random token) for the UI and its events.
- `src/brain.ts`: starts `claude -p` (stream-json in and out) with clawdcursor, and parses what it does.
- `src/ui/`: the bubble (`liquid-gooey` from [Libraries.dev](https://libraries.dev)), caption, Type, Log, and speech
  (`@huggingface/transformers`).

## License

MIT. See `LICENSE`.
