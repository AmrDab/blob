// The host: a 127.0.0.1 server for the built UI and its event stream, the bubble window, the Brain, shortcuts,
// the settings (changed by asking Blob, never by a menu), the files and self servers' questions, the desk (open
// windows worked in the background, Windows only), clawdcursor's pill,
// the paired phone, the learn-only watcher, reminders and scheduled tasks, starting at sign-in, focus hand-back, the
// log file and the first-run check.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Application } from '@webviewjs/webview';
import { Brain, callLabel, mcpConfig, mcpServers, type BrainEvent, type Call, type ServerCommand } from './brain.ts';
import { MAX_DETAIL, Questions } from './ask.ts';
import { clickThrough, cursorReader, follower, type ClickThrough } from './clickthrough.ts';
import { computerBrief, computerFile, computerNow, refreshProfile } from './computer.ts';
import { Bridge, deskTools, ownPids } from './desk.ts';
import { setAutostart, systemAutostart } from './autostart.ts';
import { focusKeeper, type FocusKeeper } from './focus.ts';
import { habitsFile, record, type Proposal } from './habits.ts';
import { formatRow, logFileName, type LogBody, type LogRow } from './log.ts';
import { macSetup } from './mac.ts';
import { memoryBrief, memoryFile } from './memory.ts';
import { os } from './os/index.ts';
import { hideFromCapture, overlay, type Overlay } from './overlay.ts';
import { keepOwnUiFile } from './own-ui.ts';
import { Pairing, createRoom, loadRoom, pairFile, qrSvg, qrUrl, saveRoom, type Reply, type RoomInfo } from './pair.ts';
import { persona } from './persona.ts';
import { scriptsBrief, scriptsDir } from './scripts.ts';
import { answerLine, parseCommand, type PillAnswer, type PillState } from './pill.ts';
import { mcpCaller, replay } from './replay.ts';
import { loadSchedule, saveSchedule, scheduleFile, stamp, tick, type Entry } from './schedule.ts';
import { ASK, FIRST_RUN, SettingsStore, WHAT, blobHome, offerPair, parseValue, type BrainName, type Model } from './settings.ts';
import { MAX_PINNED, MAX_SHORTCUTS } from './shared.ts';
import { loadShortcuts, nameFrom, saveOffer, saveQuestion, saveShortcuts, type Shortcut } from './shortcuts.ts';
import { fix, fixNote, macNeeds, openPane, pickBrain, runChecks, type Check } from './setup.ts';
import { Watcher, activityFile, clawdcursorReader } from './watch.ts';

const HOME = blobHome();
// Blob was called Pronto: move its shortcuts and logs over once
const OLD = join(homedir(), '.pronto');
if (existsSync(OLD) && !existsSync(HOME)) try { renameSync(OLD, HOME); } catch { /* keep the old folder */ }
const WORK = join(HOME, 'work');                     // the brain's cwd: empty, and the same every time so --resume finds the session
const LOGS = join(HOME, 'logs');
const SHORTCUTS = join(HOME, 'shortcuts.json');
const PAIR = pairFile();
// Where the phone relay and the phone page live (https://… or wss://…). Not set: phone pairing isn't set up.
const RELAY = (process.env.BLOB_RELAY ?? 'https://theblob.pages.dev').trim().replace(/^ws/, 'http').replace(/\/+$/, '');
const QR_MS = 2 * 60_000;                           // how long an unscanned QR stays up
const KEEP_MS = 10 * 60_000;                        // how long the "Keep it?" offer stays up
const SCHEDULE = scheduleFile();
const SCHEDULE_MS = 20_000;                         // how often the host looks for a due reminder or task
const DIST = resolve(import.meta.dirname, '..', 'dist');
// A fixed port keeps the page's origin, and so the cached Whisper model, the same across starts; any free port if taken.
const PORT = 47615;
const START = { w: 320, h: 230 };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

mkdirSync(WORK, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'blob-'));
const mcpConfigPath = join(tmp, 'mcp.json');
const token = randomBytes(24).toString('hex');      // the page's
const askToken = randomBytes(24).toString('hex');   // the files server's: it can only ask a question
const pillToken = randomBytes(24).toString('hex');  // the pill relay's: it can only show clawdcursor's pill
const selfToken = randomBytes(24).toString('hex');  // the self server's: save a shortcut, pair or unpair the phone
const deskToken = randomBytes(24).toString('hex');  // the desk server's: read and work open windows in the background
const settings = new SettingsStore();

// ── events to the page ───────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();
const history: string[] = [];                     // replayed to a page that (re)connects
function send(e: object): void {
  const data = `data: ${JSON.stringify(e)}\n\n`;
  history.push(data);
  if (history.length > 500) history.shift();
  for (const c of clients) c.write(data);
}
/** For the page that is open now only: not replayed to one that connects later. */
function tell(e: object): void {
  for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
}

/** A log row: to the page and to today's file. */
function row(r: LogBody): void {
  const full: LogRow = { t: Date.now(), ...r };
  send({ type: 'row', row: full });
  try { mkdirSync(LOGS, { recursive: true }); appendFileSync(join(LOGS, logFileName(full.t)), formatRow(full) + '\n'); } catch { /* the log file is a convenience */ }
}
const caption = (text: string) => send({ type: 'caption', text });
const answer = (text: string) => { caption(text); row({ kind: 'answer', text }); pairing?.answer(text); };
/** Blob (a run or a shortcut) started or stopped working: the page and the phone show it. */
const busy = (on: boolean) => { send({ type: 'busy', busy: on }); pairing?.status(on ? 'working' : 'ready'); };
/** The brains that are installed and signed in, as of the last check. */
let ready: BrainName[] = [];
/** The brain in use: the setting's, or the other one when only that one is ready. */
const brainNow = () => pickBrain(settings.get().brain, ready);
/** What the page needs of the settings: the brain and model on the chip, whether Speak listens, and the first-run questions. */
function sendSettings(): void {
  const s = settings.get();
  send({
    type: 'settings', brain: brainNow(), model: s.model, voice: s.voice, onboarded: s.onboarded, offerPair: offerPair(s, !!RELAY),
    firstRun: FIRST_RUN.filter(key => key !== 'startAtLogin' || os.autostart).map(key => ({ key, title: ASK[key], text: WHAT[key] })),
  });
}

// ── state ────────────────────────────────────────────────────────────────────
let brain!: Brain;
let focus: FocusKeeper = { restore() {}, stop() {} };
let through: ClickThrough | undefined;             // the bubble's window lets clicks through its empty pixels
let filesServer!: ServerCommand;
let request = '';                                   // the current run's request
let last: ReturnType<typeof saveOffer> = null;      // what the last finished run can be saved as ("save that as a shortcut")
let lastName = '';
let replaying = false;
let replayMcp: ReturnType<typeof mcpCaller> | null = null;
let shortcuts: Shortcut[] = loadShortcuts(SHORTCUTS);
let pairing: Pairing | null = null;                 // the phone: paired, or a QR waiting to be scanned
let qrTimer: ReturnType<typeof setTimeout> | undefined;
let watcher: Watcher | undefined;

// A question shows on the bubble and on the paired phone; the first answer counts.
const questions = new Questions({
  show: (id, question, detail) => {
    send({ type: 'ask', id, question, detail });
    pairing?.ask({ id: `q${id}`, question: detail ? `${question}\n${detail}` : question });
  },
  hide: id => { send({ type: 'ask-done', id }); pairing?.askDone(`q${id}`); },
});

// ── the desk ─────────────────────────────────────────────────────────────────
// Windows: one bridge for as long as Blob runs, started now so the first read finds it warm. Its Yes card is a
// question like any other; Blob's own windows and its web view's processes are looked up again at every call.
const bridge = os.id !== 'win32' ? undefined : new Bridge({
  script: join(DIST, 'desk-bridge.ps1'),
  spawn: (command, args, o) => spawn(command, args, o),
  kill: pid => { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); },
});
const desk = bridge && deskTools({
  bridge, ask: (q, d) => questions.ask(q, undefined, d), own: () => ownPids(process.env.BLOB_OWN_UI_FILE), log: console.log,
});
void bridge?.call({ cmd: 'windows' }).catch(() => { /* the first tool call says why */ });

// ── clawdcursor's pill ───────────────────────────────────────────────────────
// clawdcursor starts dist/pill-host.mjs in place of its own pill (brain.ts). That relay keeps one request open: its
// body is the pill's state and then clawdcursor's lines, its response carries the answers. The pill is on screen for
// as long as that request lives.
type Pill = { state: PillState; res: ServerResponse };
let pill: Pill | null = null;
let pillUi: Overlay = { show() {}, hide() {}, keyboard() {}, beep() {}, asksRefocus: false };
let pillGone: ReturnType<typeof setTimeout> | undefined;
let pillBack: ReturnType<typeof setTimeout> | undefined;     // the end of a dodge
const pillClients = new Set<ServerResponse>();
const pillEvent = () => `data: ${JSON.stringify({ state: pill?.state ?? null })}\n\n`;
function sendPill(): void { for (const c of pillClients) c.write(pillEvent()); }

function closePill(linger = false): void {
  pill = null;
  pairing?.askDone('pill');
  clearTimeout(pillBack);
  clearTimeout(pillGone);
  const gone = () => { sendPill(); pillUi.keyboard(false); pillUi.hide(); };
  // clawdcursor swaps the running pill for the paused card by killing one relay and starting the next: wait a
  // moment, so the one on screen morphs into the next instead of blinking.
  if (linger) pillGone = setTimeout(gone, 250); else gone();
}

function servePill(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.flushHeaders();
  let mine: Pill | undefined;
  // A relay is killed whenever clawdcursor hides the pill, so an aborted request is normal, never a crash.
  req.on('error', () => {});
  createInterface({ input: req }).on('error', () => {}).on('line', line => {
    if (!mine) {                                    // the first line: what the pill starts as
      let state: PillState | undefined;
      try { state = JSON.parse(line); } catch { /* below */ }
      if (state?.mode !== 'running' && state?.mode !== 'paused') { res.end(); return; }
      pill = mine = { state, res };               // the newest relay wins; an older one is being killed by clawdcursor
      clearTimeout(pillGone);
      clearTimeout(pillBack);
      sendPill();
      pillUi.show();
      if (state.mode === 'paused') {
        if (state.sound) pillUi.beep();
        // The pause shows on the phone too: its choices, a typed reply, or Yes (Resume) / No (End task).
        pairing?.ask({ id: 'pill', question: state.message, ...(state.choices.length && { choices: state.choices }), ...(state.input && { input: true }) });
      }
      return;
    }
    if (pill !== mine) return;
    const c = parseCommand(line);
    if (c?.type === 'hide') {                       // an agent's click is coming: out of its way, back after c.ms
      const p = mine;
      pillUi.hide();
      clearTimeout(pillBack);
      pillBack = setTimeout(() => { if (pill === p) pillUi.show(); }, c.ms);
    } else if (c?.type === 'activity' && mine.state.mode === 'running') {
      mine.state = { mode: 'running', activity: c.text.slice(0, 80) };
      sendPill();
    }
  });
  req.on('end', () => res.end());                   // stdin closed
  res.on('close', () => { if (mine && pill === mine) closePill(true); });   // ...or the relay was killed
}

/** The user's click on the pill: one line back to clawdcursor, and the pill is done (as clawdcursor's own exits). */
function answerPill(a: PillAnswer): void {
  const line = pill && a.kind !== 'refocus' ? answerLine(a, pill.state) : null;
  if (!pill || !line) return;
  pill.res.end(line + '\n');
  closePill();
}

function sendShortcuts(): void {
  send({ type: 'shortcuts', list: shortcuts.map(s => ({ id: s.id, name: s.name, icon: s.icon, pinned: s.pinned })) });
}
function store(list: Shortcut[]): void {
  shortcuts = list;
  try { saveShortcuts(SHORTCUTS, list); } catch (e) { caption(`Could not save shortcuts: ${(e as Error).message}`); }
  sendShortcuts();
}

/** A new shortcut, pinned while the inner arc has room. Null when the list is full. */
function addShortcut(name: string, icon: string, steps: Shortcut['steps']): Shortcut | null {
  if (shortcuts.length >= MAX_SHORTCUTS) return null;
  const s = { id: randomUUID(), name, icon, pinned: shortcuts.filter(x => x.pinned).length < MAX_PINNED, steps };
  store([...shortcuts, s]);
  return s;
}

/**
 * "Save that as a shortcut" (the self server): the last finished run, when every step of it confirmed. A shortcut
 * runs later with no model looking, so the user says Yes to it first: the question is Blob's, with the request's
 * own words and the steps, never the model's.
 */
async function saveLast(): Promise<{ ok: boolean; text: string }> {
  if (!last) return { ok: false, text: 'the last task cannot be a shortcut: it did nothing on screen, or a step did not confirm' };
  if ('why' in last) return { ok: false, text: `the last task cannot be a shortcut: ${last.why}` };
  const { steps } = last, name = lastName;
  if (!(await questions.ask(saveQuestion(name, steps)))) return { ok: false, text: 'the user said No (or did not answer); nothing was saved' };
  const s = addShortcut(name, 'star', steps);
  if (!s) return { ok: false, text: `there are ${MAX_SHORTCUTS} shortcuts already: the user removes one first (the + blob)` };
  return { ok: true, text: `Saved "${s.name}"${s.pinned ? ' on the bubble' : '; it can be pinned from the + blob'}.` };
}

/**
 * The same task worked 3 times (habits.ts): the shortcut is made, and the user is offered once to keep it. An offer,
 * not a question: it never holds up a real one (ask.ts). Only a No removes the shortcut: with no answer it stays, and
 * can be removed from the + blob.
 */
async function propose(p: Proposal): Promise<void> {
  const s = addShortcut(p.name, p.icon, p.steps);
  if (!s) return;
  if ((await questions.offer(`I made a shortcut for "${p.name}". Keep it?`, KEEP_MS)) === false) store(shortcuts.filter(x => x.id !== s.id));
}

/** A run ended. Only runs are noted, never a shortcut's replay (it does not come through here). */
function finished(calls: Call[], ok: boolean): void {
  last = ok ? saveOffer(calls) : null;
  lastName = nameFrom(request);
  if (!settings.get().autoShortcuts) return;
  let p: Proposal | null = null;
  try { p = record(habitsFile(), { request, calls, ok }, shortcuts); } catch { /* habits are a convenience */ }
  if (p) void propose(p);
}

function onBrain(e: BrainEvent): void {
  if (e.type === 'log') row({ kind: 'call', ...e.entry });
  else if (e.type === 'answer') answer(e.text);
  else if (e.type === 'busy') busy(e.busy);
  else if (e.type === 'done') finished(e.calls, e.ok);
  else if (e.type !== 'session') send(e);
}

/** Starts a request: typed, spoken, or from the phone. Returns why not, when it can't. */
function run(text: string): string | null {
  if (replaying) return 'A shortcut is still running.';
  if (!brain.run(text, settings.get().model, brainNow())) return 'Still working on the last request.';
  request = text;
  row({ kind: 'request', text });
  return null;
}

// ── reminders and scheduled tasks ────────────────────────────────────────────
const waiting: Entry[] = [];                        // tasks that came due while Blob was working

/** A reminder: a card that stays until it is dismissed, the system sound, and the phone when one is paired. */
function remind(e: Entry, due: number): void {
  send({ type: 'reminder', id: `${e.id}-${due}`, text: e.text, at: stamp(due).slice(11) });
  row({ kind: 'answer', text: `Reminder: ${e.text}` });
  if (os.id === 'darwin') spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' }).on('error', () => {});
  else pillUi.beep();
  pairing?.answer(`Reminder: ${e.text}`);
}

/** Every 20 s, and once at the start (what was missed while Blob was closed comes due then). */
function checkSchedule(): void {
  const now = Date.now();
  const t = tick(loadSchedule(SCHEDULE), now);
  if (t.fire.length) {
    // saved first: an entry whose firing can't be written down would fire again at every look
    try { saveSchedule(SCHEDULE, t.entries); } catch (e) { caption(`Could not save the schedule: ${(e as Error).message}`); return; }
  }
  for (const f of t.fire) {
    if (f.entry.kind === 'remind') remind(f.entry, f.due);
    else if (f.late) row({ kind: 'answer', text: `Skipped a scheduled task (due ${stamp(f.due)}, more than an hour ago): ${f.entry.text}` });
    else if (!waiting.some(w => w.id === f.entry.id)) waiting.push(f.entry);
  }
  // a task runs like a typed request, when Blob is free
  if (waiting.length && !brain.busy && !replaying && !run(waiting[0].text)) waiting.shift();
}

/** The startAtLogin setting changed: make the system match. If it can't be turned on, the setting goes back to off. */
async function applyAutostart(on: boolean): Promise<void> {
  const r = await setAutostart(on, systemAutostart(os.autostart?.exe), os.autostart?.apply);
  if (r.ok || !on) return;
  caption(r.text);
  try { settings.set('startAtLogin', false); } catch { /* the caption said it */ }
}

/** The phone's Stop: what the pill's Stop does, and the request (or the shortcut) ends even when no pill is up. */
function stopAll(): void {
  if (pill) answerPill({ kind: pill.state.mode === 'running' ? 'stop' : 'end' });
  brain.halt();
  void replayMcp?.close();
}

// ── the phone ────────────────────────────────────────────────────────────────
function setPaired(on: boolean): void {
  try { settings.set('phonePaired', on); } catch { /* a status only */ }
}

/** The phone's answer to an ask that is open (pair.ts drops any other): a bubble question, or the pill's pause. */
function phoneReply(r: Reply): void {
  if (r.id !== 'pill') { questions.answer(r.id.slice(1), r.yes === true); return; }
  const s = pill?.state;
  if (s?.mode !== 'paused') return;
  if (typeof r.choice === 'string') answerPill({ kind: 'choice', index: s.choices.indexOf(r.choice) });
  else if (typeof r.text === 'string') answerPill({ kind: 'reply', text: r.text });
  else answerPill({ kind: r.yes === true ? 'resume' : 'end' });
}

/** Connects to the room. `paired`: a phone joined it before; otherwise its QR is on the bubble now. */
function connectPhone(info: RoomInfo, paired: boolean): void {
  const p = pairing = new Pairing(info, { file: PAIR });
  p.on('phone', on => {
    if (!on) return;
    if (!paired) {                                  // the QR was scanned: this is the paired phone from now on
      paired = true;
      clearTimeout(qrTimer);
      send({ type: 'qr', svg: null });
      try { saveRoom(PAIR, info); } catch { /* paired until Blob closes */ }
      setPaired(true);
      caption('Your phone is paired.');
    }
    p.status(brain.busy || replaying ? 'working' : 'ready');
  });
  p.on('request', r => { const why = run(r.text); if (why) p.answer(why); });
  p.on('reply', phoneReply);
  p.on('stop', stopAll);
  p.on('unpaired', () => {                          // unpaired, expired, or the room is gone: pair.ts forgot it
    if (pairing === p) pairing = null;
    if (!paired) return;
    setPaired(false);
    caption('Your phone is unpaired.');
  });
  void p.connect().catch(() => { /* an address that can't be used: nothing connects */ });
}

/** "Pair my phone": a new room, and its QR on the bubble until a phone joins, the card is closed or 2 minutes pass. */
function showQr(): { ok: boolean; text: string } {
  if (!RELAY) return { ok: false, text: "Phone pairing isn't set up yet." };
  if (pairing) return { ok: false, text: settings.get().phonePaired ? 'A phone is paired already. Unpair it first.' : 'The QR code is on the bubble already.' };
  const info = createRoom(RELAY);
  connectPhone(info, false);
  send({ type: 'qr', svg: qrSvg(qrUrl(info)) });
  try { settings.set('pairOffered', true); } catch { /* the card may show once more */ }
  clearTimeout(qrTimer);
  qrTimer = setTimeout(() => closeQr('The code expired. Ask me to pair your phone again.'), QR_MS);
  return { ok: true, text: 'The QR code is on the bubble for 2 minutes. The user scans it with their phone\'s camera.' };
}

/** The QR goes away unscanned (closed, or timed out): its room is ended, so the code can never be used. */
function closeQr(say?: string): void {
  clearTimeout(qrTimer);
  send({ type: 'qr', svg: null });
  if (!pairing || settings.get().phonePaired) return;
  const p = pairing;
  pairing = null;
  p.unpair();
  if (say) caption(say);
}

/** What only the host can do for the self server (self-mcp.ts). */
async function selfAction(body: any): Promise<{ ok: boolean; text: string }> {
  if (body.action === 'save_shortcut') return saveLast();
  if (body.action === 'pair') return showQr();
  if (body.action === 'unpair') {
    if (!pairing || !settings.get().phonePaired) return { ok: true, text: 'No phone is paired.' };
    pairing.unpair();
    return { ok: true, text: 'The phone is unpaired.' };
  }
  return { ok: false, text: 'Blob does not know that' };
}

async function runShortcut(s: Shortcut): Promise<void> {
  replaying = true;
  busy(true);
  row({ kind: 'request', text: `Shortcut: ${s.name}` });
  const n = s.steps.length;
  const mcp = replayMcp = mcpCaller(filesServer);
  try {
    const end = await replay(s.steps, mcp.call, {
      start: (i, st) => {
        const l = callLabel(st.server, st.tool, st.args);
        caption(`${s.name} · ${i + 1}/${n}: ${l.tool}${l.action ? ' · ' + l.action : ''}…`);
      },
      result: (_i, r) => row({ kind: 'call', ...r }),
    });
    if (end.ok) answer(`Done: ${s.name}.`);
    else {
      const l = callLabel(s.steps[end.at].server, s.steps[end.at].tool, s.steps[end.at].args);
      answer(`Stopped at step ${end.at + 1} of ${n} (${l.tool}${l.action ? ' · ' + l.action : ''}): ${end.line}`);
    }
  } finally {
    await mcp.close();
    replayMcp = null;
    replaying = false;
    busy(false);
  }
}

async function check(): Promise<Check[]> {
  try {
    const checks = await runChecks();
    const was = brainNow();
    ready = checks.find(c => c.id === 'brain')?.ready ?? [];
    if (brainNow() !== was) sendSettings();           // only the other brain is ready: the chip shows it
    send({ type: 'setup', checks });
    return checks;
  } catch { return []; }                            // checks are best effort
}

/** One tap on a setup card: Blob runs the fix (the orb turns while it does) and checks again. */
async function setupFix(id: string): Promise<void> {
  busy(true);
  let ok = false;
  try { ok = await fix(id); } finally { busy(false); }
  const still = (await check()).find(c => c.id === id && !c.ok);
  if (still && id === 'mac') watchMac();
  else if (still && ok) caption(`${still.label}: not done yet.`);
  else if (still && fixNote) caption(fixNote);       // Blob knows why (macOS: npm can't write its global folder)
  else if (still) {
    caption(`That didn't work. Tap ${still.tap ?? 'it'} to try again.`);
    console.log(`Blob: setup step "${still.id}" failed; in a terminal, run: ${still.fix}`);
  }
}

// macOS: while a permission is missing, look every 2 s by itself, with the pane for the missing one open.
let macTimer: ReturnType<typeof setTimeout> | undefined;
let macPane = '';
function watchMac(): void {
  clearTimeout(macTimer);
  macTimer = setTimeout(async () => {
    const m = await macNeeds().catch(() => ({ ok: false, pane: undefined }));
    if (m.ok) { macPane = ''; await check(); return; }
    if (m.pane && m.pane !== macPane) openPane(macPane = m.pane);   // Accessibility first, Screen Recording once that is on
    watchMac();
  }, 2000);
  macTimer.unref();
}

function openMicSettings(): void {
  const o = { windowsHide: true, detached: true, stdio: 'ignore' as const };
  if (os.micSettings) spawn(...os.micSettings, o).unref();
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function post(path: string, body: any): Promise<void> {
  switch (path) {
    case '/prewarm': brain.prewarm(settings.get().model, brainNow()); return;
    case '/model': {                                // a click on the chip: the user's own choice, no question
      const m = parseValue('model', body.model);
      if (m !== undefined) settings.set('model', m as Model);
      if (body.stay !== true) focus.restore();     // from the open Type box: keep typing there
      return;
    }
    case '/cancel': brain.cancel(); return;
    case '/size': resize(Number(body.w), Number(body.h), Number(body.r), Number(body.b)); return;
    case '/hit': through?.set(body); return;                          // which pixels of the window are Blob
    case '/focus-back': focus.restore(); return;
    case '/run': {
      const text = str(body.text);
      if (!text) return;
      focus.restore();
      const why = run(text);
      if (why) caption(why);
      return;
    }
    case '/answer': questions.answer(str(body.id), body.yes === true); focus.restore(); return;
    case '/reminder/done': send({ type: 'reminder-done', id: str(body.id) }); focus.restore(); return;
    case '/pair/close': closeQr(); focus.restore(); return;
    case '/shortcut/run': {
      const s = shortcuts.find(x => x.id === body.id);
      focus.restore();
      if (!s) return;
      if (brain.busy || replaying) { caption('Still working on the last request.'); return; }
      void runShortcut(s);
      return;
    }
    case '/shortcut/pin': {
      const pin = body.pinned === true;
      if (pin && shortcuts.filter(s => s.pinned).length >= MAX_PINNED) { caption(`${MAX_PINNED} are pinned already: unpin one first.`); return; }
      store(shortcuts.map(s => (s.id === body.id ? { ...s, pinned: pin } : s)));
      return;
    }
    case '/shortcut/delete': store(shortcuts.filter(s => s.id !== body.id)); return;
    case '/setup/check': focus.restore(); await check(); return;
    case '/setup/fix': focus.restore(); await setupFix(str(body.id)); return;
    case '/firstrun': {                             // a first-run card: the user's own tap, no question
      focus.restore();
      const key = FIRST_RUN.find(k => k === body.key);
      if (body.key === 'pair') {                    // the phone's card: answered once, Show QR or Later
        settings.set('pairOffered', true);
        if (body.value === true) { const r = showQr(); if (!r.ok) caption(r.text); }
      } else if (body.done === true) settings.set('onboarded', true);
      else if (key && typeof body.value === 'boolean') {
        settings.set(key, body.value);
        if (key === 'startAtLogin' && !body.value) void applyAutostart(false);   // No: make sure nothing is left
      }
      return;
    }
    case '/setup/mic': openMicSettings(); return;
    case '/pill/answer': answerPill(body); return;
    case '/pill/size': placePill(Number(body.w), Number(body.h)); return;
    case '/pill/keyboard': {                        // a click into the reply box takes the keyboard; Esc gives it back
      if (pill?.state.mode !== 'paused') return;
      pillUi.keyboard(body.on === true);
      if (body.on === true) pillView.focus();
      else if (pillUi.asksRefocus) pill.res.write(answerLine({ kind: 'refocus' }, pill.state) + '\n');
      return;
    }
  }
}

// ── server ───────────────────────────────────────────────────────────────────
let port = PORT;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }   // no DNS rebinding
  if (url.pathname === '/events') {
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const d of history) res.write(d);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/pill-events') {
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(pillEvent());
    pillClients.add(res);
    req.on('close', () => pillClients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/pill') {
    if (req.headers['x-pill-token'] !== pillToken) { res.writeHead(403).end(); return; }
    servePill(req, res);
    return;
  }
  if (req.method === 'POST') {
    const asking = url.pathname === '/ask', self = url.pathname === '/self', desking = url.pathname === '/desk';
    const allowed = asking ? req.headers['x-ask-token'] === askToken : self ? req.headers['x-self-token'] === selfToken
      : desking ? req.headers['x-desk-token'] === deskToken : req.headers['x-talk-token'] === token;
    if (!allowed) { res.writeHead(403).end(); return; }
    let body: any = {};
    try { let s = ''; for await (const c of req) s += c; body = JSON.parse(s || '{}'); } catch { /* empty body */ }
    if (self) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await selfAction(body)));
      return;
    }
    if (desking) {                                  // the desk server passes a tool call on: { tool, args }
      const tool = desk && (body.tool === 'read' || body.tool === 'act' || body.tool === 'open') ? desk[body.tool as 'read' | 'act' | 'open'] : undefined;
      if (!tool) { res.writeHead(404).end(); return; }
      let r, closed = false;                        // the model's process ended (Stop): an act presses nothing more
      res.on('close', () => { closed = true; });
      try { r = await (body.tool === 'act' ? desk!.act(body.args ?? {}, () => closed) : tool(body.args ?? {})); } catch { res.writeHead(500).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
      return;
    }
    if (asking) {
      // `detail` (a command, a task's words) is shown whole or the question is not asked at all: never cut
      const question = str(body.question), detail = typeof body.detail === 'string' ? body.detail : '';
      const yes = question && detail.length <= MAX_DETAIL ? await questions.ask(question.slice(0, 400), undefined, detail || undefined) : false;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ yes, shown: !!detail }));
      return;
    }
    if (url.pathname === '/move') {                 // Speak is dragged: Blob's own window follows, and says how far it went
      let went: { dx: number; dy: number } | undefined;
      try { went = moveBy(Number(body.dx), Number(body.dy), body.start); } catch { /* it stays where it is */ }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(went ?? {}));
      return;
    }
    try { await post(url.pathname, body); } catch (e) { caption(`Error: ${(e as Error).message}`); }
    res.writeHead(204).end();
    return;
  }
  const file = normalize(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(404).end(); return; }
  let data: Buffer;
  try { data = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data);
});
server.requestTimeout = 0;                          // the pill relay's request stays open for as long as the pill does
await new Promise<void>(ok => {
  server.once('error', () => server.listen(0, '127.0.0.1', ok));
  server.listen(PORT, '127.0.0.1', ok);
});
port = (server.address() as { port: number }).port;

// The files, self and desk servers are built by build.mjs into dist/ and run with this same Node.
const asks = { BLOB_ASK_URL: `http://127.0.0.1:${port}/ask`, BLOB_ASK_TOKEN: askToken };
filesServer = { command: process.execPath, args: [join(DIST, 'files-mcp.mjs')], env: asks };
const selfServer: ServerCommand = {
  command: process.execPath,
  args: [join(DIST, 'self-mcp.mjs')],
  env: { ...asks, BLOB_SELF_URL: `http://127.0.0.1:${port}/self`, BLOB_SELF_TOKEN: selfToken, ...(RELAY && { BLOB_RELAY: RELAY }) },
};
const deskServer: ServerCommand = {
  command: process.execPath, args: [join(DIST, 'desk-mcp.mjs')],
  env: { BLOB_DESK_URL: `http://127.0.0.1:${port}/desk`, BLOB_DESK_TOKEN: deskToken },
};
// Where the pill relay finds Blob: brain.ts hands these to clawdcursor, which passes its own env on to the relay.
process.env.BLOB_PILL_URL = `http://127.0.0.1:${port}/pill`;
process.env.BLOB_PILL_TOKEN = pillToken;
// Blob's web view processes, named to clawdcursor as its own UI in a file that follows them (own-ui.ts).
process.env.BLOB_OWN_UI_FILE = join(tmp, 'own-ui-pids');
const procs = os.processes?.();                     // made once: also names the open apps (computer.ts)
const stopOwnUi = keepOwnUiFile(process.env.BLOB_OWN_UI_FILE, procs);
writeFileSync(mcpConfigPath, mcpConfig({ files: filesServer, blob: selfServer, desk: deskServer }), { mode: 0o600 });
brain = new Brain({
  mcpConfigPath, servers: mcpServers({ files: filesServer, blob: selfServer, desk: deskServer }), cwd: WORK, emit: onBrain,
  persona: (b, tier) => persona(settings.get(), {
    memory: memoryBrief(memoryFile()), computer: computerBrief(computerFile()), scripts: scriptsBrief(scriptsDir()), brain: b, tier,
  }),
  context: computerNow(os.openApps?.(process.pid, procs)),
});
void refreshProfile({ read: os.readProfile });      // this computer's details, in the background, when a day old
sendShortcuts();
sendSettings();

// Watching (learn only): on while the setting is, quiet while Blob itself works. It reads through its own clawdcursor.
watcher = new Watcher({
  file: activityFile(), reader: clawdcursorReader(mcpCaller(filesServer)),
  busy: () => brain.busy || replaying, front: os.frontWindow?.(),
});
if (settings.get().watching) watcher.start();
// The self server writes the settings file after the user's Yes: follow it.
settings.onChange((now, changed) => {
  if (changed.includes('watching')) { if (now.watching) watcher?.start(); else watcher?.stop(); }
  if (changed.includes('startAtLogin')) void applyAutostart(now.startAtLogin);
  if (changed.includes('brain')) void check();      // it may have been installed or signed in since the last look
  sendSettings();
});
settings.watch();

// The phone paired before, if any.
const savedRoom = loadRoom(PAIR);
if (savedRoom) connectPhone(savedRoom, true);
if (settings.get().phonePaired !== !!savedRoom) setPaired(!!savedRoom);

// Reminders and scheduled tasks: a look now (for what came due while Blob was closed), then every 20 s.
checkSchedule();
setInterval(checkSchedule, SCHEDULE_MS).unref();

// ── window ───────────────────────────────────────────────────────────────────
const app = new Application();
const win = app.createBrowserWindow({
  title: 'Blob',
  width: START.w, height: START.h, logical: true,
  transparent: true, decorations: false, alwaysOnTop: true, visibleOnAllWorkspaces: true,
  resizable: false, maximizable: false, minimizable: false,
  windowsUndecoratedShadow: false, macosHasShadow: false,
  visible: false,
});
{
  // Bottom-right of the primary display, above where a taskbar or dock usually sits.
  const m = win.getPrimaryMonitor();
  const s = m?.scaleFactor ?? 1;
  const right = m ? (m.position.x + m.size.width) / s : 1280;
  const bottom = m ? (m.position.y + m.size.height) / s : 800;
  win.setPosition(Math.round(right - START.w - 16), Math.round(bottom - START.h - os.dockGap), true);
}
// The page asks for the size it needs. Keep the bottom-right corner where it is (the user may have dragged the bubble)
// and grow up and left.
// `r` and `b`: the empty room the page keeps right of and under the bubble (its stage). The bubble, not the window's
// corner, is what stays where it is.
let current = { ...START, r: 8, b: 8 };
function resize(w: number, h: number, r: number, b: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  const pad = (v: number) => (Number.isFinite(v) ? Math.round(Math.min(120, Math.max(0, v))) : 8);
  const next = { w: Math.round(Math.min(560, Math.max(200, w))), h: Math.round(Math.min(830, Math.max(200, h))), r: pad(r), b: pad(b) };   // room for a whole command on a Yes card
  if (next.w === current.w && next.h === current.h && next.r === current.r && next.b === current.b) return;
  const p = win.getPosition(true);
  win.setSize(next.w, next.h, true);
  win.setPosition(p.x + (current.w - current.r) - (next.w - next.r), p.y + (current.h - current.b) - (next.h - next.b), true);
  current = next;
}
// The page drags Speak: the window follows the cursor itself (`start`: the press begins), which stays right across
// screens with different scaling. Where the cursor can't be read it follows by the page's own CSS px: whole screen
// pixels are moved; what is left over is carried to the next call, so the bubble never drifts from the pointer.
let carry = { x: 0, y: 0 };
function moveBy(dx: number, dy: number, start: unknown): { dx: number; dy: number } | undefined {
  if (start === 'mouse') dragged.start(); else if (start) dragged.stop();
  const went = dragged.move();
  if (went) return went;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const s = win.scaleFactor() || 1, lim = (v: number) => Math.max(-400, Math.min(400, v));
  const fx = lim(dx) * s + carry.x, fy = lim(dy) * s + carry.y, ix = Math.round(fx), iy = Math.round(fy);
  carry = { x: fx - ix, y: fy - iy };
  if (!ix && !iy) return;
  const p = win.getPosition(false);
  win.setPosition(p.x + ix, p.y + iy, false);
}
// Empty pixels of the bubble's window let clicks through to the desktop (clickthrough.ts); the page is told whether
// they do (it keeps the window small when not) and when the cursor comes onto Blob or leaves it.
const readCursor = cursorReader(win), dragged = follower(win, readCursor);
through = clickThrough(win, { over: on => tell({ type: 'over', on }), gone: () => send({ type: 'stage', clickThrough: false }) }, readCursor);
send({ type: 'stage', clickThrough: through.available });

// WebView2 reads extra browser flags from this variable when the webview is created: grant the page's microphone
// request without a prompt. Removed right after, so nothing claude or clawdcursor starts inherits it.
if (os.id === 'win32') {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream';
}
const webContext = app.createWebContext({ dataDirectory: join(HOME, 'webview') });
const view = win.createWebview({
  url: `http://127.0.0.1:${port}/?t=${token}`,
  transparent: true,
  webContext,
  enableDevtools: !!process.env.BLOB_DEVTOOLS,
  navigationHandler: u => u.startsWith(`http://127.0.0.1:${port}/`),
  newWindowHandler: () => false,
});
// macOS: the Edit menu, the first click, Cmd+Q through quit(), no Dock icon, every Space (mac.ts). Nothing elsewhere.
macSetup(app, quit, { platform: os.id });
// clawdcursor's pill: a second window at the top centre of the primary display, as big as the page says its
// content is, shown only while a relay is connected. Made here so it shares the first webview's browser flags.
const PILL = { w: 320, h: 64 };
const pillWin = app.createBrowserWindow({
  title: 'Blob pill',
  width: PILL.w, height: PILL.h, logical: true,
  transparent: true, decorations: false, alwaysOnTop: true, visibleOnAllWorkspaces: true, focused: false,
  resizable: false, maximizable: false, minimizable: false,
  windowsUndecoratedShadow: false, macosHasShadow: false, windowsSkipTaskbar: true,
  visible: false,
});
function placePill(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  const next = { w: Math.round(Math.min(520, Math.max(120, w))), h: Math.round(Math.min(700, Math.max(40, h))) };
  const m = pillWin.getPrimaryMonitor();
  const s = m?.scaleFactor ?? 1;
  const left = m ? m.position.x / s : 0, width = m ? m.size.width / s : 1280, top = (m ? m.position.y / s : 0) + os.topInset;   // below the menu bar and the notch
  pillWin.setSize(next.w, next.h, true);
  pillWin.setPosition(Math.round(left + (width - next.w) / 2), Math.round(top), true);
}
const pillView = pillWin.createWebview({
  url: `http://127.0.0.1:${port}/pill.html?t=${token}`,
  transparent: true,
  webContext,
  navigationHandler: u => u.startsWith(`http://127.0.0.1:${port}/`),
  newWindowHandler: () => false,
});
delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
view.setBackgroundColor(0, 0, 0, 0);
pillView.setBackgroundColor(0, 0, 0, 0);
placePill(PILL.w, PILL.h);
pillUi = overlay(pillWin);
// The bubble and its cards (a question, the phone's QR code) are for the person at the screen: not in any capture.
// BLOB_CAPTURE=1 (development only): the bubble stays in captures, so a screenshot can check how it looks. Never set
// it otherwise: a question or the phone's QR code would be in every capture too.
if (process.env.BLOB_CAPTURE === '1') console.log('Blob: BLOB_CAPTURE=1, the bubble shows in screen captures (development only)');
else if (!hideFromCapture(win)) console.log('Blob: the bubble shows in screen captures on this system');
win.show();
focus = focusKeeper(win.getNativeHandle());
void check();

// ── exit ─────────────────────────────────────────────────────────────────────
let exiting = false;
function quit(): void {
  if (exiting) return;
  exiting = true;
  brain.stop();
  watcher?.stop();
  stopOwnUi();
  bridge?.stop();
  pairing?.close();
  settings.unwatch();
  focus.stop();
  through?.stop();
  rmSync(tmp, { recursive: true, force: true });
  try { app.exit(); } catch { /* already closed */ }
  process.exit(0);
}
app.on('window-close-requested', quit);
app.on('application-close-requested', quit);
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', () => brain.stop());
app.run();
console.log(`Blob: http://127.0.0.1:${port} (${os.quitHint}, or Ctrl+C here)`);
