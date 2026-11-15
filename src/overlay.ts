// The pill window's native side. It appears while clawdcursor types and clicks, so it must not take the keyboard.
// On Windows (user32 through koffi) it is left out of screen captures, shown without activating, not activated by
// a click, and takes the keyboard only while the user types a reply. Elsewhere there is only the window library's
// own show, hide and content protection: there the pill can take the front when it is shown or clicked.
import { createRequire } from 'node:module';
import type { BrowserWindow } from '@webviewjs/webview';
import { focusKeeper } from './focus.ts';

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

export function overlay(win: BrowserWindow, platform: string = process.platform): Overlay {
  const plain: Overlay = { show: () => win.show(), hide: () => win.hide(), keyboard: on => { if (on) win.focus(); }, beep() {}, asksRefocus: platform === 'linux' };
  if (platform !== 'win32') {
    try { win.setContentProtection(true); } catch { /* the pill then shows in captures */ }
    return plain;
  }
  const h = Number(win.getNativeHandle());
  const NOACTIVATE = 0x08000000, EXSTYLE = -20;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
    const SetWindowDisplayAffinity = user32.func('int __stdcall SetWindowDisplayAffinity(intptr_t hwnd, uint32_t affinity)');
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
    SetWindowDisplayAffinity(h, 0x11);   // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+; older Windows ignores it)
    noActivate(true);
    const keeper = focusKeeper(h, platform);   // remembers the user's window, to hand the keyboard back to
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
    return plain;
  }
}
