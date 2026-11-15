// The host: a 127.0.0.1 server for the built UI and its event stream, the bubble window, the Brain, shortcuts,
// the files server's questions, clawdcursor's pill, focus hand-back, the log file and the first-run check.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Application } from '@webviewjs/webview';
import { Brain, callLabel, mcpConfig, type BrainEvent, type Model, type ServerCommand } from './brain.ts';
import { Questions } from './ask.ts';
import { focusKeeper, type FocusKeeper } from './focus.ts';
import { formatRow, logFileName, type LogBody, type LogRow } from './log.ts';
import { overlay, type Overlay } from './overlay.ts';
import { answerLine, parseCommand, type PillAnswer, type PillState } from './pill.ts';
import { mcpCaller, replay } from './replay.ts';
import { ICONS, MAX_PINNED, MAX_SHORTCUTS } from './shared.ts';
import { loadShortcuts, nameFrom, saveOffer, saveShortcuts, type Shortcut, type Step } from './shortcuts.ts';
import { runChecks } from './setup.ts';

const HOME = join(homedir(), '.blob');
// Blob was called Pronto: move its shortcuts and logs over once
const OLD = join(homedir(), '.pronto');
if (existsSync(OLD) && !existsSync(HOME)) try { renameSync(OLD, HOME); } catch { /* keep the old folder */ }
const WORK = join(HOME, 'work');                     // claude's cwd: empty, and the same every time so --resume finds the session
const LOGS = join(HOME, 'logs');
const SHORTCUTS = join(HOME, 'shortcuts.json');
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

// ── events to the page ───────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();
const history: string[] = [];                     // replayed to a page that (re)connects
function send(e: object): void {
  const data = `data: ${JSON.stringify(e)}\n\n`;
  history.push(data);
  if (history.length > 500) history.shift();
  for (const c of clients) c.write(data);
}

/** A log row: to the page and to today's file. */
function row(r: LogBody): void {
  const full: LogRow = { t: Date.now(), ...r };
  send({ type: 'row', row: full });
  try { mkdirSync(LOGS, { recursive: true }); appendFileSync(join(LOGS, logFileName(full.t)), formatRow(full) + '\n'); } catch { /* the log file is a convenience */ }
}
const caption = (text: string) => send({ type: 'caption', text });
const answer = (text: string) => { caption(text); row({ kind: 'answer', text }); };

// ── state ────────────────────────────────────────────────────────────────────
let brain!: Brain;
let focus: FocusKeeper = { restore() {}, stop() {} };
let filesServer!: ServerCommand;
let request = '';                                   // the current run's request, for the save offer's name
let offer: { name: string; steps: Step[] } | null = null;
let replaying = false;
let shortcuts: Shortcut[] = loadShortcuts(SHORTCUTS);

const questions = new Questions({
  show: (id, question) => send({ type: 'ask', id, question }),
  hide: id => send({ type: 'ask-done', id }),
});

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
  createInterface({ input: req }).on('line', line => {
    if (!mine) {                                    // the first line: what the pill starts as
      let state: PillState | undefined;
      try { state = JSON.parse(line); } catch { /* below */ }
      if (state?.mode !== 'running' && state?.mode !== 'paused') { res.end(); return; }
      pill = mine = { state, res };               // the newest relay wins; an older one is being killed by clawdcursor
      clearTimeout(pillGone);
      clearTimeout(pillBack);
      sendPill();
      pillUi.show();
      if (state.mode === 'paused' && state.sound) pillUi.beep();
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
function setOffer(o: typeof offer, why?: string): void {
  offer = o;
  send({ type: 'offer', offer: o ? { name: o.name } : why ? { why } : null });
}

function onBrain(e: BrainEvent): void {
  if (e.type === 'log') row({ kind: 'call', ...e.entry });
  else if (e.type === 'answer') answer(e.text);
  else if (e.type === 'done') {
    const o = e.ok ? saveOffer(e.calls) : null;
    if (o && 'steps' in o) setOffer({ name: nameFrom(request), steps: o.steps });
    else if (o) setOffer(null, `Can't save this as a shortcut: ${o.why}.`);
  } else if (e.type !== 'session') send(e);
}

async function runShortcut(s: Shortcut): Promise<void> {
  replaying = true;
  send({ type: 'busy', busy: true });
  setOffer(null);
  row({ kind: 'request', text: `Shortcut: ${s.name}` });
  const n = s.steps.length;
  const mcp = mcpCaller(filesServer);
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
    replaying = false;
    send({ type: 'busy', busy: false });
  }
}

async function check(): Promise<void> {
  try { send({ type: 'setup', checks: await runChecks() }); } catch { /* checks are best effort */ }
}

function openMicSettings(): void {
  const o = { windowsHide: true, detached: true, stdio: 'ignore' as const };
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', 'ms-settings:privacy-microphone'], o).unref();
  else if (process.platform === 'darwin') spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], o).unref();
}

const isModel = (m: unknown): m is Model => m === 'sonnet' || m === 'haiku' || m === 'default';
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function post(path: string, body: any): Promise<void> {
  const model = isModel(body.model) ? body.model : 'sonnet';
  switch (path) {
    case '/prewarm': brain.prewarm(model); return;
    case '/cancel': brain.cancel(); return;
    case '/size': resize(Number(body.w), Number(body.h)); return;
    case '/focus-back': focus.restore(); return;
    case '/run': {
      const text = str(body.text);
      if (!text) return;
      focus.restore();
      if (replaying) { caption('A shortcut is still running.'); return; }
      if (brain.run(text, model)) { request = text; setOffer(null); row({ kind: 'request', text }); }
      return;
    }
    case '/answer': questions.answer(str(body.id), body.yes === true); focus.restore(); return;
    case '/offer/dismiss': setOffer(null); focus.restore(); return;
    case '/offer/save': {
      focus.restore();
      if (!offer) return;
      if (shortcuts.length >= MAX_SHORTCUTS) { caption(`You have ${MAX_SHORTCUTS} shortcuts: remove one first (the + blob).`); return; }
      const name = str(body.name).slice(0, 60) || offer.name;
      const icon = (ICONS as readonly string[]).includes(body.icon) ? body.icon : ICONS[0];
      const pinned = shortcuts.filter(s => s.pinned).length < MAX_PINNED;
      store([...shortcuts, { id: randomUUID(), name, icon, pinned, steps: offer.steps }]);
      setOffer(null);
      caption(pinned ? `Saved "${name}" on the bubble.` : `Saved "${name}". Pin it from the + blob.`);
      return;
    }
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
    const asking = url.pathname === '/ask';
    if (asking ? req.headers['x-ask-token'] !== askToken : req.headers['x-talk-token'] !== token) { res.writeHead(403).end(); return; }
    let body: any = {};
    try { let s = ''; for await (const c of req) s += c; body = JSON.parse(s || '{}'); } catch { /* empty body */ }
    if (asking) {
      const question = str(body.question);
      const yes = question ? await questions.ask(question.slice(0, 400)) : false;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ yes }));
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

// The files server is built by build.mjs into dist/ and run with this same Node.
filesServer = {
  command: process.execPath,
  args: [join(DIST, 'files-mcp.mjs')],
  env: { BLOB_ASK_URL: `http://127.0.0.1:${port}/ask`, BLOB_ASK_TOKEN: askToken },
};
// Where the pill relay finds Blob: brain.ts hands these to clawdcursor, which passes its own env on to the relay.
process.env.BLOB_PILL_URL = `http://127.0.0.1:${port}/pill`;
process.env.BLOB_PILL_TOKEN = pillToken;
writeFileSync(mcpConfigPath, mcpConfig(filesServer), { mode: 0o600 });
brain = new Brain({ mcpConfigPath, cwd: WORK, emit: onBrain });
sendShortcuts();

// ── window ───────────────────────────────────────────────────────────────────
const app = new Application();
const win = app.createBrowserWindow({
  title: 'Blob',
  width: START.w, height: START.h, logical: true,
  transparent: true, decorations: false, alwaysOnTop: true,
  resizable: false, maximizable: false, minimizable: false,
  windowsUndecoratedShadow: false,
  visible: false,
});
{
  // Bottom-right of the primary display, above where a taskbar or dock usually sits.
  const m = win.getPrimaryMonitor();
  const s = m?.scaleFactor ?? 1;
  const right = m ? (m.position.x + m.size.width) / s : 1280;
  const bottom = m ? (m.position.y + m.size.height) / s : 800;
  win.setPosition(Math.round(right - START.w - 16), Math.round(bottom - START.h - 56), true);
}
// The page asks for the size it needs. Keep the bottom-right corner where it is (the user may have dragged the bubble)
// and grow up and left.
let current = START;
function resize(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  const next = { w: Math.round(Math.min(480, Math.max(200, w))), h: Math.round(Math.min(600, Math.max(200, h))) };
  if (next.w === current.w && next.h === current.h) return;
  const p = win.getPosition(true);
  win.setSize(next.w, next.h, true);
  win.setPosition(p.x + current.w - next.w, p.y + current.h - next.h, true);
  current = next;
}

// WebView2 reads extra browser flags from this variable when the webview is created: grant the page's microphone
// request without a prompt. Removed right after, so nothing claude or clawdcursor starts inherits it.
if (process.platform === 'win32') {
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
// clawdcursor's pill: a second window at the top centre of the primary display, as big as the page says its
// content is, shown only while a relay is connected. Made here so it shares the first webview's browser flags.
const PILL = { w: 320, h: 64 };
const pillWin = app.createBrowserWindow({
  title: 'Blob pill',
  width: PILL.w, height: PILL.h, logical: true,
  transparent: true, decorations: false, alwaysOnTop: true, focused: false,
  resizable: false, maximizable: false, minimizable: false,
  windowsUndecoratedShadow: false, windowsSkipTaskbar: true,
  visible: false,
});
function placePill(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  const next = { w: Math.round(Math.min(520, Math.max(120, w))), h: Math.round(Math.min(700, Math.max(40, h))) };
  const m = pillWin.getPrimaryMonitor();
  const s = m?.scaleFactor ?? 1;
  const left = m ? m.position.x / s : 0, width = m ? m.size.width / s : 1280, top = m ? m.position.y / s : 0;
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
win.show();
focus = focusKeeper(win.getNativeHandle());
void check();

// ── exit ─────────────────────────────────────────────────────────────────────
let exiting = false;
function quit(): void {
  if (exiting) return;
  exiting = true;
  brain.stop();
  focus.stop();
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
console.log(`Blob: http://127.0.0.1:${port} (close the bubble from the taskbar, or Ctrl+C here)`);
