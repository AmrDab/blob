// What the liquid looks like this frame: every body's outline and every strand, and which of them are drawn
// together. Plain numbers (the renderer turns them into uniforms; the tests read them as they are).
import { K_BODY, K_CAP, MAIN_R, type Body, type Sim } from './sim.ts';

export interface Shape {
  x: number; y: number; rx: number; ry: number;     // centre and half sizes
  cos: number; sin: number; a2c: number; a2s: number;   // stretch frame, wobble
  corner: number;      // > 0: a rounded box
  k: number;           // how wide it joins Speak's liquid; 0: a small blob (they join each other narrowly first)
  group: number;       // 0: joined to Speak; n: the small blob n - 1 sits apart, with what rides on it
  card?: boolean;      // a card: it rests away from Speak, so the resting ripple's box leaves it out
}
export interface Strand { ax: number; ay: number; bx: number; by: number; rb: number; rt: number; group: number }
export interface Scene { shapes: Shape[]; strands: Strand[] }

const BREATH = 2 * Math.PI / 4.8;      // one slow breath every 4.8 s
const NECK = 80;                       // a card's neck to Speak thins to nothing when they are this far apart

function ellipse(b: Body, breath: number, scale: number, k: number, group: number): Shape {
  const st = Math.sqrt(1 + b.e), r = b.r * scale * breath;
  b.rx = r * b.sx * st; b.ry = r * b.sy / st;
  return { x: b.x, y: b.y, rx: b.rx, ry: b.ry, cos: Math.cos(b.ang), sin: Math.sin(b.ang), a2c: b.a2c, a2s: b.a2s, corner: 0, k, group };
}

/** Where every body and strand is. `clock` drives the breathing (the radius swells, the shape is kept); `amp` 0 stills it. */
export function layout(sim: Sim, clock: number, amp: number): Scene {
  const { main, cap } = sim;
  const shapes: Shape[] = [ellipse(main, 1 + 0.03 * Math.sin(clock * BREATH) * amp, 1, K_BODY, 0)], strands: Strand[] = [];
  if (cap.alive) {
    shapes.push({ x: cap.x, y: cap.y, rx: cap.hw, ry: cap.hh, cos: 1, sin: 0, a2c: 0, a2s: 0, corner: Math.min(18, cap.hw, cap.hh), k: K_CAP, group: 0 });
  }
  for (const c of sim.cards) {
    shapes.push({ x: c.x, y: c.y, rx: c.hw, ry: c.hh, cos: 1, sin: 0, a2c: 0, a2s: 0, corner: Math.min(18, c.hw, c.hh), k: K_CAP, group: 0, card: true });
    // its neck: while the card is near Speak (budding out, or drawn back in) liquid stretches between them, from each
    // side to the middle, thinner the further apart they are. A card at rest is further away than that: no neck.
    const dx = main.x - c.x, dy = main.y - c.y, d = Math.hypot(dx, dy);
    const out = Math.min(c.hw / Math.max(Math.abs(dx), 1e-3), c.hh / Math.max(Math.abs(dy), 1e-3));   // where the line to Speak leaves the box
    const gap = d * (1 - out) - MAIN_R, f = 1 - gap / NECK;
    if (out >= 1 || gap <= 0 || f <= 0) continue;
    const base = Math.min(11 * Math.min(1, 3 * f), 0.8 * Math.min(c.hw, c.hh)), tip = Math.min(8.4 * Math.pow(f, 1.4), base);
    const ex = c.x + dx * out, ey = c.y + dy * out, ax = main.x - dx / d * (MAIN_R - base), ay = main.y - dy / d * (MAIN_R - base);
    strands.push({ ax, ay, bx: (ax + ex) / 2, by: (ay + ey) / 2, rb: base, rt: tip, group: 0 },
      { ax: ex, ay: ey, bx: (ax + ex) / 2, by: (ay + ey) / 2, rb: base, rt: tip, group: 0 });
  }
  sim.sats.forEach((s, i) => {
    // two strand halves, one growing out of each end and meeting in the middle; after a snap each one pulls back
    const dx = main.x - s.x, dy = main.y - s.y, base = s.r * 0.55 * s.g;
    let reach = 0.5, tip = s.r * 0.42 * Math.pow(1 - s.t, 1.4) * s.g;
    if (s.retract < 1) { const q = s.retract; reach = 0.5 * (1 - q) * (1 - q); tip = s.r * 0.16 * Math.sin(Math.PI * q) + tip * (1 - q); }
    s.strandOn = base > 0.05 && (s.linked || s.retract < 1 || s.g > 0.02);
    const group = s.attached || s.strandOn ? 0 : i + 1;
    if (s.strandOn) {
      strands.push({ ax: s.x, ay: s.y, bx: s.x + dx * reach, by: s.y + dy * reach, rb: base, rt: tip, group },
        { ax: main.x, ay: main.y, bx: main.x - dx * reach, by: main.y - dy * reach, rb: base, rt: tip, group });
    }
    // a closed one is inside Speak: nothing of it shows, so it is not drawn
    if (s.o < 0.02 && s.attached && !s.strandOn) { s.rx = s.ry = s.r * 0.55; return; }
    shapes.push(ellipse(s, 1 + 0.015 * Math.sin(clock * BREATH + 0.7 * (i + 1)) * amp, 0.55 + 0.45 * s.o, 0, group));
    for (const r of sim.riders) {
      if (r.of !== s || r.o < 0.05) continue;
      shapes.push({ x: r.x, y: r.y, rx: r.r * r.o, ry: r.r * r.o, cos: 1, sin: 0, a2c: 0, a2s: 0, corner: 0, k: 0, group });
    }
  });
  return { shapes, strands };
}

type Bounds = { x0: number; y0: number; x1: number; y1: number };
/** `core` (Speak's cluster, when cards are up): the same without the cards, which is all the resting ripple redraws. */
export interface Cluster extends Bounds { groups: number[]; core?: Bounds }
const grow = (c: Bounds, s: Shape, ex: number, ey: number) => {
  c.x0 = Math.min(c.x0, s.x - ex); c.x1 = Math.max(c.x1, s.x + ex); c.y0 = Math.min(c.y0, s.y - ey); c.y1 = Math.max(c.y1, s.y + ey);
};
const reach = (s: Shape) => s.corner > 0 ? [s.rx + 2, s.ry + 2] : [Math.max(s.rx, s.ry) * 1.13 + 2, Math.max(s.rx, s.ry) * 1.13 + 2];   // the body plus its largest wobble

/**
 * The boxes to draw: Speak with everything joined to it (always the first), and one for each blob that sits apart,
 * so the cost follows the liquid and not the window. Boxes closer than `pad` (their shadows' room) become one.
 */
export function clusters(scene: Scene, pad: number): Cluster[] {
  const by = new Map<number, Cluster>(), core: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of scene.shapes) {
    const [ex, ey] = reach(s);
    let c = by.get(s.group);
    if (!c) by.set(s.group, c = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, groups: [s.group] });
    grow(c, s, ex, ey);
    if (s.group === 0 && !s.card) grow(core, s, ex, ey);
  }
  if (scene.shapes.some(s => s.card)) by.get(0)!.core = core;
  const cl = [by.get(0)!, ...[...by].filter(([g]) => g !== 0).map(([, c]) => c)];
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < cl.length && !merged; i++) for (let j = i + 1; j < cl.length; j++) {
      const a = cl[i], b = cl[j];
      if (a.x0 - 2 * pad < b.x1 && b.x0 - 2 * pad < a.x1 && a.y0 - 2 * pad < b.y1 && b.y0 - 2 * pad < a.y1) {
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
        a.groups.push(...b.groups);
        cl.splice(j, 1); merged = true; break;
      }
    }
  }
  return cl;
}
