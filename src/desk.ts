// Blob's desk: working an open window in the background, through its controls (Windows UI Automation), with no
// pointer, no keyboard and no window raised. One bridge (desk-bridge.ps1) runs under Blob's main process for as long
// as Blob does, so the control ids outlive a request and a hand-off to a stronger model. Here: the bridge's process,
// and the model's three tools (read, act, open) with their checks, their Yes card and their words.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from './files-mcp.ts';

// ── the bridge process ───────────────────────────────────────────────────────

/** What the bridge needs of a child process (node's, or a test's). */
export interface Child {
  pid?: number;
  stdin: { write(s: string): unknown; on(e: 'error', f: () => void): unknown };
  stdout: { setEncoding(e: 'utf8'): unknown; on(e: 'data', f: (d: string) => void): unknown };
  on(e: 'exit' | 'error', f: (...a: any[]) => void): unknown;
}
type Spawn = (command: string, args: string[], o: { windowsHide: true; cwd: string; stdio: ['pipe', 'pipe', 'ignore'] }) => Child;

const READY_MS = 15_000, CALL_MS = 15_000, OPEN_MS = 20_000;   // `open` waits up to 5 s for the app's window
/** Why every call fails once the bridge could not start twice in a row. */
export const DOWN = "background control isn't available on this PC";

/**
 * The one long-lived PowerShell. One JSON line in, one out; calls go one at a time and replies are matched by order,
 * so a call that times out kills the process (a late reply would answer the wrong call) and the next call starts a
 * new one. Two starts that fail in a row: it stays down until Blob restarts.
 */
export class Bridge {
  private child?: Child;
  private drop?: (why: string, exited?: boolean) => void;   // ends the child that is running
  private wait?: { resolve: (v: any) => void; reject: (e: Error) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private fails = 0;

  constructor(private o: { spawn: Spawn; kill: (pid: number) => void; script: string }) {}

  /** `{error}` rejects; `{ok:true,…}` and `{ok:false,code,…}` resolve. */
  call(cmd: { cmd: string } & Record<string, unknown>): Promise<any> {
    const p = this.queue.then(() => this.one(cmd));
    this.queue = p.catch(() => {});
    return p;
  }

  /** Kills the process and what it started. */
  stop(): void { this.drop?.('Blob is closing'); }

  private async one(cmd: { cmd: string }): Promise<any> {
    if (this.fails >= 2) throw new Error(DOWN);
    const c = this.child ?? await this.start();
    return new Promise((resolve, reject) => {
      const ms = cmd.cmd === 'open' ? OPEN_MS : CALL_MS;
      const timer = setTimeout(() => this.drop?.(`no answer in ${ms / 1000} s`), ms);
      this.wait = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } };
      c.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  private start(): Promise<Child> {
    return new Promise((resolve, reject) => {
      const c = this.o.spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.o.script],
        { windowsHide: true, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] },
      );
      this.child = c;
      let ready = false, buf = '';
      const drop = this.drop = (why, exited = false) => {
        if (this.child !== c) return;
        this.child = this.drop = undefined;
        clearTimeout(timer);
        if (!exited && c.pid !== undefined) this.o.kill(c.pid);
        if (!ready) reject(new Error(++this.fails >= 2 ? DOWN : `it did not start (${why})`));
        const w = this.wait;
        this.wait = undefined;
        w?.reject(new Error(why));
      };
      const timer = setTimeout(() => drop(`not ready in ${READY_MS / 1000} s`), READY_MS);
      c.on('error', e => drop(String(e?.message ?? e), true));
      c.on('exit', () => drop('the background helper stopped', true));
      c.stdin.on('error', () => { /* it exited: the exit handler says so */ });
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (this.child !== c || !line) continue;   // a line from a process that was given up on answers nothing
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }
          if (!ready) {                              // the first line: {"ready":true}, or why not (Add-Type failed)
            if (m?.ready) { ready = true; this.fails = 0; clearTimeout(timer); resolve(c); }
            else if (m?.error) drop(String(m.error));
            continue;
          }
          const w = this.wait;
          this.wait = undefined;
          if (m?.error !== undefined && m.ok === undefined) w?.reject(new Error(String(m.error)));
          else w?.resolve(m);
        }
      });
    });
  }
}

// ── who is never worked ──────────────────────────────────────────────────────

/** Blob's own processes: this one, and its web view's (own-ui.ts keeps their ids in `file`). Read again at every call. */
export function ownPids(file: string | undefined, read: (path: string) => string = p => readFileSync(p, 'utf8')): Set<number> {
  const own = new Set([process.pid]);
  if (!file) return own;
  try {
    for (const s of read(file).split(',')) { const n = Number(s); if (Number.isInteger(n) && n > 0) own.add(n); }
  } catch { /* not written yet */ }
  return own;
}

/** Apps that host an AI assistant, by process name (clawdcursor's list, src/core/ai-hosts.ts): the `claude` or `codex` Blob runs is one. */
export const AI_HOSTS: readonly string[] = [
  'claude', 'claude-desktop', 'chatgpt', 'codex', 'cursor', 'code', 'code-insiders', 'code - insiders', 'windsurf', 'zed', 'zeditor', 'zed-editor',
];
/** Lower case, without a path, ".exe" or ".app". */
export const normalize = (name: string) => (name.replace(/\\/g, '/').split('/').pop() ?? name).replace(/\.(exe|app)$/i, '').toLowerCase();
export const isAiHost = (app: string): boolean => AI_HOSTS.includes(normalize(app));

// ── the tools ────────────────────────────────────────────────────────────────

interface Win { hwnd: number; title: string; pid: number; app: string; cls: string; minimized: boolean; elevated: boolean; hung: boolean }
interface Node {
  id: string; depth: number; parent: string; role: string; name: string; value?: string; actions: string[]; state?: string;
  enabled: boolean; offscreen: boolean; password: boolean; focused: boolean; pid: number; help: string; aid: string;
}
/** What Blob keeps of a control it listed: `pid` is the control's process, `wpid` its window's (a Store app's own, not its frame's). */
export interface Meta {
  hwnd: number; pid: number; wpid: number; app: string; elevated: boolean; role: string; name: string; value?: string; help: string; aid: string;
  actions: string[]; enabled: boolean; password: boolean; focused: boolean; windowTitle: string;
  windowText: string;        // what the window's first Text nodes say: a box's question
}
export interface Step { element: string; action: string; value?: unknown; consequential?: unknown }

const MAX_KNOWN = 2000;      // as many ids as the bridge keeps
const MAX_WINDOWS = 60, MAX_LINES = 300, MAX_FOUND = 50;
const line = (kind: string, code: string, hint: string) => `[${kind} · ${code} · hint: ${hint}]`;
const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: line('failed', code, hint), isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: line('refused', code, hint), isError: true });
const unverified = (hint: string) => `[unverified · hint: ${hint}]`;
const GONE = unverified('the request ended; the rest was not done');
/** An app's own text on one line, cut to fit. */
const flat = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

/** A press whose name says it sends, deletes, pays, posts or installs: it asks first, because nobody sees a background press. */
export const CONSEQUENTIAL = /\b(sends?|delet(?:e|ing)|remove|trash|empty|erase|discard|don[’'‘ʼ]?t save|do not save|without saving|pay|buy|purchase|order|checkout|check out|subscribe|unsubscribe|submit|confirm|post|publish|share|forward|transfer|approve|accept|agree|allow|install|uninstall|run anyway|reset|restart|shut down|end task|clear (?:all|history|data|browsing data)|format|overwrite|replace|sign out|sign off|log out|log off)\b/i;
/** A button that says nothing by itself: what it does is in its window's title, or in the box's own text. */
export const GENERIC = /^(yes|no|ok|okay|continue|proceed|accept|allow|next|finish|done|apply|got it)$/i;
/** A box whose Yes, No or OK loses something, though no word above is in it. */
const LOSES = /save changes|unsaved|permanently|can(?:no|[’'])t be undone/i;
/** A press on a file that runs (an item in a folder window). */
const RUNS = /\.(exe|msi|msix|appx|bat|cmd|ps1|vbs|js|scr|lnk)$|\bsetup\b/i;
const ASKS: Record<string, string> = { toggle: 'Switch', select: 'Select', expand: 'Open' };
const DID: Record<string, string> = { press: 'Pressed', set: 'Set', toggle: 'Switched', select: 'Selected', expand: 'Expanded', collapse: 'Collapsed' };

/** Blob itself, an AI assistant, or an app run as administrator: `w` is the window, `pid` a control's own process. */
function barred(w: { pid: number; app: string; elevated: boolean }, own: Set<number>, pid?: number): ToolResult | null {
  if (own.has(w.pid) || (pid !== undefined && own.has(pid))) return refused('OWN_UI', 'that is Blob itself');
  if (isAiHost(w.app)) return refused('AI_HOST', "Blob never works an AI assistant's window");
  if (w.elevated) return refused('ELEVATED', "it runs as administrator; Blob can't control it, tell the user");
  return null;
}

/** Why a step can't run, from what was read; null when it can. Nothing of a batch runs unless every step passes. */
export function refusal(step: Step, m: Meta | undefined, own: Set<number>): ToolResult | null {
  if (!m) return failed('STALE', 'read the window again');
  const no = barred({ pid: m.wpid, app: m.app, elevated: m.elevated }, own, m.pid);
  if (no) return no;
  if (m.password) return refused('PASSWORD', 'the user types passwords themselves');
  if (!m.enabled) return failed('DISABLED', `${step.element} is disabled now`);
  if (!m.actions.includes(step.action)) return failed('NO_PATTERN', `${step.element} can only ${m.actions.join(', ') || 'be read'}; if none fits, use the screen tools`);
  if (step.action === 'set' && typeof step.value !== 'string') return failed('NO_PATTERN', 'set needs a value');
  return null;
}

/**
 * The Yes card a step needs, or null. A press asks when the model marked it, when it opens a link or a file that
 * runs, when its name, tooltip or id says what it does, or when it is a bare OK, Yes or No in a window whose title
 * or text does. A toggle and a select ask when marked or by their name, tooltip or id; an expand only when marked.
 * A set asks when it would replace text in the field the user is in. `fg`: the window in front. The words are
 * Blob's; the app's are cut short.
 */
export function needsYes(step: Step, m: Meta, fg?: number): { question: string; detail?: string } | null {
  const name = flat(m.name, 60), app = flat(m.app, 60);
  if (step.action === 'set') return fg === m.hwnd && m.focused ? { question: `Replace what's in "${name || m.role}" in ${app}?` } : null;
  if (step.action === 'collapse') return null;
  const press = step.action === 'press';
  if (press && m.role === 'Hyperlink') return { question: `Open the link "${name}" in ${app}?`, ...(m.value && { detail: flat(m.value, 600) }) };
  const question = `${ASKS[step.action] ?? 'Press'} "${name || m.role}" in ${app}?`;
  // deleteButton: delete Button; SENDButton: SEND Button; delete2: delete 2
  const words = m.aid.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/[_.-]+/g, ' ');
  const says = CONSEQUENTIAL.test(m.name) || CONSEQUENTIAL.test(m.help) || CONSEQUENTIAL.test(words);
  if (step.consequential === true || (says && step.action !== 'expand') || (press && RUNS.test(m.name.trim()))) return { question };
  const box = `${m.windowTitle} ${m.windowText}`;
  if (press && (!m.name.trim() || GENERIC.test(m.name.trim())) && (CONSEQUENTIAL.test(box) || LOSES.test(box))) return { question, detail: flat(box, 200) };
  return null;
}

const windowLine = (w: Win) =>
  `w${w.hwnd} ${flat(w.app, 60)} "${flat(w.title, 120)}"${w.minimized ? ' minimized' : ''}${w.elevated ? ' admin' : ''}${w.hung ? ' not responding' : ''}`;
const windowList = (ws: Win[]) => (!ws.length ? 'No windows are open.'
  : ws.slice(0, MAX_WINDOWS).map(windowLine).join('\n') + (ws.length > MAX_WINDOWS ? `\n… ${ws.length - MAX_WINDOWS} more` : ''));
const nodeLine = (n: Node) =>
  `${n.id} ${n.role}${n.name.trim() ? ` "${flat(n.name, 120)}"` : ''}${!n.password && n.value !== undefined ? ` = "${flat(n.value, 120)}"` : ''}` +
  `${n.state ? ` ${n.state}` : ''}${n.actions.length ? ` (${n.actions.join(', ')})` : ''}` +
  `${n.enabled ? '' : ' disabled'}${n.password ? ' password' : ''}${n.offscreen ? ' offscreen' : ''}${n.focused ? ' focused' : ''}`;
const STATE: Record<string, string> = { On: 'on', Off: 'off', Indeterminate: 'mixed' };

export function deskTools(deps: {
  bridge: { call(cmd: { cmd: string } & Record<string, unknown>): Promise<any> };
  ask: (question: string, detail?: string) => Promise<boolean>;
  own: () => Set<number>;
  log: (s: string) => void;
}) {
  const known = new Map<string, Meta>();
  let top = 0;               // the highest id seen: a bridge that was started again goes on from it, so no id comes twice
  /** The bridge's reply, or `{ lost }` when it rejected, timed out or died. */
  const call = (cmd: { cmd: string } & Record<string, unknown>): Promise<any> =>
    deps.bridge.call(cmd).catch(e => ({ lost: String((e as Error)?.message ?? e) }));
  const lost = (r: any): ToolResult | null => (typeof r?.lost !== 'string' ? null
    : r.lost === DOWN ? failed('BRIDGE', `${DOWN}; use the screen tools`) : failed(`BRIDGE · ${flat(r.lost, 200)}`, 'use the screen tools'));
  const windows = async (): Promise<{ list: Win[]; fg?: number } | ToolResult> => {
    const r = await call({ cmd: 'windows' });
    return lost(r) ?? { list: Array.isArray(r.windows) ? r.windows : [], fg: r.fg };
  };

  /** One step, already checked: its line, and the outcome line that stops the batch ('' when it confirmed). */
  async function one(s: Step, m: Meta, gone?: () => boolean): Promise<[string, string]> {
    let fg: number | undefined;
    if (s.action === 'set' && m.focused) { const ws = await windows(); if ('list' in ws) fg = ws.fg; }
    const yes = needsYes(s, m, fg);
    if (yes && !(await deps.ask(yes.question, yes.detail))) return ['', line('refused', 'USER_SAID_NO', 'the user said No; leave it')];
    if (gone?.()) return ['', GONE];                   // it ended while the card was up
    const r = await call({ cmd: 'act', el: s.element, action: s.action, ...(s.action === 'set' && { value: s.value }), expectName: m.name, expectRole: m.role });
    const down = lost(r);
    if (down) return ['', down.text];
    const name = `"${flat(m.name, 60) || m.role}"`;
    let say = '', stop = '';
    if (!r.ok) {
      stop = r.code === 'NOT_RESPONDING' ? line('failed', 'NOT_RESPONDING', 'the app is not responding; tell the user')
        : r.code === 'NOT_IN_BACKGROUND' ? line('failed', 'NOT_IN_BACKGROUND', s.action === 'set' ? 'this field takes typing only; use the screen tools'
          : s.action === 'expand' || s.action === 'collapse' ? 'this menu opens only in front; use the screen tools' : 'this control works only in front; use the screen tools')
        : r.code === 'CANT_PRESS' ? line('failed', 'CANT_PRESS', `${flat(String(r.message ?? 'the app refused it'), 200)}; read the window again, or use the screen tools`)
        : line('failed', 'STALE', 'read the window again');
    } else if (r.pending) {
      say = `${DID[s.action]} ${name}; the app is still busy (a box may have opened).`;
      stop = unverified('read with no arguments to see what opened');
    } else if (s.action === 'press') {
      const now = Array.isArray(r.changed) && r.changed.length ? ` Now: ${r.changed.map((c: unknown) => flat(String(c), 120)).join('; ')}.` : '';
      const opened = (Array.isArray(r.opened) ? r.opened : []).map((w: Win) => ` A window "${flat(String(w.title), 60)}" opened: w${w.hwnd}.`).join('');
      say = `Pressed ${name}.${now}${opened}`;
      if (!now && !opened && !r.gone && !r.closed) stop = unverified('nothing visible changed; read the window to check');
    } else if (s.action === 'set') {
      const after = String(r.after ?? '');
      if (after === s.value) say = `Set ${name} to "${flat(after, 120)}".`;
      else if (after === String(r.before ?? '')) stop = line('failed', 'DID_NOTHING', `it still reads "${flat(after, 120)}"; use the screen tools`);
      else stop = unverified(`it now reads "${flat(after, 120)}"`);
    } else if (s.action === 'toggle') {
      const state = STATE[r.after] ?? String(r.after);
      if (r.after !== r.before) say = `${name} is now ${state}.`;
      else stop = line('failed', 'DID_NOTHING', `it is still ${state}; use the screen tools`);
    } else if (s.action === 'select') {
      if (r.selected) say = `Selected ${name}.`;
      else stop = line('failed', 'DID_NOTHING', 'it is still not selected; use the screen tools');
    } else {                                           // expand, collapse
      if ((r.after !== 'Collapsed') === (s.action === 'expand')) say = `${s.action === 'expand' ? 'Expanded' : 'Collapsed'} ${name}.`;
      else stop = line('failed', 'NOT_IN_BACKGROUND', 'this menu opens only in front; use the screen tools');
    }
    // The desk never takes the front or the pointer, but the app's own code might: the user is told when it did.
    if (r.cursorMoved) deps.log('Blob: the pointer moved during a desk act');
    if (r.fgChanged) {
      deps.log('Blob: desk act changed the window in front');
      if (!/^\[(failed|refused)/.test(stop)) stop = unverified('another window came to the front during this step');
    }
    if (r.lateError) say = `(An earlier press failed: ${flat(String(r.lateError), 200)}.)${say && ' '}${say}`;
    return [say, stop];
  }

  return {
    /** The open windows; one window's controls (all, or those matching `find`); or one control's whole text. */
    async read(a: { window?: unknown; app?: unknown; find?: unknown; element?: unknown }): Promise<ToolResult> {
      const own = deps.own();
      if (typeof a.element === 'string' && a.element.trim()) {
        const id = a.element.trim(), m = known.get(id);
        if (!m) return failed('STALE', 'read the window again');
        const no = barred({ pid: m.wpid, app: m.app, elevated: m.elevated }, own, m.pid);
        if (no) return no;
        if (m.password) return refused('PASSWORD', 'Blob never reads passwords');
        const r = await call({ cmd: 'value', el: id });
        return lost(r) ?? (r.ok ? ok(String(r.value ?? '') || '(empty)')   // the app's text, then Blob's own line: the last line is never the app's
          : r.code === 'PASSWORD' ? refused('PASSWORD', 'Blob never reads passwords') : failed('STALE', 'read the window again'));
      }
      const ws = await windows();
      if (!('list' in ws)) return ws;
      const shown = ws.list.filter(w => !own.has(w.pid) && !isAiHost(w.app));
      let w: Win | undefined;
      if (typeof a.window === 'string' && a.window.trim()) {
        const id = a.window.trim();
        w = ws.list.find(x => `w${x.hwnd}` === id);
        if (!w) return failed('STALE', 'that window is gone; read with no arguments');
      } else if (typeof a.app === 'string' && a.app.trim()) {
        const q = a.app.trim().toLowerCase();
        const hits = shown.filter(x => x.app.toLowerCase().includes(q) || x.title.toLowerCase().includes(q));
        if (!hits.length) return failed('STALE', `no open window matches "${flat(a.app, 60)}"; open it, or read with no arguments`);
        if (hits.length > 1) return { text: windowList(hits), isError: false };
        w = hits[0];
      } else return { text: windowList(shown), isError: false };

      const no = barred(w, own);
      if (no) return no;
      if (w.hung) return failed('NOT_RESPONDING', 'the app is not responding; tell the user');
      const find = typeof a.find === 'string' ? a.find.trim() : '';
      const r = await call({ cmd: 'read', hwnd: w.hwnd, ...(find && { find }), ...(top && { from: top }) });
      const down = lost(r);
      if (down) return down;
      if (!r.ok) return r.code === 'NOT_RESPONDING' ? failed('NOT_RESPONDING', 'the app is not responding; tell the user') : failed('STALE', 'that window is gone; read with no arguments');
      const nodes: Node[] = Array.isArray(r.nodes) ? r.nodes : [];
      const windowText = flat(String(r.text ?? ''), 300);
      for (const n of nodes) {
        top = Math.max(top, Number(n.id.slice(1)) || 0);
        known.set(n.id, {
          hwnd: w.hwnd, pid: n.pid, wpid: w.pid, app: w.app, elevated: w.elevated, role: n.role, name: n.name, value: n.value, help: n.help, aid: n.aid,
          actions: n.actions, enabled: n.enabled, password: n.password, focused: n.focused, windowTitle: w.title, windowText,
        });
        if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);   // the oldest, as the bridge drops it
      }
      const out = [windowLine(w)];
      if (find) {
        if (!nodes.length) out.push(`Nothing in it matches "${flat(find, 60)}".`);
        for (const n of nodes.slice(0, MAX_FOUND)) out.push(`${nodeLine(n)}${n.parent.trim() ? ` in "${flat(n.parent, 60)}"` : ''}`);
        if (nodes.length > MAX_FOUND) out.push(`… ${nodes.length - MAX_FOUND} more`);
      } else {
        if (!nodes.length) return failed('EMPTY', 'this window shows nothing to the background tools (a minimized Store app sleeps); use the screen tools');
        for (const n of nodes.slice(0, MAX_LINES)) out.push(`${'  '.repeat(n.depth + 1)}${nodeLine(n)}`);
        if (nodes.length > MAX_LINES) out.push(`… ${nodes.length - MAX_LINES} more; pass find to narrow`);
      }
      if (r.truncated) out.push('(partial: the window is large; pass find)');
      if (r.noDocument) out.push(line('failed', 'EMPTY', "the page isn't showing while the window is covered or minimized; its tabs and toolbar are above; for the page use the screen tools"));
      return { text: out.join('\n'), isError: !!r.noDocument };
    },

    /**
     * 1 to 10 presses, sets, toggles, selects, expands or collapses, in order; it stops at the first that does not
     * confirm, and when `gone` says the request ended (Stop, or the model's process closed): nobody is waiting.
     */
    async act(a: { steps?: unknown }, gone?: () => boolean): Promise<ToolResult> {
      const steps = (Array.isArray(a.steps) ? a.steps : []).map((s): Step => ({ ...s, element: String(s?.element ?? '').trim(), action: String(s?.action ?? '') }));
      if (!steps.length || steps.length > 10) return failed('NO_PATTERN', 'pass 1 to 10 steps');
      const own = deps.own();
      for (const s of steps) { const no = refusal(s, known.get(s.element), own); if (no) return no; }
      const said: string[] = [];
      let end = '';
      for (const s of steps) {
        if (gone?.()) { end = GONE; break; }
        const [say, stop] = await one(s, known.get(s.element)!, gone);
        if (say) said.push(say);
        if (stop) { end = stop; break; }
      }
      return { text: [...said, end || '[confirmed]'].join('\n'), isError: /^\[(failed|refused)/.test(end) };
    },

    /** Starts an app from the Start menu by its name. */
    async open(a: { app?: unknown }): Promise<ToolResult> {
      const name = typeof a.app === 'string' ? a.app.trim() : '';
      const r = name ? await call({ cmd: 'open', name }) : { ok: false, code: 'NOT_FOUND' };
      const down = lost(r);
      if (down) return down;
      if (r.ok) {
        const app = flat(String(r.app), 60);
        return r.window ? ok(`Opened ${app}: w${r.window.hwnd} "${flat(String(r.window.title), 120)}".`)
          : { text: `Opened ${app}.\n${unverified('read with app to find its window')}`, isError: false };
      }
      const names = (Array.isArray(r.names) ? r.names : []).map((n: unknown) => flat(String(n), 60)).join(', ');
      if (r.code === 'AMBIGUOUS') return failed('AMBIGUOUS', `did you mean ${names}?`);
      if (r.code === 'NOT_APP') return refused('NOT_APP', 'that is an installer; it goes through run, which asks the user first');
      return failed('NOT_FOUND', `no Start menu app by that name${names ? ` (close: ${names})` : ''}; a command or the screen tools can try`);
    },
  };
}
