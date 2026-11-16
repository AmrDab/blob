// Runs the pill's liquid on its page: steps the simulation, draws it with the bubble's renderer, and keeps each
// body's text and buttons (plain DOM, where the page laid them out) riding it. The canvas takes no pointer: the DOM
// over it does. At display rate while anything moves, then a slow ripple of the pill itself; nothing while hidden.
import { rideCss, type CardBox } from './engine.ts';
import { pillScene, setPill } from './pillscene.ts';
import { createRenderer } from './renderer.ts';
import { STEP, arrived, createSim, isActive, place, step, type Card } from './sim.ts';

const REST_FPS = 12;
const MAX_DPR = 2;
const LOST_MS = 4000;      // a lost GPU context that is not back by then: the page falls back to the 2D pill

export interface PillEngine {
  /** The bodies moved or changed on the page: the liquid follows. */
  relayout(): void;
  destroy(): void;
}

/** Undefined when WebGL can't be used here. `boxes`: the pill's bodies now, each where its element is laid out. */
export function startPill(canvas: HTMLCanvasElement, boxes: () => CardBox[], fail: () => void): PillEngine | undefined {
  let renderer = createRenderer(canvas);
  if (!renderer) return undefined;
  const sim = createSim();
  let raf = 0, timer = 0, last = performance.now(), accum = 0, clock = 0, restClock = 0, awake = true, lostTimer = 0;
  let devW = 0, devH = 0, els = new Map<string, HTMLElement>(), key = '';
  const placed = new WeakMap<HTMLElement, string>();
  const ready = new WeakSet<Card>();     // bodies that have arrived once: from then on they take clicks while they move

  function frame(t: number): void {
    raf = 0;
    const raw = Math.max(0, (t - last) / 1000); last = t;
    if (awake) {                                   // resting: nothing is moving, so the simulation is not stepped
      accum += Math.min(raw, 0.05);
      while (accum >= STEP) { step(sim, STEP); accum -= STEP; }
    }
    clock += Math.min(raw, 0.25);
    draw(awake);
    if (document.hidden || !renderer) return;
    awake = isActive(sim);
    if (awake) raf = requestAnimationFrame(frame);
    else timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, 1000 / REST_FPS);
  }
  function stop(): void { cancelAnimationFrame(raf); clearTimeout(timer); raf = 0; timer = 0; }
  function wake(): void {
    if (!renderer || document.hidden) return;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!awake) { awake = true; last = performance.now(); accum = 0; }
    if (!raf) raf = requestAnimationFrame(frame);
  }
  /** `all`: everything. Else only the pill itself is redrawn (the resting ripple), with the shadow held still. */
  function draw(all: boolean): void {
    const scene = pillScene(sim);
    if (all) restClock = clock;
    if (scene.shapes.length) renderer?.draw(scene, clock, all ? 'all' : 'core', restClock);
    for (const c of sim.cards) {
      const el = c.on ? els.get(c.id) : undefined;
      if (!el) continue;
      let css = rideCss(c);
      if (arrived(c)) ready.add(c); else if (ready.has(c)) css = css.replace('pointer-events:none;', '');
      if (placed.get(el) !== css) { placed.set(el, css); el.style.cssText = css; }
    }
  }

  function relayout(): void {
    const b = boxes();
    if (b.some(x => els.get(x.id) !== x.el)) wake();              // a new element: the next frame places it
    els = new Map(b.map(x => [x.id, x.el]));
    const defs = b.map(x => ({ id: x.id, x: x.x + x.w / 2, y: x.y + x.h / 2, hw: x.w / 2, hh: x.h / 2 }));
    const k = JSON.stringify(defs);
    if (k === key) return;
    key = k;
    setPill(sim, defs);
    wake();
  }

  // the canvas matches the screen's own pixels (up to MAX_DPR), so nothing is resampled
  function resize(): void {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = devicePixelRatio || 1, lim = Math.min(1, MAX_DPR / dpr);
    const cw = Math.max(1, Math.round((devW || w * dpr) * lim)), ch = Math.max(1, Math.round((devH || h * dpr) * lim));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    renderer?.resized(cw / w);
    // the pill is centred in its window: when the window grows or shrinks, the liquid stays where it is on screen
    place(sim, w, h, sim.anchor.x + (sim.w ? (w - sim.w) / 2 : 0), sim.anchor.y);
    relayout();
  }
  const ro = new ResizeObserver(es => {
    const d = es[0].devicePixelContentBoxSize?.[0];
    devW = d ? d.inlineSize : 0; devH = d ? d.blockSize : 0;
    resize();
    if (renderer && !document.hidden) { draw(true); wake(); }     // redraw in the same frame: a resized canvas starts out blank
  });
  try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }

  const onHidden = () => { if (document.hidden) stop(); else wake(); };
  // The GPU context can be lost (sleep and resume, a driver update, a GPU crash). Stop, then start again when it returns.
  const onLost = (e: Event) => {
    e.preventDefault();
    stop(); renderer = undefined;
    lostTimer = window.setTimeout(fail, LOST_MS);
  };
  const onRestored = () => {
    clearTimeout(lostTimer);
    renderer = createRenderer(canvas);
    if (!renderer) { fail(); return; }
    resize();
    wake();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  document.addEventListener('visibilitychange', onHidden);
  resize();
  if (!raf) raf = requestAnimationFrame(frame);

  return {
    relayout,
    destroy() {
      stop();
      clearTimeout(lostTimer);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onHidden);
      renderer?.release();               // the pill's canvas goes with each task: free its context now, not at GC
    },
  };
}
