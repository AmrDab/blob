// Which pixels of the bubble's window are Blob: the liquid's bodies and the cards, as circles and rounded boxes in
// window CSS px. The page sends them to the host; the host lets every other pixel's clicks through to the desktop.
// Plain numbers, no DOM and no Node: the page, the host and the tests share it.
import { MAIN_R, type Body, type Rider, type Sim } from './sim.ts';

export type HitShape = { x: number; y: number; r: number } | { x: number; y: number; w: number; h: number; c?: number };
export const MAX_SHAPES = 64;
export const MARGIN = 4;      // the liquid's edge ripples a few px around its shape

/** Is the point on one of the shapes (or within `margin` of it)? */
export function hits(shapes: readonly HitShape[], x: number, y: number, margin = MARGIN): boolean {
  for (const s of shapes) {
    if ('r' in s) { if (Math.hypot(x - s.x, y - s.y) <= s.r + margin) return true; continue; }
    const c = Math.min(s.c ?? 0, s.w / 2, s.h / 2);
    const qx = Math.abs(x - s.x - s.w / 2) - s.w / 2 + c, qy = Math.abs(y - s.y - s.h / 2) - s.h / 2 + c;
    if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - c <= margin) return true;
  }
  return false;
}

/**
 * Should the window ignore the mouse now? Never without shapes (the page has none: today's behaviour), never while
 * the page holds a press ("capture"); while a mouse button is down nothing changes (a drag that started on Blob
 * stays Blob's, one that started on the desktop stays the desktop's); else only when the cursor is off every shape.
 */
export function ignoreNext(now: boolean, i: { shapes: readonly HitShape[] | null; capture: boolean; down?: boolean; x: number; y: number }): boolean {
  if (!i.shapes || i.capture) return false;
  if (i.down) return now;
  return !hits(i.shapes, i.x, i.y);
}

/** Sends one message at a time, in the order asked (a failed one is skipped): the host never hears "the press is
    over" before "a press is held", which would leave the window taking every click. */
export function inOrder<T>(send: (m: T) => Promise<unknown>): (m: T) => void {
  let last: Promise<unknown> = Promise.resolve();
  return m => { last = last.then(() => send(m)).catch(() => {}); };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5;
/** What the page posted, checked: a list of shapes, or null (no click-through) when it is anything else. */
export function parseShapes(v: unknown): HitShape[] | null {
  if (!Array.isArray(v) || v.length > MAX_SHAPES) return null;
  const out: HitShape[] = [];
  for (const s of v) {
    if (!s || !num(s.x) || !num(s.y)) return null;
    if (num(s.r) && s.r >= 0) out.push({ x: s.x, y: s.y, r: s.r });
    else if (num(s.w) && num(s.h) && s.w >= 0 && s.h >= 0) out.push({ x: s.x, y: s.y, w: s.w, h: s.h, c: num(s.c) && s.c > 0 ? s.c : 0 });
    else return null;
  }
  return out;
}

/** The liquid's own shapes, in whole px: Speak, every small blob that is out, the remove-x's, the caption, and the cards. */
export function liquidShapes(sim: Sim): HitShape[] {
  const r = Math.round, out: HitShape[] = [{ x: r(sim.main.x), y: r(sim.main.y), r: MAIN_R }];
  for (const s of sim.sats) if (s.o > 0.5) out.push({ x: r(s.x), y: r(s.y), r: s.r });
  for (const x of sim.riders) if (x.o > 0.5) out.push({ x: r(x.x), y: r(x.y), r: x.r });
  const c = sim.cap;
  for (const b of [c, ...sim.cards]) if (b.alive && b.on) out.push({ x: r(b.x - b.hw), y: r(b.y - b.hh), w: r(2 * b.hw), h: r(2 * b.hh), c: 18 });
  return out;
}

/** The body under the pointer: a remove-x first (it sits on its shortcut), then the nearest small blob, then Speak. */
export function pick(sim: Sim, x: number, y: number): { body: Body; id: string } | { rider: Rider; id: string } | null {
  for (const r of sim.riders) if (r.o > 0.6 && Math.hypot(x - r.x, y - r.y) < r.r + 3) return { rider: r, id: r.id };
  let best = null, bd = 1e9;
  for (const s of sim.sats) {
    const d = Math.hypot(x - s.x, y - s.y);
    if (s.o > 0.6 && d < Math.max(s.rx, s.ry) + 8 && d < bd) { best = s; bd = d; }
  }
  if (best) return { body: best, id: best.id };
  return Math.hypot(x - sim.main.x, y - sim.main.y) < MAIN_R + 8 ? { body: sim.main, id: 'main' } : null;
}
