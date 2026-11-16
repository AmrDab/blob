// clawdcursor's pill as lit liquid: the orb, the line and Stop (or the "waiting for you" card, its choices and its
// buttons) are rounded bodies in the bubble's simulation, each sprung to where the page laid its text out. The line's
// body (or the card that takes its place) is the pill's core: every other body buds out of it and flows back into it.
// Plain numbers, no DOM: the page and the tests share it.
import type { Scene } from './scene.ts';
import { setCards, type CardDef, type Sim } from './sim.ts';

export const K_PILL = 14;      // how readily the pill's bodies join: across the few px between them, with a valley left
// Room around the pill in its window: 10 px above (where the 2D pill sits too), and for the lit one enough beside and
// under it for its shadow (which falls down and to the right; both sides get the same, so the pill stays centred).
export const PAD_2D = 10, PAD_LIQUID = { top: 10, side: 22, bottom: 26 };
const REST = ['orb', 'core', 'stop'];    // the pill itself: all the resting ripple redraws

/** The window the pill asks for, around content of this size. */
export function pillWindow(w: number, h: number, liquid: boolean): { w: number; h: number } {
  return liquid ? { w: w + 2 * PAD_LIQUID.side, h: h + PAD_LIQUID.top + PAD_LIQUID.bottom } : { w: w + 2 * PAD_2D, h: h + 2 * PAD_2D };
}

/** The pill's bodies now (centre and half size). The unseen Speak of this simulation rests at the core's centre: a
    new body buds from there and one that is gone flows back there. The first ones bud from where the core will be. */
export function setPill(sim: Sim, defs: CardDef[]): void {
  const core = defs.find(d => d.id === 'core') ?? defs[0];
  if (core) {
    if (!sim.cards.length) { sim.main.x = core.x; sim.main.y = core.y; }
    sim.anchor.x = core.x; sim.anchor.y = core.y;
  }
  setCards(sim, defs);
}

/** What the pill looks like this frame: the orb is a ball, every other body a rounded box (a capsule when it is low). */
export function pillScene(sim: Sim): Scene {
  return {
    strands: [],
    shapes: sim.cards.map(c => ({ x: c.x, y: c.y, rx: c.hw, ry: c.hh, cos: 1, sin: 0, a2c: 0, a2s: 0,
      corner: c.id === 'orb' ? 0 : Math.min(18, c.hw, c.hh), k: K_PILL, group: 0, ...(REST.includes(c.id) ? {} : { card: true }) })),
  };
}
