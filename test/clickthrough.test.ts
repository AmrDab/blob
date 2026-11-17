// macOS with screens of different scale: the cursor and the window are compared in points, not pixels.
// (The rest of click-through and the drag is in liquid.test.ts.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clickThrough, follower, macCursor } from '../src/clickthrough.ts';
import { osFor } from '../src/os/index.ts';

/**
 * A Retina primary screen (scale 2) and the window on a 1x screen. The window is at (1000, 500) in points, which is
 * also its own physical px; the cursor comes from the library in the primary screen's px.
 */
function mac(cursor: { x: number; y: number }) {
  const at = { x: 1000, y: 500 }, asked: boolean[] = [], set: unknown[][] = [], ignore: boolean[] = [];
  const win = {
    getPosition: (logical?: boolean | null) => { asked.push(!!logical); return { ...at }; },
    setPosition: (x: number, y: number, logical?: boolean | null) => { set.push([x, y, logical]); at.x = x; at.y = y; },
    getInnerSize: () => ({ width: 300, height: 200 }),
    scaleFactor: () => 1,
    setIgnoreCursorEvents: (v: boolean) => { ignore.push(v); },
    getCursorPosition: () => ({ ...cursor }),
    getPrimaryMonitor: () => ({ scaleFactor: 2 }) as never,
  };
  return { win, at, asked, set, ignore };
}

afterEach(() => vi.useRealTimers());

describe('the cursor on macOS', () => {
  it('is read in points: the primary screen\'s scale is taken out', () => {
    const { win } = mac({ x: 2000, y: 1000 });
    expect(macCursor(win)!()).toEqual({ x: 1000, y: 500, points: true });
  });

  it('asks for the primary screen\'s scale once in 2 s, not on every read', () => {
    const { win } = mac({ x: 2000, y: 1000 });
    let asks = 0, scale = 2, t = 1000;
    const read = macCursor({ ...win, getPrimaryMonitor: () => { asks++; return { scaleFactor: scale } as never; } }, () => t)!;
    read(); read();
    expect(asks).toBe(1);                          // the first read (in macCursor) asked
    scale = 1; t += 2001;                          // the screens were rearranged
    expect(read()).toEqual({ x: 2000, y: 1000, points: true });
    expect(asks).toBe(2);
  });

  it('cannot be read: no reader', () => {
    const { win } = mac({ x: 0, y: 0 });
    expect(macCursor({ ...win, getCursorPosition: () => { throw new Error('no'); } })).toBeUndefined();
    expect(osFor('linux').cursor).toBeUndefined();
  });

  it('on the window\'s own corner is on its shape, whatever the two screens\' scales', () => {
    vi.useFakeTimers();
    const cursor = { x: 2010, y: 1010 };           // 5 points into the window
    const { win, asked, ignore } = mac(cursor);
    const over: boolean[] = [];
    const ct = clickThrough(win, { over: on => over.push(on), gone() {} }, macCursor(win));
    ct.set({ shapes: [{ x: 0, y: 0, w: 20, h: 20 }] });
    expect(asked).toEqual([true]);                 // the window's position in points too
    expect(ignore).toEqual([]);                    // on Blob: the window keeps the mouse
    cursor.x = 2100;                               // 50 points in: off the shape
    vi.advanceTimersByTime(30);
    expect(ignore).toEqual([true]);
    expect(over).toEqual([false]);
    ct.stop();
  });
});

describe('a drag of the window on macOS', () => {
  it('moves the window as far as the cursor, in points', () => {
    const cursor = { x: 2000, y: 1000 };
    const { win, at, set } = mac(cursor);
    const f = follower(win, macCursor(win));
    f.start();
    cursor.x = 2020; cursor.y = 990;               // 20 and -10 of the primary screen's px: 10 and -5 points
    expect(f.move()).toEqual({ dx: 10, dy: -5 });
    expect(set).toEqual([[1010, 495, true]]);
    expect(at).toEqual({ x: 1010, y: 495 });
  });
});
