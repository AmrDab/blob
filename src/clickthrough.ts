// Click-through for the bubble's window. Its stage is bigger than the liquid (so blobs can be pulled out), and a
// transparent pixel must not take a click meant for the desktop under it. The page says which pixels are Blob
// (hit shapes, ui/liquid/hit.ts); this looks where the cursor is a few times a second and tells the window to
// ignore the mouse whenever the cursor is on none of them. A window that ignores the mouse gets no mouse events at
// all, which is why the host has to look. Where the cursor can't be read (os.cursor: user32 on Windows, the window
// library on macOS) the window takes every click, as before.
import { createRequire } from 'node:module';
import type { BrowserWindow } from '@webviewjs/webview';
import { ignoreNext, parseShapes, type HitShape } from './ui/liquid/hit.ts';

/**
 * The cursor in physical screen px; `down`: a mouse button is held (where that can be read). `points`: x and y are
 * in logical points instead (macOS, where screens of different scale share points, not pixels), so the window's
 * position is read and set in points too.
 */
export type Cursor = { x: number; y: number; down?: boolean; points?: boolean };
/** What of the bubble's window is used here. */
export type Win = Pick<BrowserWindow, 'getPosition' | 'getInnerSize' | 'scaleFactor' | 'setIgnoreCursorEvents' | 'getCursorPosition'>;

/**
 * A drag of the window that follows the cursor itself, in physical px: `start()` when a mouse's press begins (`stop()`
 * for a finger or a pen: the cursor may not be where they are), `move()` each time the page says it moved. The page's own numbers are in the scale of the screen the window is on, which is wrong
 * as soon as the cursor is on a screen with another scale. `move()` answers how far the window went, in the window's
 * CSS px, or undefined where the cursor can't be read (the caller then moves by the page's numbers).
 */
export function follower(win: Pick<BrowserWindow, 'getPosition' | 'setPosition' | 'scaleFactor'>, read: (() => Cursor) | undefined) {
  let last: Cursor | undefined;
  return {
    start(): void { try { last = read?.(); } catch { last = undefined; } },
    stop(): void { last = undefined; },
    move(): { dx: number; dy: number } | undefined {
      if (!last || !read) return undefined;
      try {
        const c = read();
        if (c.down === false) return { dx: 0, dy: 0 };      // the press is over: a late message moves nothing
        const dx = c.x - last.x, dy = c.y - last.y;
        last = c;
        if (!dx && !dy) return { dx: 0, dy: 0 };
        const lg = !!c.points, p = win.getPosition(lg), s = lg ? 1 : (win.scaleFactor() || 1);
        win.setPosition(p.x + dx, p.y + dy, lg);
        return { dx: dx / s, dy: dy / s };
      } catch { last = undefined; return undefined; }
    },
  };
}

const NEAR_MS = 25, FAR_MS = 100;      // how often to look: the cursor on or near the window, or far from it
const NEAR_PX = 200;

/** Windows: the cursor and the mouse buttons, from user32. Undefined when it can't be loaded. */
export function winCursor(): (() => Cursor) | undefined {
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct({ x: 'long', y: 'long' });
    const GetCursorPos = user32.func('GetCursorPos', 'int', [koffi.out(koffi.pointer(POINT))]);
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int key)');
    return () => {
      const p = { x: 0, y: 0 };
      GetCursorPos(p);
      return { x: p.x, y: p.y, down: !!((GetAsyncKeyState(1) | GetAsyncKeyState(2)) & 0x8000) };   // VK_LBUTTON, VK_RBUTTON
    };
  } catch { return undefined; }
}

/** macOS: the cursor from the window library, in points. Undefined when it can't be read. */
export function macCursor(win: Win & Partial<Pick<BrowserWindow, 'getPrimaryMonitor'>>, now: () => number = Date.now): (() => Cursor) | undefined {
  try {
    if (typeof win.getCursorPosition !== 'function') return undefined;
    // the library gives the cursor in the primary screen's pixels, whatever screen it is on: back to points.
    // Asking for the primary screen lists all its display modes, so its scale is kept for 2 s, not asked each read.
    let k = 0, at = 0;
    const scale = (): number => {
      const t = now();
      if (!k || t - at > 2000) { k = win.getPrimaryMonitor?.()?.scaleFactor || 1; at = t; }
      return k;
    };
    const read = (): Cursor => {
      const c = win.getCursorPosition(false), s = scale();
      return { x: c.x / s, y: c.y / s, points: true };
    };
    read();                                      // throws now if it can't
    return read;
  } catch { return undefined; }
}

export interface ClickThrough {
  /** Can this window let clicks through at all? The page keeps its window small when not. */
  readonly available: boolean;
  /** What the page posted: `shapes` (a list, or anything else for "none": the window takes every click) and/or `capture`. */
  set(msg: unknown): void;
  stop(): void;
}

/**
 * `over(on)` is called when the cursor comes onto Blob's shapes or leaves them (the page hears nothing from a
 * window that ignores the mouse); `gone()` once if the window turns out not to do it.
 */
export function clickThrough(win: Win, on: { over(on: boolean): void; gone(): void }, read: (() => Cursor) | undefined): ClickThrough {
  let shapes: HitShape[] | null = null, capture = false, ignoring = false, timer: ReturnType<typeof setTimeout> | undefined;
  let available = !!read;
  if (!read) console.log('Blob: the cursor can\'t be read here, so the bubble\'s window takes every click on it');
  const apply = (next: boolean) => {
    if (next === ignoring) return;
    win.setIgnoreCursorEvents(next);
    ignoring = next;
    on.over(!next);
  };
  const fail = (e: unknown) => {
    available = false; shapes = null;
    console.log(`Blob: the bubble's window can't let clicks through (${(e as Error).message})`);
    try { win.setIgnoreCursorEvents(false); } catch { /* it never did */ }
    ignoring = false;
    on.gone();
  };
  const look = () => {
    timer = undefined;
    if (!shapes || !read) return;
    let wait = FAR_MS;
    try {
      const c = read(), p = win.getPosition(!!c.points), size = win.getInnerSize(true), s = c.points ? 1 : (win.scaleFactor() || 1);
      const x = (c.x - p.x) / s, y = (c.y - p.y) / s;
      if (x > -NEAR_PX && y > -NEAR_PX && x < size.width + NEAR_PX && y < size.height + NEAR_PX) wait = NEAR_MS;
      apply(ignoreNext(ignoring, { shapes, capture, down: c.down, x, y }));
    } catch (e) { fail(e); return; }
    timer = setTimeout(look, wait);
    timer.unref();
  };
  return {
    get available() { return available; },
    set(msg) {
      if (!available || !msg || typeof msg !== 'object') return;
      const m = msg as { shapes?: unknown; capture?: unknown };
      if ('capture' in m) capture = m.capture === true;
      if ('shapes' in m) shapes = parseShapes(m.shapes);
      try {
        if (!shapes) apply(false);                 // no shapes: the window takes the mouse everywhere
        else if (capture) apply(false);            // a press is held: at once, not at the next look
      } catch (e) { fail(e); return; }
      if (shapes && !timer) look();
    },
    stop() { clearTimeout(timer); timer = undefined; shapes = null; },
  };
}
