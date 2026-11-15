// The host: a 127.0.0.1 server for the built UI and its event stream, the bubble window, and the Brain.
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { Application } from '@webviewjs/webview';
import { Brain, mcpConfig, type Model } from './brain.ts';

const HOME = join(homedir(), '.clawdcursor-talk');
const WORK = join(HOME, 'work');                     // claude's cwd: empty, and the same every time so --resume finds the session
const DIST = resolve(import.meta.dirname, '..', 'dist');
// A fixed port keeps the page's origin, and so the cached Whisper model, the same across starts; any free port if taken.
const PORT = 47615;
const SIZE = { closed: { w: 320, h: 230 }, open: { w: 360, h: 440 } };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

mkdirSync(WORK, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'clawdcursor-talk-'));
const mcpConfigPath = join(tmp, 'mcp.json');
writeFileSync(mcpConfigPath, mcpConfig(), { mode: 0o600 });
const token = randomBytes(24).toString('hex');

// ── events to the page ───────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();
const history: string[] = [];                     // replayed to a page that (re)connects
function send(e: object): void {
  const data = `data: ${JSON.stringify(e)}\n\n`;
  history.push(data);
  if (history.length > 500) history.shift();
  for (const c of clients) c.write(data);
}

const brain = new Brain({ mcpConfigPath, cwd: WORK, emit: send });
const isModel = (m: unknown): m is Model => m === 'sonnet' || m === 'haiku' || m === 'default';

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
  if (req.method === 'POST') {
    if (req.headers['x-talk-token'] !== token) { res.writeHead(403).end(); return; }
    let body: any = {};
    try { let s = ''; for await (const c of req) s += c; body = JSON.parse(s || '{}'); } catch { /* empty body */ }
    const model = isModel(body.model) ? body.model : 'sonnet';
    if (url.pathname === '/prewarm') brain.prewarm(model);
    else if (url.pathname === '/cancel') brain.cancel();
    else if (url.pathname === '/run' && typeof body.text === 'string' && body.text.trim()) {
      if (brain.run(body.text.trim(), model)) send({ type: 'request', text: body.text.trim() });
    } else if (url.pathname === '/size') resize(body.open === true);
    res.writeHead(204).end();
    return;
  }
  const file = normalize(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(404).end(); return; }
  let data: Buffer;
  try { data = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data);
});
await new Promise<void>(ok => {
  server.once('error', () => server.listen(0, '127.0.0.1', ok));
  server.listen(PORT, '127.0.0.1', ok);
});
port = (server.address() as { port: number }).port;

// ── window ───────────────────────────────────────────────────────────────────
const app = new Application();
const win = app.createBrowserWindow({
  title: 'clawdcursor talk',
  width: SIZE.closed.w, height: SIZE.closed.h, logical: true,
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
  win.setPosition(Math.round(right - SIZE.closed.w - 16), Math.round(bottom - SIZE.closed.h - 56), true);
}
// Keep the bottom-right corner where it is (the user may have dragged the bubble) and grow up and left.
let current = SIZE.closed;
function resize(open: boolean): void {
  const next = open ? SIZE.open : SIZE.closed;
  if (next === current) return;
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
  enableDevtools: !!process.env.CLAWD_TALK_DEVTOOLS,
  navigationHandler: u => u.startsWith(`http://127.0.0.1:${port}/`),
  newWindowHandler: () => false,
});
delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
view.setBackgroundColor(0, 0, 0, 0);
win.show();

// ── exit ─────────────────────────────────────────────────────────────────────
let exiting = false;
function quit(): void {
  if (exiting) return;
  exiting = true;
  brain.stop();
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
console.log(`clawdcursor talk: http://127.0.0.1:${port} (close the bubble from the taskbar, or Ctrl+C here)`);
