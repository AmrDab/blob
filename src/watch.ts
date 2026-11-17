// Watching = learn only. Blob notes which app, window title and (for a browser) which site is in front, in
// ~/.blob/activity.jsonl, for 14 days. No screenshots, no page text, no model: two read-only clawdcursor calls when the
// window in front changes, and nothing while Blob itself is doing a task. It all stays on this computer.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Caller } from './replay.ts';
import { blobHome } from './settings.ts';

export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Entry { t: number; app: string; title: string; host?: string }
export interface Front { app: string; title: string; pid: number }
/** What the watcher reads the window in front with. Every call is a read: nothing is clicked, typed or moved. */
export interface Reader {
  active(): Promise<Front | null>;
  /** The text of a browser's address bar, or null when it can't be read. */
  addressBar(pid: number): Promise<string | null>;
  close(): Promise<void>;
}

export const activityFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'activity.jsonl');

// Browsers whose address bar has this accessibility name (English UI). Others are noted by app and title only.
const BROWSER = /chrome|msedge|edge|brave|vivaldi|opera|chromium/i;
const ADDRESS_BAR = 'Address and search bar';
// A private window is not noted at all (best effort: by the words browsers put in its title).
const PRIVATE = /InPrivate|Incognito|Private Browsing/i;

/** The site of an address-bar value: "https://mail.example.com/inbox?x=1" -> "mail.example.com". Never the path. */
export function hostOf(value: string | null | undefined): string | undefined {
  const v = value?.trim() ?? '';
  if (!v || /\s/.test(v)) return undefined;          // a search being typed, not an address
  let host: string;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase(); } catch { return undefined; }
  return host.includes('.') || host === 'localhost' ? host.replace(/^www\./, '') : undefined;
}

/** The JSON object in a clawdcursor result (it may sit between other lines). */
function jsonIn(text: string): Record<string, unknown> | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * The reader over clawdcursor's MCP server (replay.ts's mcpCaller). It makes exactly two calls, both reads that
 * clawdcursor rates safetyTier 0, so its pill and outline never show:
 *   window {action:"active"}                             -> app, title, process id
 *   accessibility {action:"get_value", name, processId}  -> the address bar's text
 */
export function clawdcursorReader(mcp: { call: Caller; close: () => Promise<void> }): Reader {
  const read = async (tool: string, args: Record<string, unknown>) => {
    const r = await mcp.call({ server: 'clawdcursor', tool, args });
    return r.isError ? null : jsonIn(r.text);
  };
  return {
    async active() {
      const w = await read('window', { action: 'active' });
      const app = w && (typeof w.appName === 'string' && w.appName ? w.appName : w.processName);
      if (!w || typeof app !== 'string' || !app || typeof w.processId !== 'number') return null;
      return { app, title: typeof w.title === 'string' ? w.title : '', pid: w.processId };
    },
    async addressBar(pid) {
      const v = await read('accessibility', { action: 'get_value', name: ADDRESS_BAR, processId: pid });
      return v && v.readable !== false && typeof v.value === 'string' ? v.value : null;
    },
    close: () => mcp.close(),
  };
}

/** Windows (os.frontWindow): a cheap look at the window in front (user32, as focus.ts does). null: nothing, or one of Blob's own. */
export function windowsFront(): (() => string | null) | undefined {
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll');
    const foreground = user32.func('intptr_t __stdcall GetForegroundWindow()');
    const text = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int max)');
    const owner = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
    const buf = Buffer.alloc(1024);
    return () => {
      const h = foreground();
      if (!h) return null;
      const pid = [0];
      owner(h, pid);
      if (pid[0] === process.pid) return null;
      const n = text(h, buf, buf.length / 2);
      return `${h}|${buf.toString('utf16le', 0, Math.max(0, n) * 2)}`;
    };
  } catch { return undefined; }
}

export function loadActivity(file: string): Entry[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.t === 'number' && typeof e.app === 'string') out.push(e);
    } catch { /* an empty or half-written line */ }
  }
  return out;
}

/** Drops what is older than 14 days. */
export function prune(file: string, now: number = Date.now()): void {
  const all = loadActivity(file);
  const keep = all.filter(e => e.t >= now - KEEP_MS);
  if (keep.length === all.length) return;
  writeFileSync(file + '.tmp', keep.map(e => JSON.stringify(e) + '\n').join(''));
  renameSync(file + '.tmp', file);
}

/** The short summary the model may see: the apps and sites most often in front. Titles stay on disk. */
export function topActivity(file: string, max = 5, now: number = Date.now()): { apps: string[]; sites: string[] } {
  const apps = new Map<string, number>(), sites = new Map<string, number>();
  for (const e of loadActivity(file)) {
    if (e.t < now - KEEP_MS) continue;
    apps.set(e.app, (apps.get(e.app) ?? 0) + 1);
    if (e.host) sites.set(e.host, (sites.get(e.host) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, max).map(([name, n]) => `${name} (${n}×)`);
  return { apps: top(apps), sites: top(sites) };
}

export interface WatchOptions {
  file: string;
  reader: Reader;
  /** True while Blob is doing a task (a run or a shortcut): the watcher does nothing then. */
  busy: () => boolean;
  /**
   * A cheap key for the window in front (windowsFront). Without one (macOS, Linux) the watcher asks the reader
   * itself on every look, so it looks less often.
   */
  front?: () => string | null;
  intervalMs?: number;
  ownPid?: number;
  now?: () => number;
}

export class Watcher {
  private timer?: ReturnType<typeof setInterval>;
  private seen?: string;        // the last window that was read
  private pending?: string;     // a new window, seen once: read when it is still in front at the next look
  private last?: Entry;
  private pruned = 0;
  private reading = false;

  constructor(private o: WatchOptions) {}

  get running(): boolean { return !!this.timer; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.look(), this.o.intervalMs ?? (this.o.front ? 1500 : 5000));
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.seen = this.pending = undefined;
    void this.o.reader.close().catch(() => {});
  }

  /** One look at the window in front. A change is read only once it has stayed for two looks in a row. */
  async look(): Promise<void> {
    if (this.reading) return;
    if (this.o.busy()) { this.pending = undefined; return; }
    this.reading = true;
    try {
      let w: Front | null = null;
      const key = this.o.front ? this.o.front() : (w = await this.o.reader.active()) && `${w.pid}|${w.title}`;
      if (!key || key === this.seen) { this.pending = undefined; return; }
      if (key !== this.pending) { this.pending = key; return; }
      this.pending = undefined;
      this.seen = key;
      w ??= await this.o.reader.active();
      if (!w || w.pid === (this.o.ownPid ?? process.pid) || PRIVATE.test(w.title)) return;
      const host = BROWSER.test(w.app) ? hostOf(await this.o.reader.addressBar(w.pid)) : undefined;
      if (this.o.busy()) return;                      // a task started meanwhile: what is in front is Blob's doing
      this.note({ app: w.app, title: w.title.slice(0, 200), ...(host && { host }) });
    } catch {
      await this.o.reader.close().catch(() => {});    // clawdcursor went away: connect again at the next change
    } finally {
      this.reading = false;
    }
  }

  private note(e: Omit<Entry, 't'>): void {
    if (this.last && this.last.app === e.app && this.last.title === e.title && this.last.host === e.host) return;
    const now = (this.o.now ?? Date.now)();
    this.last = { t: now, ...e };
    mkdirSync(dirname(this.o.file), { recursive: true });
    if (now - this.pruned > DAY_MS) { this.pruned = now; prune(this.o.file, now); }
    appendFileSync(this.o.file, JSON.stringify(this.last) + '\n');
  }
}

/** Deletes everything the watcher has noted. */
export function forgetActivity(file: string): void {
  rmSync(file, { force: true });
}
