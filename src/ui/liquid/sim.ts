// The liquid's bodies and how they move: springs at fixed steps, plain numbers, no DOM and no clock of its own.
// Speak is the big blob; the small ones (Type, Log, Shortcuts, pinned shortcuts) rest on slots around it, can be
// pulled away on a strand that thins and snaps, stay where they are dropped, and flow back when sent home.
export const MAIN_R = 28;
export const K_BODY = 18, K_SAT = 6, K_CAP = 26;   // how readily liquid joins: small to big, small to small, caption to big
export const STEP = 1 / 120;
const W2 = 2 * Math.PI * 3.2, ZETA = 0.18;         // the wobble: 3.2 Hz, lightly damped
const SNAP = 110;                                  // a strand snaps this far past its blob's resting distance
const EDGE = 24;                                   // nothing is dragged or dropped closer to the stage's edge

export interface Body {
  x: number; y: number; vx: number; vy: number; ax: number; ay: number; r: number;
  sx: number; sy: number; svx: number; svy: number;           // press squish
  a2c: number; a2s: number; a2cv: number; a2sv: number;       // wobble (the cos 2θ and sin 2θ parts)
  ang: number; e: number;                                     // stretch along the direction of travel
  pressed: boolean; rx: number; ry: number; tx: number; ty: number;
}
export interface Sat extends Body {
  id: string; home: readonly [number, number]; rest: number;
  show: boolean; delay: number; openAt: number;               // out on its slot, after a short stagger
  attached: boolean; linked: boolean; dragging: boolean; returning: boolean; strandOn: boolean;
  g: number; retract: number; o: number; t: number; dropx: number; dropy: number;
}
/** A remove-x: a droplet that sits on a shortcut's shoulder while browsing. */
export interface Rider { id: string; of: Sat; dx: number; dy: number; r: number; show: boolean; o: number; x: number; y: number }
export interface Cap {
  on: boolean; alive: boolean; x: number; y: number; vx: number; vy: number;
  hw: number; hh: number; hwv: number; hhv: number; tw: number; th: number; tx: number; ty: number;
}
/** A card (the Log, the Type box, a question…): a rounded box that buds out of Speak to where the page laid its text out. */
export interface Card extends Cap { id: string; lx: number; ly: number }
export interface CardDef { id: string; x: number; y: number; hw: number; hh: number }     // centre and half size, in stage px
export interface SatDef {
  id: string; r: number; home: readonly [number, number]; show: boolean; delay: number;
  live: boolean;                                              // has a slot at all (an unpinned shortcut has none)
  rider?: { id: string; dx: number; dy: number; r: number; show: boolean };
}
export interface Sim {
  w: number; h: number; t: number;
  main: Body; anchor: { x: number; y: number };
  sats: Sat[]; riders: Rider[]; cap: Cap; cards: Card[];
  pointer: { x: number; y: number };
  drag: { b: Body; sat: Sat | null; ox: number; oy: number; moved: boolean } | null;
  openness: number;      // 0 closed, 1 the small blobs are out
  clear: number;         // how far above Speak's centre the open cluster reaches (the caption sits above it)
}

function body(r: number, x = 0, y = 0): Body {
  return { x, y, vx: 0, vy: 0, ax: 0, ay: 0, r, sx: 1, sy: 1, svx: 0, svy: 0, a2c: 0, a2s: 0, a2cv: 0, a2sv: 0,
    ang: 0, e: 0, pressed: false, rx: r, ry: r, tx: x, ty: y };
}

export function createSim(): Sim {
  return { w: 0, h: 0, t: 0, main: body(MAIN_R), anchor: { x: 0, y: 0 }, sats: [], riders: [],
    cap: { on: false, alive: false, x: 0, y: 0, vx: 0, vy: 0, hw: 5, hh: 5, hwv: 0, hhv: 0, tw: 5, th: 5, tx: 0, ty: 0 },
    cards: [], pointer: { x: -1e4, y: -1e4 }, drag: null, openness: 0, clear: MAIN_R + 14 };
}

/** The small blobs there are now. One that was there before keeps its place and motion; a new one buds from Speak. */
export function setSats(sim: Sim, defs: SatDef[]): void {
  const old = new Map(sim.sats.map(s => [s.id, s])), oldR = new Map(sim.riders.map(r => [r.id, r]));
  sim.riders = [];
  sim.sats = defs.map(d => {
    const s: Sat = old.get(d.id) ?? { ...body(d.r, sim.main.x, sim.main.y), id: d.id, home: d.home, rest: 0, show: false, delay: 0,
      openAt: 0, attached: true, linked: false, dragging: false, returning: false, strandOn: false, g: 0, retract: 1, o: 0, t: 0,
      dropx: 0, dropy: 0 };
    s.r = d.r; s.home = d.home; s.rest = Math.hypot(d.home[0], d.home[1]); s.delay = d.delay;
    if (d.show && !s.show) s.openAt = sim.t + d.delay;
    s.show = d.show;
    if (!d.live && !s.dragging) sendHome(s);
    if (d.rider) {
      const r = oldR.get(d.rider.id) ?? { id: d.rider.id, of: s, dx: 0, dy: 0, r: 0, show: false, o: 0, x: s.x, y: s.y };
      r.of = s; r.dx = d.rider.dx; r.dy = d.rider.dy; r.r = d.rider.r; r.show = d.rider.show;
      sim.riders.push(r);
    }
    return s;
  });
}

/** Moves b towards (tx, ty) and leaves the acceleration on it for shape() to use. */
function spring(b: Body, tx: number, ty: number, k: number, c: number, dt: number): void {
  b.ax = (tx - b.x) * k - b.vx * c; b.ay = (ty - b.y) * k - b.vy * c;
  b.vx += b.ax * dt; b.vy += b.ay * dt; b.x += b.vx * dt; b.y += b.vy * dt;
  b.tx = tx; b.ty = ty;
}
function shape(b: Body, dt: number): void {
  // press squish, with overshoot on release
  const tsx = b.pressed ? 1.06 : 1, tsy = b.pressed ? 0.9 : 1;
  b.svx += ((tsx - b.sx) * 600 - b.svx * 18) * dt; b.sx += b.svx * dt;
  b.svy += ((tsy - b.sy) * 600 - b.svy * 18) * dt; b.sy += b.svy * dt;
  // wobble: two damped oscillators pushed along the axis of the acceleration, so a vertical pull bulges it vertically
  const m2 = b.ax * b.ax + b.ay * b.ay;
  let fc = 0, fs = 0;
  if (m2 > 1) {
    const f = Math.min(Math.sqrt(m2), 4000) * 0.004 / m2;
    fc = f * (b.ax * b.ax - b.ay * b.ay); fs = f * 2 * b.ax * b.ay;
  }
  b.a2cv += (-W2 * W2 * b.a2c - 2 * ZETA * W2 * b.a2cv + fc) * dt; b.a2c += b.a2cv * dt;
  b.a2sv += (-W2 * W2 * b.a2s - 2 * ZETA * W2 * b.a2sv + fs) * dt; b.a2s += b.a2sv * dt;
  const m = Math.hypot(b.a2c, b.a2s);
  if (m > 0.12) { b.a2c *= 0.12 / m; b.a2s *= 0.12 / m; }
  // stretch along the direction of travel, area kept
  const sp = Math.hypot(b.vx, b.vy), te = Math.min(0.35, sp * 0.0016);
  b.e += (te - b.e) * Math.min(1, dt * 30);
  if (sp > 8) b.ang = Math.atan2(b.vy, b.vx); else if (b.e < 0.004) b.ang = 0;
}
export function kick(b: Body, amount: number, angle: number): void {
  b.a2cv += amount * W2 * Math.cos(2 * angle); b.a2sv += amount * W2 * Math.sin(2 * angle);
}
const band = (v: number, lo: number, hi: number) => v < lo ? lo + (v - lo) * 0.25 : v > hi ? hi + (v - hi) * 0.25 : v;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));
function clampDrops(sim: Sim): void {
  for (const s of sim.sats) if (!s.attached) { s.dropx = clamp(s.dropx, EDGE, sim.w - EDGE); s.dropy = clamp(s.dropy, EDGE, sim.h - EDGE); }
}

export function step(sim: Sim, dt: number): void {
  const { main, drag, cap } = sim;
  sim.t += dt;
  // Speak chases its anchor tightly while the window is dragged (the liquid lags the pointer a little), else rests on it
  if (drag && drag.b === main && drag.moved) spring(main, sim.anchor.x, sim.anchor.y, 900, 50, dt);
  else spring(main, sim.anchor.x, sim.anchor.y, 170, 14, dt);
  shape(main, dt);

  let open = 0;
  for (const s of sim.sats) {
    const want = (s.show && sim.t >= s.openAt) || !s.attached || s.dragging ? 1 : 0;
    s.o += (want - s.o) * Math.min(1, dt * 12);
    if (s.attached) open = Math.max(open, s.o);

    if (s.dragging && drag) spring(s, band(sim.pointer.x + drag.ox, EDGE, sim.w - EDGE), band(sim.pointer.y + drag.oy, EDGE, sim.h - EDGE), 900, 50, dt);
    else if (s.attached) spring(s, main.x + s.home[0] * want, main.y + s.home[1] * want, 170, 14, dt);
    else spring(s, s.dropx, s.dropy, 30, 6, dt);
    shape(s, dt);

    // the strand between this blob and Speak
    const dx = s.x - main.x, dy = s.y - main.y, d = Math.hypot(dx, dy) || 1e-3;
    const snap = s.rest + SNAP;
    s.t = Math.max(0, Math.min(1, (d - s.rest) / SNAP));
    if (s.attached && !s.linked && !s.dragging && s.returning && d < snap * 0.7 && d > s.rest + 6) s.linked = true;   // re-forms on the way home
    if (s.linked && s.dragging) {
      const mid = s.r * 0.42 * Math.pow(1 - s.t, 1.4) * s.g;
      if (d > snap || (s.t > 0.35 && s.g > 0.9 && mid < 1.5)) {     // it snaps
        s.linked = false; s.attached = false; s.retract = 0;
        const ang = Math.atan2(dy, dx);
        kick(main, 0.08, ang); kick(s, 0.12, ang);
        main.vx -= dx / d * 40; main.vy -= dy / d * 40;
      }
    }
    if (s.linked && !s.dragging && d < s.rest + 4) s.linked = false;     // docked: the neck is the liquid itself again
    if (s.returning && s.attached && !s.dragging && d < s.rest + 3 && want === 1) {
      s.returning = false;
      const a2 = Math.atan2(dy, dx); kick(main, 0.05, a2); kick(s, 0.05, a2);
    }
    s.g += ((s.linked ? 1 : 0) - s.g) * Math.min(1, dt * 14);
    if (s.g < 0.004 && !s.linked) s.g = 0;
    if (s.retract < 1) s.retract = Math.min(1, s.retract + dt / 0.18);
  }
  sim.openness = open;
  for (const r of sim.riders) {
    r.o += ((r.show ? r.of.o : 0) - r.o) * Math.min(1, dt * 12);
    r.x = r.of.x + r.dx * r.o; r.y = r.of.y + r.dy * r.o;
  }

  // the caption: a rounded box that buds out of Speak, sits above whatever is out, and is drawn back in
  if (cap.alive) {
    const tw = cap.on ? cap.tw : 5, th = cap.on ? cap.th : 5;
    const lift = MAIN_R + 14 + (sim.clear - MAIN_R - 14) * sim.openness;
    bud(cap, cap.on ? Math.max(12 + tw, main.x + 8 - tw) : main.x, cap.on ? main.y - lift - th : main.y, tw, th, 220, 18, dt);
    if (gone(cap, main)) cap.alive = false;
  }
  // the cards: the same, to where the page laid each one out (slower and without the bounce: they are big, and there
  // is text to read and buttons to press on them)
  for (const c of sim.cards) {
    if (c.on) bud(c, c.lx, c.ly, c.tw, c.th, 140, 21, dt); else bud(c, main.x, main.y, 5, 5, 140, 21, dt);
  }
  if (sim.cards.some(c => gone(c, main))) sim.cards = sim.cards.filter(c => !gone(c, main));
}
/** A rounded box on its way to a place and a half size (or back into Speak): position and size on the same spring. */
function bud(c: Cap, cx: number, cy: number, tw: number, th: number, k: number, damp: number, dt: number): void {
  c.vx += ((cx - c.x) * k - c.vx * damp) * dt; c.vy += ((cy - c.y) * k - c.vy * damp) * dt;
  c.x += c.vx * dt; c.y += c.vy * dt;
  c.hwv += ((tw - c.hw) * k - c.hwv * damp) * dt; c.hw = Math.max(4, c.hw + c.hwv * dt);
  c.hhv += ((th - c.hh) * k - c.hhv * damp) * dt; c.hh = Math.max(4, c.hh + c.hhv * dt);
  c.tx = cx; c.ty = cy;
}
/** Drawn back into Speak: nothing of it is left to show. */
const gone = (c: Cap, main: Body) => !c.on && c.hw < 6.5 && c.hh < 6.5 && Math.hypot(c.x - main.x, c.y - main.y) < 6;

function moving(b: Body): boolean {
  return Math.abs(b.vx) + Math.abs(b.vy) > 0.5 || Math.abs(b.x - b.tx) + Math.abs(b.y - b.ty) > 0.1 ||
    Math.abs(b.a2c) + Math.abs(b.a2s) > 0.002 || Math.abs(b.sx - 1) > 0.002 || Math.abs(b.sy - 1) > 0.002 || b.e > 0.004;
}
/** Is anything still moving? When not, the page stops stepping and drawing at display rate. */
export function isActive(sim: Sim): boolean {
  if (sim.drag || moving(sim.main)) return true;
  for (const s of sim.sats) {
    if (moving(s) || s.retract < 1 || Math.abs(s.g - (s.linked ? 1 : 0)) > 0.01) return true;
    if (Math.abs(s.o - (s.show || !s.attached ? 1 : 0)) > 0.01) return true;
  }
  for (const r of sim.riders) if (Math.abs(r.o - (r.show ? r.of.o : 0)) > 0.01) return true;
  return [sim.cap, ...sim.cards].some(c => c.alive && (!c.on || Math.abs(c.vx) + Math.abs(c.vy) > 0.5 ||
    Math.abs(c.x - c.tx) + Math.abs(c.y - c.ty) > 0.1 || Math.abs(c.hw - c.tw) + Math.abs(c.hh - c.th) > 0.1));
}

/** Has the card arrived (within a few px of where its text is laid out, at its size)? Until then it takes no click. */
export const arrived = (c: Card) => c.on && Math.abs(c.x - c.lx) + Math.abs(c.y - c.ly) < 3 && Math.abs(c.hw - c.tw) + Math.abs(c.hh - c.th) < 3;

/**
 * The cards the page shows now, each where its text is laid out. One that was there keeps its body (it flows to the
 * new place); a new one buds from Speak; one that is gone is drawn back into Speak.
 */
export function setCards(sim: Sim, defs: CardDef[]): void {
  const old = new Map(sim.cards.filter(c => c.on).map(c => [c.id, c]));
  const next = defs.map(d => {
    const c: Card = old.get(d.id) ?? { id: d.id, on: true, alive: true, x: sim.main.x, y: sim.main.y, vx: 0, vy: 0, hw: 5, hh: 5, hwv: 0, hhv: 0,
      tw: 5, th: 5, tx: d.x, ty: d.y, lx: d.x, ly: d.y };
    old.delete(d.id);
    c.lx = d.x; c.ly = d.y; c.tw = Math.max(5, d.hw); c.th = Math.max(5, d.hh);
    return c;
  });
  for (const c of old.values()) c.on = false;
  sim.cards = [...sim.cards.filter(c => !next.includes(c)), ...next];     // the ones flowing back, then the ones that are up
}

/** The caption's body: on with the half size its text needs, or off (it is drawn back into Speak). */
export function setCaption(sim: Sim, on: boolean, tw = 5, th = 5): void {
  const c = sim.cap;
  if (on) {
    c.tw = tw; c.th = th;
    if (!c.alive) { c.alive = true; c.x = sim.main.x; c.y = sim.main.y; c.vx = c.vy = c.hwv = c.hhv = 0; c.hw = c.hh = 5; }
  }
  c.on = on;
}

/** A press on a body: the squish starts; it becomes a drag when pulled() is called. */
export function press(sim: Sim, b: Body, x: number, y: number): void {
  b.pressed = true;
  sim.pointer.x = x; sim.pointer.y = y;
  sim.drag = { b, sat: sim.sats.find(s => s === b) ?? null, ox: b.x - x, oy: b.y - y, moved: false };
}
/** The press moved: a small blob is now pulled (a strand forms at once), Speak now drags the window. */
export function pulled(sim: Sim): void {
  const d = sim.drag;
  if (!d || d.moved) return;
  d.moved = true;
  if (d.sat) { d.sat.dragging = true; d.sat.returning = false; if (d.sat.attached) d.sat.linked = true; }
}
export function sendHome(s: Sat): void {
  if (!s.attached) { s.attached = true; s.returning = true; }
}
/** The press ends. A pulled blob let go near its slot (or still on its strand) flows back; far away it stays there. */
export function release(sim: Sim): void {
  const d = sim.drag;
  if (!d) return;
  sim.drag = null;
  d.b.pressed = false;
  kick(d.b, 0.04, Math.PI / 2);
  const s = d.sat;
  if (!s || !d.moved) return;
  s.dragging = false;
  const m = sim.main, gap = Math.hypot(s.x - m.x, s.y - m.y) - s.r - MAIN_R;
  if (s.attached || Math.hypot(s.x - m.x - s.home[0], s.y - m.y - s.home[1]) < 70 || gap < K_BODY * 1.5) { s.attached = true; s.returning = true; }
  else { s.dropx = s.x; s.dropy = s.y; clampDrops(sim); }
}

function each(sim: Sim, f: (p: { x: number; y: number }) => void): void {
  f(sim.main); f(sim.cap);
  for (const c of sim.cards) f(c);
  for (const s of sim.sats) f(s);
  for (const r of sim.riders) f(r);
}
/** The window moved by (-dx, -dy): the liquid stays where it was on screen, then catches up with its anchor. */
export function shift(sim: Sim, dx: number, dy: number): void {
  each(sim, p => { p.x += dx; p.y += dy; });
  for (const s of sim.sats) if (!s.attached) { s.dropx += dx; s.dropy += dy; }
  clampDrops(sim);
}
/** The stage is w × h with Speak resting at (ax, ay): everything moves with it at once (the window grew or shrank). */
export function place(sim: Sim, w: number, h: number, ax: number, ay: number): void {
  const dx = ax - sim.anchor.x, dy = ay - sim.anchor.y;
  sim.w = w; sim.h = h; sim.anchor.x = ax; sim.anchor.y = ay;
  each(sim, p => { p.x += dx; p.y += dy; });
  for (const b of [sim.main, sim.cap, ...sim.cards, ...sim.sats]) { b.tx += dx; b.ty += dy; }
  for (const c of sim.cards) { c.lx += dx; c.ly += dy; }
  for (const s of sim.sats) { s.dropx += dx; s.dropy += dy; }
  clampDrops(sim);
}
