# Blob

A small floating blob on your desktop that does tasks on your computer. Tell it what to do, by voice or by typing,
and it does it while you watch, then says in a sentence that it is done.

- **Any task, the fastest way.** It opens a link, a file or an app directly, runs a command when one does the job,
  uses its file tools for files, and works an app's window only as the last resort.
- **The right model for the job.** On Auto (the default) each request starts on Haiku; Sonnet, then Opus, take over
  only when it gets stuck. Easy requests are fast and cheap; the hardest take a few seconds longer.
- **Reminders and schedules.** "Remind me at 5 to call the bank." "Every weekday at 9, open my mail."
- **Memory.** "Remember that I use Outlook for mail." It is a plain file on your computer that you can read and edit.
- **Simple.** One blob. No settings menu: to change something, just ask ("use Haiku" always uses that one model,
  "pick the model yourself" goes back to Auto, "stop watching").
- **It learns.** A task that worked 3 times becomes a shortcut by itself. If you let it, it also learns which apps
  and sites you use.

Blob runs **your own Claude Code or Codex** (signed in with your own plan, no API key). It opens links, files and
folders with its own tools, and uses [clawdcursor](https://github.com/AmrDab/clawdcursor) to work inside a window
when nothing else does the job: it reads apps by name, clicks, types, and checks every step. For files it can look,
open, move, rename, make folders, or put things in the Recycle Bin / Trash; it asks you
first before anything goes to the bin or a file gets replaced.

On Windows (for now), Blob works an open app in the background first: it presses buttons and fills fields without
taking your screen, your mouse or your keyboard. The screen comes last, when the background way can't do it. A press
like Send or Delete, a link, and replacing text in the field you are typing in ask you first, on a Yes / No card.
Apps that run as administrator can't be controlled.

It can also run commands (PowerShell on Windows, your login shell on macOS and Linux). A command that only looks
(listing a folder, reading a file, `git status`, `winget list`, a `--version`) runs at once. Anything that changes or
installs something is shown to you first, word for word, on a Yes / No card, and runs only on Yes. When Blob is not
sure which kind a command is, it asks.

### Claude Code or Codex

The brain is the one you have: Claude Code, or OpenAI's Codex (`npm i -g @openai/codex`, then `codex login`). Each
needs its own install and its own sign-in; Blob needs one of them, and with only one it uses that one. To switch,
say "use Codex" or "use Claude": Blob asks Yes / No, and the next request starts a new conversation with the other
one. Everything else is the same with both: the same tools, the same Yes / No cards, the same Log, pill and
shortcuts. Codex's own shell, sub-agents, apps and plugins are switched off and what is left of it runs read-only,
so with Codex too Blob's tools are the only way to act. With Codex the chip says `Codex`: it runs its own default
model.

> Early and in progress. Windows first; macOS and Linux are planned.

## Install

Needs [Node.js](https://nodejs.org) 24 or newer (24 LTS recommended).

```
git clone https://github.com/AmrDab/blob.git
cd blob
npm install
npm start
```

The blob opens at the bottom right of your main screen. Close it from its taskbar button.

## First run

Blob walks you through it on small cards, one at a time:

1. **Setup.** *Install Claude Code or Codex* and *Sign in* are commands to copy (they need your own login). *Install
   clawdcursor* and *Give clawdcursor its OK* are one tap each. On a Mac, *Allow Blob to use your Mac* asks for
   Accessibility and Screen Recording, opens the right page of System Settings and notices by itself when you are
   done (Screen Recording may need Blob to be closed and opened again).
2. **Four questions**, Yes or No: learn from what you do, talk to Blob, make shortcuts for you, start Blob when you
   sign in (so reminders and schedules are not missed).
3. **Pair your phone?** Later, or show the QR code.

## Use

- **Speak** (the blob): hold it still and talk, or tap to start and tap again to stop. Press and move it to drag it
  somewhere else. The first time, it asks once to download the speech model (about 81 MB). Speech becomes text on
  your computer.
- **Type** (fans out on hover): a one-line box. The chip next to it is the model; a click changes it: Auto, or
  always Haiku, Sonnet, Opus or Claude Code's default (with Codex it says `Codex`).
- **Log**: each request, each step and whether it was confirmed, and the answer. Also kept in `~/.blob/logs/`.
- **Shortcuts.** A shortcut replays a task's steps directly, with no AI, and stops at the first step that does not
  confirm. When the same task has worked 3 times, Blob makes the shortcut, pins it on the blob and asks once: "Keep
  it?" You can also say "save that as a shortcut" after a task; Blob shows you the steps and asks first. **+** shows
  all of them: click one to pin or unpin it, or its small × to remove it.
- **While it works**, a pill at the top of the screen says what Blob is doing and has **Stop**. When Blob needs you
  (a sign-in, a choice), the pill becomes a card that waits for you.

### Reminders and schedules

- **A reminder** shows its text on the blob at that time, with the system sound, and stays until you press OK. It
  goes to your phone too when one is paired. "Remind me in 20 minutes to check the oven."
- **A scheduled task** runs as if you had typed it, at that time, when Blob is free. Blob asks Yes first, showing
  what will run and when. "Every Monday at 9, open my calendar."
- One time, every day, Monday to Friday, one day a week, or every N minutes; your computer's local time.
- "What is scheduled?" lists them. "Remove the 9 o'clock one" removes it (it asks first).
- They fire only while Blob is open, so say Yes to "Start Blob when you sign in?" (or ask for it later). A task that
  came due while Blob was closed runs once when Blob opens if it is less than an hour late; later than that it is
  skipped, and the Log says so. A missed reminder is still shown.

### No settings menu, just ask

"Use Opus." "Use Codex." "Stop watching." "Turn voice off." "Stop making shortcuts." "Start when I sign in." "Pair my phone." Blob
asks back with a Yes / No card and changes nothing without your Yes.

## Your phone

Say "pair my phone" (or pick it in the first run): Blob shows a QR code for 2 minutes. Scan it with your phone's
camera and the phone becomes a remote microphone: what you ask there runs on your computer, answers and questions
show up on the phone, and Stop on the phone stops everything. "Unpair my phone" ends it.

Messages are end-to-end encrypted between the computer and the phone; the relay in between only passes them on. The
code works for one phone only, and it is kept out of screenshots and away from the AI.

Pairing goes through a relay. By default Blob uses its own public one, at `https://theblob.pages.dev` (the phone page
is at `/phone/` there). To run your own, deploy `relay/` (a small Cloudflare Worker that also serves the phone page
in `phone/`) and name it in `BLOB_RELAY`. `BLOB_RELAY=''` turns phones off: Blob then says plainly that phone pairing
isn't set up.

## Privacy

- **Watching is learn-only**, and off until you say Yes. Blob notes which app, window title and website are in
  front. It reads them from the accessibility tree: never a screenshot, never the text of a page.
- **It stays on your computer**, in `~/.blob/activity.jsonl`, for 14 days. Blob's AI does not see it. If it would
  help, Blob asks "Share what you use most with Blob's AI?" each time, and only on Yes does a short list of your
  most-used apps and sites go to the model (through your own Claude Code or Codex). Window titles never do.
- **"Stop watching"** turns it off. **"Forget what you noted"** deletes it.
- Private browser windows are not noted, and nothing is noted while Blob itself is working.
- The AI can't read or screenshot Blob's own cards and the pill, and can't press their buttons by name: a Yes is yours.
- **Memory is a file on your computer**: `~/.blob/memory.md`, one fact per line. Blob adds a line when you tell it
  to remember something, or when it learns a lasting preference ("uses Outlook for mail"); never passwords or keys.
  The file's facts are sent to the AI (through your own Claude Code or Codex) with each request, so that it knows
  them. To see it, open the file or ask "what do you remember?". To forget, delete lines in the file, or say
  "forget that I use Outlook": Blob shows the lines and asks first.
- **Commands** run as you, in your home folder. Blob's own tokens and any API keys in the environment are not passed
  to them. The AI is told never to put a password or key in a command; each command that changes something is on
  the Yes card in full before it runs.
- **Reminders and schedules** are in `~/.blob/schedule.json`, on your computer.

## Environment

- `BLOB_RELAY`: where the phone relay lives (default `https://theblob.pages.dev`), e.g. your own
  `https://blob-relay.<you>.workers.dev`. Set to `''`: no phone pairing.
- `BLOB_CLAWDCURSOR`: the clawdcursor command (default `clawdcursor mcp --compact`), e.g. a dev build:
  `node C:/path/to/clawdcursor/dist/surface/cli.js mcp --compact`.
- `BLOB_HOME`: where Blob keeps its state (default `~/.blob`).
- `BLOB_DEVTOOLS=1`: allow the window's devtools.

State in `~/.blob/`: `settings.json`, `memory.md`, `schedule.json`, `shortcuts.json`, `habits.json`, `activity.jsonl`,
`pair.json`, `logs/`, and `start.cmd` (Windows, when Blob starts at sign-in).

## Develop

`npm test` runs the offline unit tests; `npx tsc --noEmit` type-checks; `npm run build:phone` builds the phone page.

- `src/main.ts`: the windows (`@webviewjs/webview`) and a 127.0.0.1 server (random tokens) for the UI and its events.
- `src/brain.ts`: starts `claude -p` (stream-json) with clawdcursor, the files server, the self server and the
  read-only built-ins, or `codex exec --json` with the same three servers, and parses what either does into the
  same events.
- `src/ladder.ts`: Auto's ladder: when Haiku hands a request to Sonnet, and Sonnet to Opus.
- `src/settings.ts`, `src/self-mcp.ts`, `src/persona.ts`: the settings, the "blob" tools that change them after a
  Yes, and the brief the AI gets (what Blob can do, and the order to try it in).
- `src/shell.ts`: the `run` tool: which commands only look, the Yes card for the rest, and the run itself.
- `src/memory.ts`, `src/schedule.ts`, `src/autostart.ts`: the memory file, reminders and scheduled tasks, and
  starting at sign-in (a `Run` registry value on Windows, a LaunchAgent on macOS).
- `src/habits.ts`, `src/watch.ts`: shortcuts from repeated tasks, and the learn-only watcher.
- `src/files-mcp.ts`, `src/ask.ts`: the files tools (and `run`) and the Yes/No questions.
- `src/shortcuts.ts`, `src/replay.ts`: what can be saved, and the replay (no model).
- `src/pill-host.ts`, `src/pill.ts`, `src/overlay.ts`, `src/own-ui.ts`: clawdcursor's pill, drawn by Blob, and
  keeping Blob's own windows out of the agent's reach.
- `src/pair.ts`, `src/pair-crypto.ts`, `relay/`, `phone/`: phone pairing.
- `src/setup.ts`: the first-run check and its one-tap fixes. `src/focus.ts`: gives the keyboard back after a click.
- `src/ui/`: the blob and its cards (`liquid-gooey`, `voice-ring`, `thinking-orbs`, `border-beam` from
  [Libraries.dev](https://libraries.dev)) and speech (`@huggingface/transformers`).

## License

Apache License 2.0. See `LICENSE`.
