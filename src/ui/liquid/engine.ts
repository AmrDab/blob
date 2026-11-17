// Runs the liquid on the page: steps the simulation, draws it, keeps the buttons and the caption's text over their
// bodies (transform only), takes the pointer for the canvas, and tells the host which pixels are Blob. No React.
// Awake at display rate while anything moves, a slow breath after that, then a resting ripple inside Speak's box only.
import { liquidShapes, pick, type HitShape } from './hit.ts';
import { createRenderer } from './renderer.ts';
import { layout } from './scene.ts';
import { STEP, arrived, createSim, isActive, place, press, pulled, release, sendHome, setCaption, setCards, setSats, shift, step, type Body, type Card, type Sat, type SatDef } from './sim.ts';
import { GAP_LIQUID, MAIN_AT, mainAt } from './stage.ts';

const SLEEP_MS = 10_000;   // stillness before the breath settles into the resting ripple
const REST_FPS = 12;
const MAX_DPR = 2;         // sharpest the liquid is drawn at (its edge is soft; the text over it is DOM, and stays sharp)
const DRAG_PX = 4;         // a press that moves further than this is a pull (a small blob) or a window drag (Speak)
const DOUBLE_MS = 300;     // two taps this close on a blob that sits apart send it home
const LOST_MS = 4000;      // a lost GPU context that is not back by then: the page falls back to the 2D liquid
const LEFT_MS = 200;       // the host says the cursor is off Blob: believed when nothing says otherwise for this long

export interface Host {
  /** Moves Blob's window by this many CSS px (`start`: a press on Speak begins, with a mouse or with something else);
      resolves once it has moved, with how far it really went when the host says (a mouse's drag follows the cursor
      itself where the host can read it). */
  moveBy(dx: number, dy: number, start?: 'mouse' | 'other'): Promise<{ x: number; y: number } | undefined>;
  /** The shapes that take the mouse (null: none, no click-through), or whether a press is held. */
  hit(msg: { shapes?: HitShape[] | null; capture?: boolean }): void;
}
export interface Handlers {
  hover(on: boolean): void;           // the pointer (or the keyboard's focus) is on the cluster
  over(id: string | null): void;      // the small blob under the pointer
  resting(on: boolean): void;         // nothing moves any more (the voice ring pauses too)
  mainDown(): void; mainDrag(): void; mainDragEnd(): void; mainUp(): void; mainCancel(): void;   // a press on Speak
  miss(): void;                       // a press that clicks nothing (between the blobs, a pull): the keyboard goes back
  cards(): CardBox[];                 // the cards on the page now, each where its text is laid out
  fail(): void;                       // the GPU is gone for good
}
export interface View {
  padR: number; padB: number;                     // the stage (stage.ts)
  zone: { w: number; h: number };                 // the cluster's box: the pointer inside it keeps the small blobs out
  sats: SatDef[];
  caption: { hw: number; hh: number } | null;     // the caption's half size, text plus padding
}
/** A card's element and its box as laid out (stage px, without the transform the engine puts on it). */
export interface CardBox { id: string; el: HTMLElement; x: number; y: number; w: number; h: number }
export interface Engine {
  sync(v: View): void;
  /** The cards moved or changed size on the page: their bodies follow. */
  relayout(): void;
  destroy(): void;
}

/** The style that keeps a card's element on its body: moved with it, shown as the body nears its size, clipped to
    what the liquid has reached, and taking no pointer until it has arrived. */
export function rideCss(c: Card): string {
  const dx = c.x - c.lx, dy = c.y - c.ly, ix = Math.max(0, c.tw - c.hw), iy = Math.max(0, c.th - c.hh);
  const o = Math.max(0, Math.min(1, (Math.min(c.hw / c.tw, c.hh / c.th) - 0.6) / 0.4));
  return `opacity:${o.toFixed(2)};` + (Math.abs(dx) + Math.abs(dy) > 0.25 ? `transform:translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px);` : '') +
    (ix + iy > 0.5 ? `clip-path:inset(${iy.toFixed(1)}px ${ix.toFixed(1)}px round 18px);` : '') + (arrived(c) ? '' : 'pointer-events:none;');
}

/** Undefined when WebGL can't be used here. `els` holds the element to keep over each body, by id. */
export function startLiquid(canvas: HTMLCanvasElement, els: Map<string, HTMLElement>, host: Host, on: () => Handlers): Engine | undefined {
  let renderer = createRenderer(canvas);
  if (!renderer) return undefined;
  const sim = createSim();
  let view: View = { padR: 8, padB: 8, zone: { w: 0, h: 0 }, sats: [], caption: null }, viewKey = '';
  let raf = 0, timer = 0, last = 0, accum = 0, clock = 0, restClock = 0, breathAmp = 1, lastInput = performance.now();
  let mode: 'awake' | 'breathing' | 'resting' | 'paused' = 'awake', still = false;
  let devW = 0, devH = 0;
  let seen = false, hover = false, overId: string | null = null, leftTimer = 0;
  let focusId: string | null = null;
  let down: { pointer: number; sx: number; sy: number; px: number; py: number; target: string; moved: boolean } | null = null;
  let tapTimer = 0, tapId = '';
  let lostTimer = 0;
  let shapesKey = '', shapesAt = 0;
  const held = { liquid: false, dom: false };      // a press is held: on the liquid, or on a card or the caption over it
  let cardEls = new Map<string, HTMLElement>(), cardsKey = '[]';

  // ── the loop ──
  function setMode(m: typeof mode): void {
    mode = m;
    const s = m === 'resting' || m === 'paused';
    if (s !== still) { still = s; on().resting(s); }
  }
  function frame(t: number): void {
    raf = 0;
    const raw = Math.max(0, (t - last) / 1000); last = t;
    const rest = mode === 'resting', all = mode === 'awake';
    if (!rest) {                                   // resting: nothing is moving, so the simulation is not stepped
      accum += Math.min(raw, 0.05);
      while (accum >= STEP) { step(sim, STEP); accum -= STEP; }
    }
    clock += Math.min(raw, 0.25);
    const idle = t - lastInput > SLEEP_MS;
    breathAmp += ((idle ? 0 : 1) - breathAmp) * Math.min(1, raw * 3);
    if (idle && breathAmp < 0.01) breathAmp = 0;
    draw(all);
    if (document.hidden || !renderer) setMode('paused');
    else if (isActive(sim)) { setMode('awake'); raf = requestAnimationFrame(frame); }
    else if (idle && breathAmp === 0) {            // alive: the surface keeps rippling, cheaply
      setMode('resting'); later(1000 / REST_FPS);
    } else { setMode('breathing'); later(66); }
  }
  function later(ms: number): void { timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, ms); }
  function stop(): void { cancelAnimationFrame(raf); clearTimeout(timer); raf = 0; timer = 0; }
  function wake(): void {
    lastInput = performance.now();
    if (!renderer || document.hidden) return;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!raf) { if (mode !== 'awake') { last = lastInput; accum = 0; } raf = requestAnimationFrame(frame); }
    if (mode !== 'awake') setMode('awake');        // the next frame draws everything again
  }

  /** `all`: everything. Else nothing but Speak's part can have changed (the breath, the resting ripple): only that is
      redrawn, with the shadow held where the last whole picture left it. */
  function draw(all: boolean): void {
    const scene = layout(sim, clock, breathAmp);
    if (all) restClock = clock;
    renderer?.draw(scene, clock, all ? 'all' : 'core', restClock);
    placeDom();
    postShapes();
  }

  // ── the DOM that rides the liquid ──
  const placed = new WeakMap<HTMLElement, string>();
  function put(id: string, x: number, y: number, opacity: number, b?: Body, more = ''): void {
    const el = els.get(id);
    if (!el) return;
    let tf = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)`;
    if (b) {
      const deg = (b.ang * 180 / Math.PI).toFixed(1), st = Math.sqrt(1 + b.e);
      tf += ` rotate(${deg}deg) scale(${(b.sx * st).toFixed(3)},${(b.sy / st).toFixed(3)}) rotate(${-deg}deg)`;
    }
    const css = `transform:${tf};opacity:${opacity.toFixed(2)};${more}`;
    if (placed.get(el) !== css) { placed.set(el, css); el.style.cssText = css; }
  }
  const bodyOf = (id: string | null): { x: number; y: number; rx: number; ry: number; ang: number } | undefined => {
    if (id === 'main') return sim.main;
    const r = sim.riders.find(x => x.id === id);
    return r ? { x: r.x, y: r.y, rx: r.r, ry: r.r, ang: 0 } : sim.sats.find(s => s.id === id);
  };
  function placeDom(): void {
    const { main, cap } = sim;
    put('main', main.x, main.y, 1, main);
    put('beam', main.x, main.y, 1);
    for (const s of sim.sats) put(s.id, s.x, s.y, Math.max(0, Math.min(1, (Math.hypot(s.x - main.x, s.y - main.y) - 30) / 18)), s);
    for (const r of sim.riders) put(r.id, r.x, r.y, r.o);
    // the caption's text shows over the last of its body's growth (the line itself condenses: ui/type.ts)
    const pr = cap.alive && cap.on ? Math.max(0, Math.min(1, (Math.min(cap.hw / cap.tw, cap.hh / cap.th) - 0.6) / 0.4)) : 0;
    put('cap', cap.x, cap.y, pr, undefined, pr === 0 ? 'visibility:hidden;' : '');
    // a card's text and buttons ride its body, uncovered as the liquid spreads; they take the pointer once it has arrived
    for (const c of sim.cards) {
      const el = c.on ? cardEls.get(c.id) : undefined;
      if (!el) continue;
      const css = rideCss(c);
      if (placed.get(el) !== css) { placed.set(el, css); el.style.cssText = css; }
    }
    // the focus ring: an outline that follows the focused body's shape
    const ring = els.get('ring'), fb = bodyOf(focusId);
    if (ring) {
      const css = fb ? `opacity:1;width:${(2 * fb.rx + 8).toFixed(1)}px;height:${(2 * fb.ry + 8).toFixed(1)}px;transform:translate(${(fb.x - fb.rx - 4).toFixed(1)}px,` +
        `${(fb.y - fb.ry - 4).toFixed(1)}px) rotate(${(fb.ang * 180 / Math.PI).toFixed(1)}deg)` : 'opacity:0';
      if (placed.get(ring) !== css) { placed.set(ring, css); ring.style.cssText = css; }
    }
  }

  // ── what the host lets the mouse reach ──
  const zone = () => ({ x: sim.anchor.x + MAIN_AT.right - view.zone.w, y: sim.anchor.y + MAIN_AT.bottom - view.zone.h, w: view.zone.w, h: view.zone.h });
  function postShapes(now = false): void {
    const t = performance.now();
    if (!now && t - shapesAt < 80) return;       // frames keep coming while anything changes: the next one sends it
    shapesAt = t;
    const z = zone();                             // (with the strip between the open blobs and the caption above them)
    const shapes = [...liquidShapes(sim), ...(hover ? [{ ...z, y: z.y - GAP_LIQUID, h: z.h + GAP_LIQUID }] : [])];
    const key = JSON.stringify(shapes);
    if (key !== shapesKey) { shapesKey = key; host.hit({ shapes }); }
  }

  // ── the cards: bodies that go to where the page laid their text out ──
  function relayout(): void {
    const boxes = on().cards();
    if (boxes.some(b => cardEls.get(b.id) !== b.el)) wake();      // a new element: the next frame places it
    cardEls = new Map(boxes.map(b => [b.id, b.el]));
    const defs = boxes.map(b => ({ id: b.id, x: b.x + b.w / 2, y: b.y + b.h / 2, hw: b.w / 2, hh: b.h / 2 }));
    const key = JSON.stringify(defs);
    if (key === cardsKey) return;
    cardsKey = key;
    setCards(sim, defs);
    wake();
  }

  // ── hover ──
  /** True when the pointer came onto the cluster or left it, or onto another small blob. */
  function look(): boolean {
    const p = sim.pointer, z = zone(), c = sim.cap;
    const hit = seen && !down ? pick(sim, p.x, p.y) : null;
    // the open cluster reaches up to the caption that sits above it, and takes it in: the way there keeps the blobs out
    const inZone = p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y - GAP_LIQUID && p.y <= z.y + z.h;
    const onCap = c.alive && c.on && Math.abs(p.x - c.x) <= c.hw && Math.abs(p.y - c.y) <= c.hh;
    const h = !!down || focusId !== null || (seen && (hit !== null || (hover && (inZone || onCap))));
    const id = hit && hit.id !== 'main' ? hit.id : null;
    canvas.style.cursor = hit || down ? 'pointer' : 'default';
    const changed = id !== overId || h !== hover;
    if (id !== overId) { overId = id; on().over(id); }
    if (h !== hover) { hover = h; on().hover(h); postShapes(true); }
    return changed;
  }
  /** The host keeps the window taking the mouse while a press is held. */
  function hold(k: keyof typeof held, on: boolean): void {
    const was = held.liquid || held.dom;
    held[k] = on;
    if ((held.liquid || held.dom) !== was) host.hit({ capture: !was });
  }
  function left(): void { seen = false; look(); wake(); }

  // ── the pointer ──
  let pend = { x: 0, y: 0 }, flying = false, begin: 'mouse' | 'other' | undefined;
  /** Speak drags the window: the host moves it, and the liquid stays where it was on screen until it catches up. */
  function moveWindow(dx: number, dy: number, start?: 'mouse' | 'other'): void {
    pend.x += dx; pend.y += dy; begin = start ?? begin;
    if (flying || (!begin && !pend.x && !pend.y)) return;
    const d = pend, first = begin;
    pend = { x: 0, y: 0 }; flying = true; begin = undefined;
    host.moveBy(d.x, d.y, first).then(went => { const m = went ?? d; if (m.x || m.y) { shift(sim, -m.x, -m.y); wake(); } }, () => {})
      .finally(() => { flying = false; moveWindow(0, 0); });
  }
  const click = (id: string) => els.get(id)?.querySelector('button')?.click();
  function tap(id: string, sat: Sat | null): void {
    if (!sat || sat.attached) { click(id); return; }
    // a blob that sits apart: two taps send it home, one clicks it (once it is clear no second one comes)
    clearTimeout(tapTimer);
    if (tapTimer && tapId === id) { tapTimer = 0; sendHome(sat); return; }
    tapId = id;
    tapTimer = window.setTimeout(() => { tapTimer = 0; click(id); }, DOUBLE_MS);
  }
  function onDown(e: PointerEvent): void {
    if (e.button !== 0 || down || !e.isPrimary) return;      // one press at a time
    sim.pointer.x = e.clientX; sim.pointer.y = e.clientY; seen = true;
    const hit = pick(sim, e.clientX, e.clientY);
    wake();
    if (!hit) { on().miss(); return; }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the press still works inside the window */ }
    hold('liquid', true);
    down = { pointer: e.pointerId, sx: e.clientX, sy: e.clientY, px: e.screenX, py: e.screenY, target: hit.id, moved: false };
    if ('body' in hit) press(sim, hit.body, e.clientX, e.clientY);
    if (hit.id === 'main') { on().mainDown(); moveWindow(0, 0, e.pointerType === 'mouse' ? 'mouse' : 'other'); }      // the host notes where the cursor is now
    look();
  }
  function onMove(e: PointerEvent): void {
    sim.pointer.x = e.clientX; sim.pointer.y = e.clientY; seen = true;
    clearTimeout(leftTimer);
    if (held.dom && e.buttons === 0) hold('dom', false);      // (a scrollbar's release never arrives as an event)
    if (down && e.pointerId === down.pointer) {
      if (!down.moved && Math.hypot(e.clientX - down.sx, e.clientY - down.sy) > DRAG_PX) {
        down.moved = true;
        pulled(sim);
        if (down.target === 'main') on().mainDrag();
      }
      // from screen coordinates, so it still works while the window itself is moving
      if (down.target === 'main' && down.moved) { moveWindow(e.screenX - down.px, e.screenY - down.py); down.px = e.screenX; down.py = e.screenY; }
    }
    // only a press, or the pointer coming onto something or off it, changes the liquid: else the breath just goes on
    if (look() || down || mode === 'resting') wake(); else lastInput = performance.now();
  }
  /** Ends the press. cancelled: it did not end with a normal release, so it never counts as a tap. */
  function end(cancelled: boolean): void {
    const d = down;
    if (!d) return;
    down = null;
    hold('liquid', false);
    const sat = sim.drag?.sat ?? null;
    release(sim);
    if (d.target === 'main') { if (d.moved) on().mainDragEnd(); else if (cancelled) on().mainCancel(); else on().mainUp(); }
    else if (!d.moved && !cancelled) tap(d.target, sat);
    else on().miss();                              // a pull, a drop: no button was clicked, so nothing gave the keyboard back
    look();
    wake();
  }
  const onUp = (e: PointerEvent) => { if (down && e.pointerId === down.pointer) end(e.type !== 'pointerup'); };
  const onBlur = () => { end(true); hold('dom', false); focusId = null; look(); };
  // A press on a card or the caption (they lie over the canvas) is held too: selecting text or dragging a scrollbar
  // past the card's edge must not turn into a click on the desktop (the host can't see the button everywhere).
  const onDomDown = (e: PointerEvent) => { if ((e.target as Element).closest?.('[data-card], .liq-cap')) hold('dom', true); };
  const onDomUp = () => hold('dom', false);
  const onLeave = () => left();
  const onHidden = () => { if (document.hidden) { stop(); end(true); setMode('paused'); } else wake(); };
  /** The host: the cursor went off Blob's shapes (the window now lets the mouse through), or came back onto them. */
  const onOver = (e: Event) => {
    clearTimeout(leftTimer);
    if (!(e as CustomEvent<boolean>).detail) leftTimer = window.setTimeout(left, LEFT_MS);
  };
  /** The host: where the cursor is on Blob. A macOS window that is not in front hears no pointer moves of its own. */
  const onCursor = (e: Event) => {
    if (down) return;
    const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
    sim.pointer.x = x; sim.pointer.y = y; seen = true;
    if (look()) wake();
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.type === 'focusin' ? (e.target as Element).closest?.('[data-liq]') : null;
    let ring = !!el;
    try { ring = !!el && (e.target as Element).matches(':focus-visible'); } catch { /* an older engine: the ring shows */ }
    focusId = ring ? el!.getAttribute('data-liq') : null;
    look();
    wake();
  };
  /** Escape on a blob that sits apart sends it home, and does nothing else (the page's own Escape never hears it). */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const id = document.activeElement?.closest('[data-liq]')?.getAttribute('data-liq');
    const s = sim.sats.find(x => x.id === id || sim.riders.some(r => r.id === id && r.of === x));
    if (s && !s.attached) { e.preventDefault(); e.stopImmediatePropagation(); sendHome(s); wake(); }
  };
  // The GPU context can be lost (sleep and resume, a driver update, a GPU crash). Stop, then start again when it returns.
  const onLost = (e: Event) => {
    e.preventDefault();
    stop(); renderer = undefined; setMode('paused');
    lostTimer = window.setTimeout(() => on().fail(), LOST_MS);
  };
  const onRestored = () => {
    clearTimeout(lostTimer);
    renderer = createRenderer(canvas);
    if (!renderer) { on().fail(); return; }
    resize();
    wake();
  };

  // ── size: the canvas matches the screen's own pixels (up to MAX_DPR), so nothing is resampled ──
  function resize(): void {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = devicePixelRatio || 1, lim = Math.min(1, MAX_DPR / dpr);
    const cw = Math.max(1, Math.round((devW || w * dpr) * lim)), ch = Math.max(1, Math.round((devH || h * dpr) * lim));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    renderer?.resized(cw / w);
    const at = mainAt(w, h, view);
    place(sim, w, h, at.x, at.y);                  // the window grows up and left: the liquid stays where it is on screen
    relayout();
  }
  const ro = new ResizeObserver(es => {
    const d = es[0].devicePixelContentBoxSize?.[0];
    devW = d ? d.inlineSize : 0; devH = d ? d.blockSize : 0;
    resize();
    if (renderer && !document.hidden) { draw(true); wake(); }     // redraw in the same frame: a resized canvas starts out blank
  });
  try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);     // capture taken away mid-press (alt-tab, the window losing focus)
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  document.addEventListener('pointerdown', onDomDown, true);
  addEventListener('pointerup', onDomUp, true);
  addEventListener('pointercancel', onDomUp, true);
  addEventListener('pointermove', onMove);
  addEventListener('blur', onBlur);
  addEventListener('blob-over', onOver);
  addEventListener('blob-cursor', onCursor);
  addEventListener('focusin', onFocus);
  addEventListener('focusout', onFocus);
  addEventListener('keydown', onKey, true);          // before the page's own Escape
  document.documentElement.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', onHidden);
  resize();
  last = performance.now();
  if (!raf) raf = requestAnimationFrame(frame);    // (a card that is already up has asked for the first frame)

  return {
    relayout,
    sync(v) {
      relayout();
      const key = JSON.stringify(v);
      if (key === viewKey) return;
      const moved = v.padR !== view.padR || v.padB !== view.padB;
      view = v; viewKey = key;
      sim.clear = v.zone.h - MAIN_AT.bottom + GAP_LIQUID;     // the caption sits where the cards start: clear of the open blobs
      setSats(sim, v.sats);
      setCaption(sim, !!v.caption, v.caption?.hw, v.caption?.hh);
      if (moved) resize();
      look();
      wake();
    },
    destroy() {
      stop();
      for (const t of [leftTimer, tapTimer, lostTimer]) clearTimeout(t);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('lostpointercapture', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('pointerdown', onDomDown, true);
      removeEventListener('pointerup', onDomUp, true);
      removeEventListener('pointercancel', onDomUp, true);
      removeEventListener('pointermove', onMove);
      removeEventListener('blur', onBlur);
      removeEventListener('blob-over', onOver);
      removeEventListener('blob-cursor', onCursor);
      removeEventListener('focusin', onFocus);
      removeEventListener('focusout', onFocus);
      removeEventListener('keydown', onKey, true);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onHidden);
      if (down) on().mainCancel();
      host.hit({ shapes: null, capture: false });
    },
  };
}
