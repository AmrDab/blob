// The pill window's native side, one per system (os.overlay). It appears while clawdcursor types and clicks, so it
// must not take the keyboard. It is left out of screen captures (os.hideFromCapture, for the bubble too). On Windows
// (user32 through koffi) it is also shown without activating, not activated by a click, and takes the keyboard only
// while the user types a reply. Elsewhere there is only the window library's own show, hide and content protection:
// there the pill can take the front when it is shown or clicked. On macOS the front is given back to the app the user
// was in when the reply box or the pill closes while the pill has the keyboard (not while the user types in the
// bubble), and the pause card has a sound.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { BrowserWindow } from '@webviewjs/webview';
import { macKeeper, winKeeper, type FocusKeeper } from './focus.ts';
import { loadFrontApp } from './mac.ts';

export interface Overlay {
  show(): void;
  hide(): void;
  /** true: the user clicked into the reply box, take the keyboard. false: give it back to the window they were in. */
  keyboard(on: boolean): void;
  /** The "your turn" sound of the pause card. */
  beep(): void;
  /** keyboard(false) can't hand the keyboard back here, so clawdcursor is asked to (BANNER_REFOCUS): Linux, as its own pill does. */
  asksRefocus: boolean;
}

/**
 * Leaves a window out of screen captures: what Blob shows (a question, the phone's QR code) is for the person at the
 * screen, never for a screenshot or OCR the agent takes. False when the system can't do it. This one is the window
 * library's own content protection.
 */
export function protect(win: BrowserWindow): boolean {
  try { win.setContentProtection(true); return true; } catch { return false; }
}

/** Windows: the same, by the window's display affinity. */
export function winProtect(win: BrowserWindow): boolean {
  try {
    const user32 = createRequire(import.meta.url)('koffi').load('user32.dll');
    const SetWindowDisplayAffinity = user32.func('int __stdcall SetWindowDisplayAffinity(intptr_t hwnd, uint32_t affinity)');
    return !!SetWindowDisplayAffinity(Number(win.getNativeHandle()), 0x11);   // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+)
  } catch { return false; }
}

/** The sound reminders play on a Mac. */
function chime(): void {
  try { spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' }).on('error', () => {}); }
  catch (e) { console.log(`Blob: no pause sound (${(e as Error).message})`); }
}

const PILL_TITLE = 'Blob pill';   // the pill window's title, as main.ts makes it

/** macOS: does the pill window have the keyboard? False where that can't be read (then nothing is handed back). */
function pillHasKeyboard(): () => boolean {
  try {
    const front = loadFrontApp();
    return () => { try { return front.keyTitle() === PILL_TITLE; } catch { return false; } };
  } catch (e) {
    console.log(`Blob: the pill can't hand the front back (${(e as Error).message})`);
    return () => false;
  }
}

/**
 * The window library's own show, hide and focus. `back` and `mine`: the front is handed back when the pill gives up
 * the keyboard it has. `chime`: the pause card's sound.
 */
function plain(win: BrowserWindow, p: { back?: FocusKeeper; mine?: () => boolean; chime?: () => void; asksRefocus?: boolean } = {}): Overlay {
  return {
    show: () => win.show(), hide: () => win.hide(),
    keyboard: on => { if (on) win.focus(); else if (p.mine?.()) p.back?.restore(); },
    beep: () => { p.chime?.(); },
    asksRefocus: !!p.asksRefocus,
  };
}

/** macOS. `mac`: its parts, for tests (the keeper that hands the front back, whether the pill has the keyboard, and the sound). */
export function macOverlay(win: BrowserWindow, mac: { keeper?: FocusKeeper; mine?: () => boolean; chime?: () => void } = {}): Overlay {
  const o = plain(win, {
    back: mac.keeper ?? macKeeper(),               // remembers the user's app, to hand the front back to
    mine: mac.mine ?? pillHasKeyboard(),           // the pill also closes while the user types in the bubble: not then
    chime: mac.chime ?? chime,
  });
  protect(win);
  return o;
}

/** Linux: no hand-back of its own and no sound. */
export function linuxOverlay(win: BrowserWindow): Overlay {
  protect(win);
  return plain(win, { asksRefocus: true });
}

/** Windows: shown without activating, not activated by a click, the keyboard only while the user types a reply. */
export function winOverlay(win: BrowserWindow): Overlay {
  winProtect(win);
  const h = Number(win.getNativeHandle());
  const NOACTIVATE = 0x08000000, EXSTYLE = -20;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
    const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
    const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)');
    const ShowWindow = user32.func('int __stdcall ShowWindow(intptr_t hwnd, int cmd)');
    const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
    const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)');
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)');
    const AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)');
    const MessageBeep = user32.func('int __stdcall MessageBeep(uint32_t type)');
    const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
    const noActivate = (on: boolean) => {
      const ex = Number(GetWindowLongPtrW(h, EXSTYLE));
      SetWindowLongPtrW(h, EXSTYLE, on ? ex | NOACTIVATE : ex & ~NOACTIVATE);
    };
    noActivate(true);
    const keeper = winKeeper(h);   // remembers the user's window, to hand the keyboard back to
    return {
      show: () => { ShowWindow(h, 4); },       // SW_SHOWNOACTIVATE
      hide: () => { ShowWindow(h, 0); },
      keyboard(on) {
        noActivate(!on);
        if (!on) { keeper.restore(); return; }
        if (!SetForegroundWindow(h)) {
          // the click went to the webview's own process, so Windows may refuse: join the front window's input queue
          const them = GetWindowThreadProcessId(GetForegroundWindow(), null), self = GetCurrentThreadId();
          if (them && them !== self && AttachThreadInput(self, them, 1)) {
            try { SetForegroundWindow(h); } finally { AttachThreadInput(self, them, 0); }
          }
        }
        win.focus();
      },
      beep: () => { MessageBeep(0x40); },      // MB_ICONASTERISK: the sound clawdcursor's own card plays
      asksRefocus: false,
    };
  } catch (e) {
    console.log(`Blob: the pill can take the keyboard and shows in captures (${(e as Error).message})`);
    return plain(win);
  }
}
