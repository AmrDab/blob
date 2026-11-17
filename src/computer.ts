// What Blob knows about the computer it is on, so it does not have to look it up:
//  - a profile (~/.blob/computer.md: system, machine, memory, screens, default browser, installed apps), read in the
//    background at start when the file is older than a day, and added to the brief (persona.ts);
//  - the apps open right now and the one in front, read for each request and put in front of it (brain.ts).
// App names only: never a window title, a file name or a page.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRunningApps } from './mac.ts';
import { webviewPids, type Proc } from './own-ui.ts';
import { blobHome } from './settings.ts';
import { HIDDEN, shellEnv } from './shell.ts';

// ── the profile ──────────────────────────────────────────────────────────────

export interface Profile { os: string; machine: string; memory: string; screens: string[]; browser: string; apps: string[] }

export const MAX_PROFILE = 2_000;   // characters of the part Blob writes: the app list is cut to fit
export const MAX_NOTES = 600;       // characters of the user's own notes that go into the brief with it
const DAY_MS = 24 * 3600 * 1000;
const NOTES = /^## Notes[ \t]*$/m;
const UNKNOWN = 'unknown';

export const computerFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'computer.md');

/** One line of plain text: nothing hidden, and no < > (they could close the brief's fence). */
const clean = (s: unknown, max = 80): string =>
  (typeof s === 'string' ? s : '').replace(new RegExp(`${HIDDEN.source}|[<>]`, 'g'), '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
/** Start menu entries that are not apps: an app's help, manuals, uninstaller and the like. */
const NOT_APP = /\b(uninstall\w*|help|documentation|manuals?|faqs?|release notes|read ?me|licen[cs]e|web ?site|examples?|check for (\w+ )?updates)\b/i;
/** App names: cleaned, no doubles (case does not matter), sorted. */
function appNames(names: unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names.map(x => clean(x, 60))) if (n && !NOT_APP.test(n) && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
const gb = (bytes: unknown): string => (Number(bytes) > 0 ? `${Math.round(Number(bytes) / 2 ** 30)} GB` : UNKNOWN);

/** The browser behind a Windows ProgId (ChromeHTML, MSEdgeHTM, FirefoxURL-…) or a macOS bundle id (com.google.chrome). */
const BROWSERS: [RegExp, string][] = [
  [/chrome/i, 'Google Chrome'], [/edge/i, 'Microsoft Edge'], [/firefox/i, 'Firefox'], [/brave/i, 'Brave'], [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'], [/safari/i, 'Safari'], [/thebrowser/i, 'Arc'], [/duckduckgo/i, 'DuckDuckGo'],
];
const browserName = (id: unknown): string => {
  const s = clean(id);
  return BROWSERS.find(([re]) => re.test(s))?.[1] ?? (s || UNKNOWN);
};

// One PowerShell call. Screens are asked for as a DPI-aware process, or a scaled display reports a smaller size.
const WINDOWS_READ = [
  "$ErrorActionPreference = 'SilentlyContinue'", '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$o = Get-CimInstance Win32_OperatingSystem', '$c = Get-CimInstance Win32_ComputerSystem',
  `Add-Type -Namespace Blob -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'`,
  '[void][Blob.Dpi]::SetProcessDPIAware()', 'Add-Type -AssemblyName System.Windows.Forms',
  '@{ os = $o.Caption; version = $o.Version; maker = $c.Manufacturer; model = $c.Model; ram = $c.TotalPhysicalMemory; ' +
    "screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0}x{1}' -f $_.Bounds.Width, $_.Bounds.Height }); " +
    "browser = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId; " +
    'apps = @(Get-StartApps | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress',
].join('; ');

/** The profile from that call's JSON. Throws when it is not JSON. */
export function parseWindows(json: string): Profile {
  const j = JSON.parse(json.slice(json.indexOf('{'))) as Record<string, unknown>;
  return {
    os: [clean(j.os).replace(/^Microsoft /, ''), clean(j.version)].filter(Boolean).join(' ') || UNKNOWN,
    machine: [clean(j.maker), clean(j.model)].filter(Boolean).join(' ') || UNKNOWN,
    memory: gb(j.ram),
    screens: list(j.screens).map(s => clean(s, 20)).filter(Boolean),
    browser: browserName(j.browser),
    apps: appNames(list(j.apps)),
  };
}

/** The profile from macOS's own tools: sw_vers, `sysctl -n hw.model hw.memsize`, system_profiler's displays (JSON),
 *  the LaunchServices handlers (`defaults read`), and the .app names of the Applications folders. Any may be ''. */
export function parseMac(o: { swVers: string; sysctl: string; displays: string; handlers: string; apps: string[] }): Profile {
  const sw = (key: string) => clean(o.swVers.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]);
  const [model, mem] = o.sysctl.trim().split(/\r?\n/);
  const screens: string[] = [];
  try {
    for (const card of list((JSON.parse(o.displays) as Record<string, unknown>).SPDisplaysDataType)) {
      for (const d of list((card as Record<string, unknown>)?.spdisplays_ndrvs) as Record<string, unknown>[]) {
        const m = String(d?._spdisplays_resolution ?? d?._spdisplays_pixels ?? '').match(/(\d+)\s*x\s*(\d+)/);
        if (m) screens.push(`${m[1]}x${m[2]}`);
      }
    }
  } catch { /* no displays read: none listed */ }
  // the http handler's own app; with handlers read and none for http, the system's browser is in use
  const handler = o.handlers.match(/LSHandlerRoleAll = "?([\w.-]+)"?;\s*LSHandlerURLScheme = "?http"?;/)?.[1];
  return {
    os: [sw('ProductName'), sw('ProductVersion')].filter(Boolean).join(' ') || UNKNOWN,
    machine: clean(model) ? `Apple ${clean(model)}` : UNKNOWN,
    memory: gb(mem),
    screens,
    browser: handler ? browserName(handler) : o.handlers.trim() ? 'Safari' : UNKNOWN,
    apps: appNames(o.apps.filter(a => /\.app$/i.test(a)).map(a => a.replace(/\.app$/i, ''))),
  };
}

/** The part of the file Blob writes: at most `max` characters, the app list cut to fit. */
export function render(p: Profile, max: number = MAX_PROFILE): string {
  const head = [
    '# This computer', '',
    'Blob reads this when it starts, at most once a day. What you write under "## Notes" is kept.', '',
    `- System: ${p.os}`, `- Machine: ${p.machine}`, `- Memory: ${p.memory}`,
    `- Screens: ${p.screens.length}${p.screens.length ? ` (${p.screens.join(', ')})` : ''}`,
    `- Default web browser: ${p.browser}`,
    `- Installed apps (${p.apps.length}): `,
  ].join('\n');
  let apps = '', n = 0;
  for (const a of p.apps) {
    const next = apps + (n ? ', ' : '') + a;
    if (head.length + next.length + 20 > max) break;      // room for ", and 1234 more"
    apps = next;
    n++;
  }
  return `${head}${apps}${n < p.apps.length ? `${n ? ', and ' : ''}${p.apps.length - n} more` : ''}\n`;
}

/** The whole file: the profile, then the user's notes exactly as they were in `old`. */
export function withNotes(profile: string, old: string): string {
  const at = old.match(NOTES)?.index;
  return `${profile}\n${at === undefined ? '## Notes\n' : old.slice(at).replace(/\s*$/, '\n')}`;
}

/** Older than a day, or not there. */
export const stale = (mtimeMs: number | undefined, now: number = Date.now()): boolean => mtimeMs === undefined || now - mtimeMs > DAY_MS;

type Run = (cmd: string, args: string[]) => Promise<string>;
const run: Run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { windowsHide: true, timeout: 60_000, maxBuffer: 4_000_000, env: shellEnv() }, (err, out) => (err ? rej(err) : res(String(out)))));

/** Reads this computer. Throws when the system's own tools can't be run; undefined where there is nothing to read with. */
export async function readProfile(platform: string = process.platform, exec: Run = run,
  ls: (dir: string) => string[] = d => { try { return readdirSync(d); } catch { return []; } }, home: string = homedir()): Promise<Profile | undefined> {
  if (platform === 'win32') {
    // encoded, so no quote of the script has to survive a command line
    return parseWindows(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_READ, 'utf16le').toString('base64')]));
  }
  if (platform !== 'darwin') return undefined;
  const soft = (cmd: string, args: string[]) => exec(cmd, args).catch(() => '');
  const [swVers, sysctl, displays, handlers] = await Promise.all([
    exec('sw_vers', []), soft('sysctl', ['-n', 'hw.model', 'hw.memsize']), soft('system_profiler', ['SPDisplaysDataType', '-json']),
    soft('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']),
  ]);
  const apps = ['/Applications', '/System/Applications', join(home, 'Applications')].flatMap(ls);
  return parseMac({ swVers, sysctl, displays, handlers, apps });
}

/** At start, in the background: writes the file again when it is older than a day. A failed read says so in the log
 *  and leaves the old file. True when it wrote. */
export async function refreshProfile(d: { file?: string; now?: number; read?: () => Promise<Profile | undefined> } = {}): Promise<boolean> {
  const file = d.file ?? computerFile();
  try {
    let mtime: number | undefined;
    try { mtime = statSync(file).mtimeMs; } catch { /* not there yet */ }
    if (!stale(mtime, d.now)) return false;
    const p = await (d.read ?? readProfile)();
    if (!p) return false;
    let old = '';
    try { old = readFileSync(file, 'utf8'); } catch { /* the first one */ }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', withNotes(render(p), old));
    renameSync(file + '.tmp', file);
    return true;
  } catch (e) {
    console.log(`Blob: could not read this computer's details (${(e as Error).message.split('\n')[0]})`);
    return false;
  }
}

/** What goes into the brief: the profile's facts and the user's notes, with nothing that could leave the fence. */
export function computerBrief(file: string, max: number = MAX_PROFILE + MAX_NOTES): string {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const at = text.match(NOTES)?.index;
  const tidy = (s: string) => s.replace(new RegExp(`${HIDDEN.source}|[<>]`, 'g'), '').trim();
  const facts = tidy((at === undefined ? text : text.slice(0, at)).split(/\r?\n/).filter(l => l.startsWith('- ')).join('\n')).slice(0, MAX_PROFILE);
  const notes = at === undefined ? '' : tidy(text.slice(at).replace(NOTES, '')).slice(0, MAX_NOTES);
  return `${facts}${notes ? `\nThe user's notes:\n${notes}` : ''}`.slice(0, max);
}

// ── the apps open now ────────────────────────────────────────────────────────

export const MAX_OPEN = 30;         // app names in one <computer_now>

/** Windows: one visible top-level window (the desktop itself left out). No title: only whether it has one. */
export interface Win {
  pid: number;
  /** The process of the "Windows.UI.Core.CoreWindow" inside it; 0 when it has none. */
  corePid: number;
  owned: boolean;
  /** A tool window, or one that is never activated: not an app's own window. */
  tool: boolean;
  /** Hidden by the system (another virtual desktop, a Store app kept ready). */
  cloaked: boolean;
  titled: boolean;
  /** The window that has the keyboard. */
  front: boolean;
}

const FRAME_HOST = /^applicationframehost\.exe$/i;

/** The apps with a window of their own, front to back, and the one in front. Blob's own windows are left out; when
 *  one of them is in front (the user is typing to Blob), "in front" is the app just behind it. */
export function appsOf(wins: Win[], procs: Proc[], self: number): { apps: string[]; front: string } {
  const names = new Map(procs.map(p => [p.pid, p.name]));
  const own = new Set([self, ...webviewPids(procs, self)]);
  const apps: string[] = [], seen = new Set<string>();
  let front = '', ownFront = false;
  for (const w of wins) {
    // a Store app's window belongs to the frame host; the app itself owns the core window inside it
    const pid = FRAME_HOST.test(names.get(w.pid) ?? '') ? w.corePid : w.pid;
    if (own.has(pid)) { ownFront ||= w.front; continue; }
    const app = pid ? clean((names.get(pid) ?? '').replace(/\.exe$/i, ''), 40) : '';   // 0: a frame with no app in it now
    if (!app || FRAME_HOST.test(app + '.exe')) continue;
    if (w.front) front = app;
    if (w.owned || w.tool || w.cloaked || !w.titled || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    apps.push(app);
  }
  return { apps: apps.slice(0, MAX_OPEN), front: front || (ownFront ? apps[0] ?? '' : '') };
}

/** What goes in front of a request; '' when nothing is open (or nothing was read). */
export function nowLine(apps: string[], front: string): string {
  if (!apps.length) return '';
  return `<computer_now>Open apps: ${apps.join(', ')}.${front ? ` In front: ${front}.` : ''}</computer_now>`;
}

/** Windows: every visible top-level window, front to back (user32 through koffi). No window text is read. */
function loadWindows(): () => Win[] {
  const koffi = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  const Each = koffi.pointer(koffi.proto('bool __stdcall BlobEachWindow(intptr_t hwnd, intptr_t arg)'));
  const enumWindows = user32.func('int __stdcall EnumWindows(BlobEachWindow *each, intptr_t arg)');
  const visible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)');
  const related = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t which)');
  const style = user32.func('int32_t __stdcall GetWindowLongW(intptr_t hwnd, int index)');
  const hung = user32.func('int __stdcall IsHungAppWindow(intptr_t hwnd)');
  const titleLength = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)');
  const threadPid = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
  const child = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, const char16_t *cls, const char16_t *title)');
  const foreground = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const desktop = user32.func('intptr_t __stdcall GetShellWindow()');
  const attribute = koffi.load('dwmapi.dll').func('int __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ int32_t *value, uint32_t size)');
  const pidOf = (h: unknown): number => { const pid = [0]; threadPid(h, pid); return pid[0]; };
  return () => {
    const all: unknown[] = [];
    const each = koffi.register((h: unknown) => { all.push(h); return true; }, Each);
    try { enumWindows(each, 0); } finally { koffi.unregister(each); }
    const front = Number(foreground()), shell = Number(desktop());
    return all.filter(h => visible(h) && Number(h) !== shell).map(h => {
      const ex = style(h, -20), core = child(h, 0, 'Windows.UI.Core.CoreWindow', null), cloaked = [0];   // GWL_EXSTYLE
      attribute(h, 14, cloaked, 4);                                                                       // DWMWA_CLOAKED
      const owned = Number(related(h, 4)) !== 0;                                                          // GW_OWNER
      const tool = (ex & 0x80) !== 0 || ((ex & 0x08000000) !== 0 && (ex & 0x40000) === 0);   // TOOLWINDOW; NOACTIVATE without APPWINDOW
      return {
        pid: pidOf(h), corePid: Number(core) ? pidOf(core) : 0, owned, tool, cloaked: cloaked[0] !== 0,
        // the length is asked of the window itself, so only of one that may count; one that does not answer is not
        // asked, and counts as an app's
        titled: !owned && !tool && !cloaked[0] && (!!hung(h) || titleLength(h) > 0),
        front: Number(h) === front,
      };
    });
  };
}

/**
 * The reader main.ts hands to the brain: "<computer_now>Open apps: …. In front: ….</computer_now>", or '' when it
 * can't be read (and on Linux). Never throws. `procs`: own-ui.ts's process lister (Windows names an app by its program).
 */
export function computerNow(d: {
  platform?: string; self?: number; procs?: () => Proc[]; wins?: () => Win[]; mac?: () => { apps: string[]; front: string };
} = {}): () => string {
  const platform = d.platform ?? process.platform, self = d.self ?? process.pid;
  let wins = d.wins, mac = d.mac, off = (platform !== 'win32' && platform !== 'darwin') || (platform === 'win32' && !d.procs);
  return () => {
    if (off) return '';
    try {
      if (platform === 'win32') wins ??= loadWindows(); else mac ??= loadRunningApps(self);
    } catch (e) {
      off = true;                                   // a second try would fail the same way
      console.log(`Blob: the open apps can't be read (${(e as Error).message})`);
      return '';
    }
    try {
      if (wins) { const r = appsOf(wins(), d.procs!(), self); return nowLine(r.apps, r.front); }
      const r = mac!();
      return nowLine([...new Set(r.apps.map(a => clean(a, 40)).filter(Boolean))].slice(0, MAX_OPEN), clean(r.front, 40));
    } catch { return ''; }
  };
}
