// Blob's windows are clawdcursor's own UI: the agent must never read or press them (a Yes on a card is the user's).
// The windows belong to this process, but on Windows what is drawn inside them (WebView2) lives in
// msedgewebview2.exe processes that Blob started, and the buttons of a card carry those process ids. They come and
// go, so their ids are kept in a file clawdcursor reads again while it runs (CLAWD_OWN_UI_PIDS_FILE, brain.ts).
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { os } from './os/index.ts';

export interface Proc { pid: number; parent: number; name: string }

const WEBVIEW = /^msedgewebview2\.exe$/i;

/** The web view processes under `root`, at any depth: its browser process and that one's renderers and helpers. */
export function webviewPids(procs: Proc[], root: number): number[] {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p]);
  const out: number[] = [], seen = new Set([root]);
  for (const queue = [root]; queue.length;) {
    for (const p of kids.get(queue.shift()!) ?? []) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      // Only the web view's own tree: claude, clawdcursor and what they start are Blob's children too, and not Blob's UI.
      if (!WEBVIEW.test(p.name)) continue;
      out.push(p.pid);
      queue.push(p.pid);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Windows: every running process (a toolhelp snapshot through koffi). Undefined where it isn't needed or can't be read. */
export function processLister(platform: string = os.id): (() => Proc[]) | undefined {
  if (platform !== 'win32') return undefined;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const Entry = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32_t',
      cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t', dwFlags: 'uint32_t',
      szExeFile: koffi.array('char16_t', 260),
    });
    const snapshot = kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)');
    const first = kernel32.func('int __stdcall Process32FirstW(intptr_t snap, _Inout_ PROCESSENTRY32W *entry)');
    const next = kernel32.func('int __stdcall Process32NextW(intptr_t snap, _Inout_ PROCESSENTRY32W *entry)');
    const close = kernel32.func('int __stdcall CloseHandle(intptr_t h)');
    return () => {
      const snap = snapshot(2, 0);                   // TH32CS_SNAPPROCESS
      if (Number(snap) === -1) return [];
      const out: Proc[] = [];
      try {
        const e = { dwSize: koffi.sizeof(Entry) } as Record<string, any>;
        for (let ok = first(snap, e); ok; ok = next(snap, e)) {
          out.push({ pid: e.th32ProcessID, parent: e.th32ParentProcessID, name: String(e.szExeFile) });
        }
      } finally { close(snap); }
      return out;
    };
  } catch (e) {
    console.log(`Blob: its web view's processes can't be named to clawdcursor (${(e as Error).message})`);
    return undefined;
  }
}

/**
 * Keeps `file` holding Blob's web view process ids, looked at every 2 s and written when they change (or the file
 * is gone). Returns the way to stop.
 */
export function keepOwnUiFile(file: string, list: (() => Proc[]) | undefined, root: number = process.pid, everyMs = 2000): () => void {
  if (!list) return () => {};
  let last: string | undefined;
  const look = () => {
    try {
      const now = webviewPids(list(), root).join(',');
      if (now !== last || !existsSync(file)) writeFileSync(file, last = now, { mode: 0o600 });
    } catch { /* the next look tries again */ }
  };
  look();
  const timer = setInterval(look, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
