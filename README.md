# Pronto

A tiny floating bubble on your desktop. Tell it what to do, by voice or by typing, and it does it on your computer.

Pronto runs **your own Claude Code** (signed in with your Claude plan, no API key) and gives it
[clawdcursor](https://github.com/AmrDab/clawdcursor) as its hands: it reads apps by name, clicks, types, and checks
every step. For files it can look (read, list, search) and move, rename, make folders, or put things in the Recycle
Bin / Trash; it asks you first before anything goes to the bin or a file gets replaced. It has no shell.

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

The bubble opens at the bottom right of your main screen. Close it from its taskbar button. Until everything it needs
is in place (Claude Code installed and signed in, clawdcursor installed and its one-time consent given), a card on the
bubble lists what is missing and the one command that fixes each.

## Use

- **Speak** (the bubble): hold it still and talk, or tap to start and tap again to stop. Press and move it to drag the
  bubble somewhere else. The first time, it asks once to download the speech model (Whisper base, about 81 MB).
  Speech is turned into text on your computer. While Pronto works, the bubble shows a thinking orb and a beam.
- **Type** (fans out on hover): a one-line box. Enter sends. The chip picks the model: Sonnet, Haiku, or your default.
- **Log**: each request, each step Pronto took and whether it was confirmed, and the answer. **Copy** copies it all.
  Every run is also kept in `~/.pronto/logs/<date>.log`.
- **+** (shortcuts): when every step of a task confirms, Pronto offers to save it as a shortcut (a name and an icon).
  A shortcut replays the same steps directly, with no AI, and stops at the first step that does not confirm. Pinned
  shortcuts fan out around the bubble; click one to run it. Click **+** to see all of them: click one to pin or unpin
  it, or its small × to remove it. Steps that only make sense once (a spot on a screenshot, an element id from one
  session) can't be saved; Pronto says which step.

After a click on the bubble, Pronto gives the keyboard back to the window you were in. Follow-up requests continue
the same conversation until you close Pronto.

## Settings

- `PRONTO_CLAWDCURSOR`: the clawdcursor command to use (default `clawdcursor mcp --compact`), e.g. a dev build:
  `node C:/path/to/clawdcursor/dist/surface/cli.js mcp --compact`.
- `PRONTO_DEVTOOLS=1`: allow the window's devtools.

State lives in `~/.pronto/` (shortcuts in `shortcuts.json`, logs in `logs/`).

## Develop

`npm test` runs the offline unit tests; `npx tsc --noEmit` type-checks.

- `src/main.ts`: the window (`@webviewjs/webview`) and a 127.0.0.1 server (random token) for the UI and its events.
- `src/brain.ts`: starts `claude -p` (stream-json in and out) with clawdcursor, the files server and the read-only
  built-ins (Read, Glob, Grep), and parses what it does.
- `src/files-mcp.ts`: the files MCP server (list_dir, make_folder, move, trash); `src/ask.ts`: its Yes/No questions.
- `src/shortcuts.ts`, `src/replay.ts`: what can be saved, and the replay (Pronto as the MCP client, no model).
- `src/focus.ts`: gives keyboard focus back after a click (Windows). `src/setup.ts`: the first-run check.
  `src/log.ts`: the log format.
- `src/ui/`: the bubble and its cards (`liquid-gooey`, `voice-ring`, `thinking-orbs`, `border-beam` from
  [Libraries.dev](https://libraries.dev)) and speech (`@huggingface/transformers`).

## License

MIT. See `LICENSE`.
