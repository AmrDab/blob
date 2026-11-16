// Keyboard focus hand-back. Clicking the bubble makes Blob the window in front, and clawdcursor then refuses keys
// (the window in front is the app driving it). So Blob keeps note of the last other window in front and gives the
// front back to it after a click. Windows: user32 through koffi. macOS: the app in front, through the Objective-C
// runtime (mac.ts). Elsewhere it does nothing.
import { createRequire } from 'node:module';
import { loadFrontApp, type FrontApp } from './mac.ts';

export interface FocusKeeper { restore(): void; stop(): void }

const NONE: FocusKeeper = { restore() {}, stop() {} };

/** macOS: whole apps, not windows. `own` (a window pointer there) is not used: Blob is this process. */
function macKeeper(load: () => FrontApp, me: number): FocusKeeper {
  let mac: FrontApp;
  try { mac = load(); mac.frontPid(); } catch (e) {
    console.log(`Blob: focus hand-back unavailable (${(e as Error).message})`);
    return NONE;
  }
  let last = 0;
  const timer = setInterval(() => {
    try { const p = mac.frontPid(); if (p && p !== me) last = p; } catch { /* the next look */ }
  }, 150);
  timer.unref();
  return {
    restore() {
      try { if (last && mac.selfActive()) mac.activate(last); }   // Blob's own state: the system's "app in front" can lag a click
      catch (e) { console.log(`Blob: focus hand-back failed (${(e as Error).message})`); }
    },
    stop() { clearInterval(timer); },
  };
}

export function focusKeeper(own: bigint | number, platform: string = process.platform, mac: () => FrontApp = loadFrontApp, pid: number = process.pid): FocusKeeper {
  if (platform === 'darwin') return macKeeper(mac, pid);
  if (platform !== 'win32') return NONE;
  let f: {
    GetForegroundWindow: () => number; SetForegroundWindow: (h: number) => number; IsWindow: (h: number) => number;
    IsIconic: (h: number) => number; ShowWindow: (h: number, cmd: number) => number; BringWindowToTop: (h: number) => number;
    GetWindowThreadProcessId: (h: number, pid: null) => number; AttachThreadInput: (a: number, b: number, on: number) => number;
    GetCurrentThreadId: () => number;
  };
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
    f = {
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)'),
      IsWindow: user32.func('int __stdcall IsWindow(intptr_t hwnd)'),
      IsIconic: user32.func('int __stdcall IsIconic(intptr_t hwnd)'),
      ShowWindow: user32.func('int __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
      BringWindowToTop: user32.func('int __stdcall BringWindowToTop(intptr_t hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)'),
      AttachThreadInput: user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)'),
      GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
    };
  } catch (e) {
    console.log(`Blob: focus hand-back unavailable (${(e as Error).message})`);
    return NONE;
  }
  const me = Number(own);
  let last = 0;
  // Every 150 ms: the window in front, when it isn't Blob. By the time a click reaches the page, Blob is in front.
  const timer = setInterval(() => {
    const h = f.GetForegroundWindow();
    if (h && h !== me) last = h;
  }, 150);
  timer.unref();
  return {
    restore() {
      if (f.GetForegroundWindow() !== me || !last || !f.IsWindow(last)) return;
      if (f.IsIconic(last)) f.ShowWindow(last, 9);   // SW_RESTORE
      if (f.SetForegroundWindow(last) && f.GetForegroundWindow() === last) return;
      // Windows lets only the app in front hand the front over; Blob is in front, but if it is still refused,
      // join the front window's input queue for a moment.
      const them = f.GetWindowThreadProcessId(f.GetForegroundWindow(), null), self = f.GetCurrentThreadId();
      if (them && them !== self && f.AttachThreadInput(self, them, 1)) {
        try { f.BringWindowToTop(last); f.SetForegroundWindow(last); } finally { f.AttachThreadInput(self, them, 0); }
      }
    },
    stop() { clearInterval(timer); },
  };
}
