// Where things sit in the bubble's window: the slots around Speak, the cluster's box, and the window's size.
// Plain numbers, no DOM: the page and the tests share it.
import { MAX_PINNED } from '../../shared.ts';

// Shortcut blobs sit on arcs around Speak, from straight left to straight up: 5 on the inner one, 7 more on the outer.
const arc = (r: number, n: number) => Array.from({ length: n }, (_, i) => {
  const a = Math.PI + (i * Math.PI) / 2 / (n - 1);
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))] as const;
});
export const SLOTS = [...arc(118, MAX_PINNED), ...arc(166, 7)];
// The cluster's box for 0, 1 or 2 arcs in use (Speak's centre stays 50 px from its right and 46 px from its bottom).
export const BOX = [{ w: 150, h: 140 }, { w: 192, h: 186 }, { w: 240, h: 234 }];
export const MAIN_AT = { right: 50, bottom: 46 };
// Between the cards and the cluster's box. The lit liquid keeps them further apart: an open blob (or a remove-x) under a
// card must rest clear of it, not half joined.
export const GAP = 6, GAP_LIQUID = 16;
// The liquid's fan: Type, Log and Shortcuts 64 px from Speak, far enough apart that they rest as separate drops.
export const FAN = { type: [-45, -45], log: [0, -64], more: [-64, 0] } as const;

export interface Stage {
  w: number; h: number;        // the window, in CSS px
  padR: number; padB: number;  // empty room right of and under the cluster's box
  cardsW: number;              // the cards' column
}

/**
 * The window the page asks for. As small as the cards and the cluster need (`roomy` false: the liquid-gooey bubble,
 * or a system where the window can't let clicks through), or a wider transparent stage with room to pull the small
 * blobs out: only where empty pixels let clicks through to the desktop.
 */
export function stage(o: { roomy: boolean; big: boolean; arcs: number; cardsH: number; gap?: number }): Stage {
  const box = BOX[o.arcs], cards = Math.max(90, o.cardsH + 16 + (o.gap ?? GAP));      // at least room for a three-line caption
  const w = Math.max(o.big ? 360 : 320, box.w + 16);
  if (!o.roomy) return { w, h: cards + box.h, padR: 8, padB: 8, cardsW: w - 16 };
  const padR = 60, padB = 64;
  return { w: 500, h: Math.max(420, cards + box.h + padB - 8), padR, padB, cardsW: (o.big ? 360 : 320) - 16 };
}

/** Speak's centre in a window of this size. */
export const mainAt = (w: number, h: number, s: Pick<Stage, 'padR' | 'padB'>) =>
  ({ x: w - s.padR - MAIN_AT.right, y: h - s.padB - MAIN_AT.bottom });
