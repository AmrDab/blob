// The liquid bubble: a WebGL canvas over the whole window, with the buttons and the caption's text as plain DOM on
// top, each kept over its body by the engine. The buttons are the same ones the 2D bubble shows (their labels and
// click handlers); the pointer goes to the canvas, which clicks them, and the keyboard reaches them directly.
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { startLiquid, type CardBox, type Engine } from './engine.ts';
import { inOrder } from './hit.ts';
import type { Stage } from './stage.ts';

export interface Item {
  id: string; r: number; home: readonly [number, number]; show: boolean; live: boolean; delay: number;
  node: ReactNode; hint?: string;
  rider?: { id: string; dx: number; dy: number; r: number; show: boolean; node: ReactNode };
}
export interface BubbleProps {
  st: Stage; zone: { w: number; h: number }; items: Item[];
  main: ReactNode; beam: ReactNode; caption: ReactNode; captionTitle?: string;
  post: (path: string, body?: unknown) => Promise<unknown>;
  on: {
    hover(on: boolean): void; hint(text: string | null): void; resting(on: boolean): void; captionH(h: number): void;
    mainDown(): void; mainDrag(): void; mainDragEnd(): void; mainUp(): void; mainCancel(): void; miss(): void; fail(): void;
  };
}

/** The cards above the bubble, each where the page laid it out (its own transform, which the engine sets, left out). */
const cards = (): CardBox[] => {
  const col = document.querySelector<HTMLElement>('.cards');
  if (!col) return [];
  const o = col.getBoundingClientRect();
  return [...col.querySelectorAll<HTMLElement>('[data-card]')].map(el =>
    ({ id: el.dataset.card!, el, x: o.left + el.offsetLeft, y: o.top + el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
};

/** The host's answer to /move: how far the window went, in CSS px (undefined when it does not say). */
const moved = async (r: unknown): Promise<{ x: number; y: number } | undefined> => {
  const m = await (r as Response).json().catch(() => null);
  return m && Number.isFinite(m.dx) && Number.isFinite(m.dy) ? { x: m.dx, y: m.dy } : undefined;
};

export function Bubble(p: BubbleProps) {
  const canvas = useRef<HTMLCanvasElement>(null), cap = useRef<HTMLDivElement | null>(null);
  const els = useRef(new Map<string, HTMLElement>()).current;
  const bind = (id: string) => (el: HTMLElement | null) => { if (el) els.set(id, el); else els.delete(id); };
  const now = useRef(p);
  now.current = p;
  const engine = useRef<Engine>();
  useEffect(() => {
    const e = startLiquid(canvas.current!, els,
      { moveBy: (dx, dy, start) => now.current.post('/move', { dx, dy, start }).then(moved), hit: inOrder(m => now.current.post('/hit', m)) },
      () => ({ ...now.current.on, cards, over: id => now.current.on.hint(now.current.items.find(i => i.id === id)?.hint ?? null) }));
    if (!e) { now.current.on.fail(); return; }
    engine.current = e;
    // a card that grows or shrinks by itself (a font that loads, a line that wraps) moves the ones above it
    const ro = new ResizeObserver(() => e.relayout());
    const col = document.querySelector('.cards');
    if (col) ro.observe(col);
    return () => { ro.disconnect(); e.destroy(); engine.current = undefined; };
  }, []);
  const shown = p.caption != null && p.caption !== false && p.caption !== '';
  useEffect(() => {
    const c = cap.current!;
    engine.current?.sync({
      padR: p.st.padR, padB: p.st.padB, zone: p.zone,
      sats: p.items.map(i => ({ id: i.id, r: i.r, home: i.home, show: i.show, live: i.live, delay: i.delay,
        rider: i.rider && { id: i.rider.id, dx: i.rider.dx, dy: i.rider.dy, r: i.rider.r, show: i.rider.show } })),
      caption: shown ? { hw: c.offsetWidth / 2 + 14, hh: c.offsetHeight / 2 + 9 } : null,
    });
    p.on.captionH(shown ? c.offsetHeight + 18 : 0);
  });
  return <>
    <canvas className="liq" ref={canvas} data-webview-drag-region="false" />
    <div className="liq-ring" ref={bind('ring')} />
    {p.items.map(i => <Fragment key={i.id}>
      <div className="liq-it" data-liq={i.id} ref={bind(i.id)}>{i.node}</div>
      {i.rider && <div className="liq-it" data-liq={i.rider.id} ref={bind(i.rider.id)}>{i.rider.node}</div>}
    </Fragment>)}
    <div className="liq-it" ref={bind('beam')}>{p.beam}</div>
    <div className="liq-it" data-liq="main" ref={bind('main')}>{p.main}</div>
    <div className="liq-cap caption" ref={el => { cap.current = el; bind('cap')(el); }} title={p.captionTitle}>{p.caption}</div>
  </>;
}
