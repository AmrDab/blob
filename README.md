# Blob

A small floating blob on your desktop that makes the computer and the internet simple. Tell it what to do, by voice
or by typing, and it does it on your computer while you watch.

- **Simple.** One blob. No settings menu: to change something, just ask ("use Haiku", "stop watching").
- **It learns.** A task that worked 3 times becomes a shortcut by itself. If you let it, it also learns which apps
  and sites you use.
- **It knows itself.** Ask it what it is, what it can do or how it is set up, and it tells you.

Blob runs **your own Claude Code** (signed in with your Claude plan, no API key) and gives it
[clawdcursor](https://github.com/AmrDab/clawdcursor) as its hands: it reads apps by name, clicks, types, and checks
every step. For files it can look, move, rename, make folders, or put things in the Recycle Bin / Trash; it asks you
first before anything goes to the bin or a file gets replaced. It has no shell.

> Early and in progress. Windows first; macOS and Linux are planned.

## Install

Needs [Node.js](https://nodejs.org) 20+.

```
git clone https://github.com/AmrDab/blob.git
cd blob
npm install
npm start
```

The blob opens at the bottom right of your main screen. Close it from its taskbar button.

## First run

Blob walks you through it on small cards, one at a time:

1. **Setup.** *Install Claude Code* and *Sign in* are commands to copy (they need your own login). *Install
   clawdcursor* and *Give clawdcursor its OK* are one tap each. On a Mac, *Allow Blob to use your Mac* asks for
   Accessibility and Screen Recording, opens the right page of System Settings and notices by itself when you are
   done (Screen Recording may need Blob to be closed and opened again).
2. **Three questions**, Yes or No: learn from what you do, talk to Blob, make shortcuts for you.
3. **Pair your phone?** Later, or show the QR code (only when a relay is set, see below).

## Use

- **Speak** (the blob): hold it still and talk, or tap to start and tap again to stop. Press and move it to drag it
  somewhere else. The first time, it asks once to download the speech model (about 81 MB). Speech becomes text on
  your computer.
- **Type** (fans out on hover): a one-line box. The chip next to it is the model; a click changes it.
- **Log**: each request, each step and whether it was confirmed, and the answer. Also kept in `~/.blob/logs/`.
- **Shortcuts.** A shortcut replays a task's steps directly, with no AI, and stops at the first step that does not
  confirm. When the same task has worked 3 times, Blob makes the shortcut, pins it on the blob and asks once: "Keep
  it?" You can also say "save that as a shortcut" after a task; Blob shows you the steps and asks first. **+** shows
  all of them: click one to pin or unpin it, or its small × to remove it.
- **While it works**, a pill at the top of the screen says what Blob is doing and has **Stop**. When Blob needs you
  (a sign-in, a choice), the pill becomes a card that waits for you.

### No settings menu, just ask

"Use Opus." "Stop watching." "Turn voice off." "Stop making shortcuts." "Pair my phone." Blob asks back with a Yes /
No card and changes nothing without your Yes.

## Your phone

Say "pair my phone" (or pick it in the first run): Blob shows a QR code for 2 minutes. Scan it with your phone's
camera and the phone becomes a remote microphone: what you ask there runs on your computer, answers and questions
show up on the phone, and Stop on the phone stops everything. "Unpair my phone" ends it.

Messages are end-to-end encrypted between the computer and the phone; the relay in between only passes them on. The
code works for one phone only, and it is kept out of screenshots and away from the AI.

Pairing needs a relay (`relay/`, a small Cloudflare Worker that also serves the phone page in `phone/`). Until one is
deployed and named in `BLOB_RELAY`, Blob says plainly that phone pairing isn't set up yet.

## Privacy

- **Watching is learn-only**, and off until you say Yes. Blob notes which app, window title and website are in
  front. It reads them from the accessibility tree: never a screenshot, never the text of a page.
- **It stays on your computer**, in `~/.blob/activity.jsonl`, for 14 days. Blob's AI does not see it. If it would
  help, Blob asks "Share what you use most with Blob's AI?" each time, and only on Yes does a short list of your
  most-used apps and sites go to the model (to Claude, through your own Claude Code). Window titles never do.
- **"Stop watching"** turns it off. **"Forget what you noted"** deletes it.
- Private browser windows are not noted, and nothing is noted while Blob itself is working.
- The AI can't read or screenshot Blob's own cards and the pill, and can't press their buttons by name: a Yes is yours.

## Environment

- `BLOB_RELAY`: where the phone relay lives, e.g. `https://blob-relay.<you>.workers.dev`. Not set: no phone pairing.
- `BLOB_CLAWDCURSOR`: the clawdcursor command (default `clawdcursor mcp --compact`), e.g. a dev build:
  `node C:/path/to/clawdcursor/dist/surface/cli.js mcp --compact`.
- `BLOB_HOME`: where Blob keeps its state (default `~/.blob`).
- `BLOB_DEVTOOLS=1`: allow the window's devtools.

State in `~/.blob/`: `settings.json`, `shortcuts.json`, `habits.json`, `activity.jsonl`, `pair.json`, `logs/`.

## Develop

`npm test` runs the offline unit tests; `npx tsc --noEmit` type-checks; `npm run build:phone` builds the phone page.

- `src/main.ts`: the windows (`@webviewjs/webview`) and a 127.0.0.1 server (random tokens) for the UI and its events.
- `src/brain.ts`: starts `claude -p` (stream-json) with clawdcursor, the files server, the self server and the
  read-only built-ins, and parses what it does.
- `src/settings.ts`, `src/self-mcp.ts`, `src/persona.ts`: the settings, the "blob" tools that change them after a
  Yes, and what Blob knows about itself.
- `src/habits.ts`, `src/watch.ts`: shortcuts from repeated tasks, and the learn-only watcher.
- `src/files-mcp.ts`, `src/ask.ts`: the files tools and the Yes/No questions.
- `src/shortcuts.ts`, `src/replay.ts`: what can be saved, and the replay (no model).
- `src/pill-host.ts`, `src/pill.ts`, `src/overlay.ts`, `src/own-ui.ts`: clawdcursor's pill, drawn by Blob, and
  keeping Blob's own windows out of the agent's reach.
- `src/pair.ts`, `src/pair-crypto.ts`, `relay/`, `phone/`: phone pairing.
- `src/setup.ts`: the first-run check and its one-tap fixes. `src/focus.ts`: gives the keyboard back after a click.
- `src/ui/`: the blob and its cards (`liquid-gooey`, `voice-ring`, `thinking-orbs`, `border-beam` from
  [Libraries.dev](https://libraries.dev)) and speech (`@huggingface/transformers`).

## License

MIT. See `LICENSE`.
