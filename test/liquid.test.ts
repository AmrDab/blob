// The liquid bubble's plain parts: the simulation, the frame's shapes, the hit shapes and the click-through decision,
// the stage, and the host's cursor watch (a fake window and a fake cursor; nothing is drawn and no window is touched).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickThrough, follower, type Cursor } from '../src/clickthrough.ts';
import { hits, ignoreNext, inOrder, liquidShapes, parseShapes, pick, type HitShape } from '../src/ui/liquid/hit.ts';
import { K_PILL, PAD_LIQUID, pillScene, pillWindow, setPill } from '../src/ui/liquid/pillscene.ts';
import { clusters, layout } from '../src/ui/liquid/scene.ts';
import { K_BODY, K_CAP, MAIN_R, STEP, arrived, createSim, isActive, place, press, pulled, release, sendHome, setCaption, setCards, setSats, shift, step, type SatDef, type Sim } from '../src/ui/liquid/sim.ts';
import { BOX, FAN, GAP, GAP_LIQUID, MAIN_AT, SLOTS, mainAt, stage } from '../src/ui/liquid/stage.ts';

const FAN3 = (show: boolean): SatDef[] => [
  { id: 'type', r: 20, home: FAN.type, show, live: true, delay: 0 },
  { id: 'log', r: 20, home: FAN.log, show, live: true, delay: 0.04 },
  { id: 'more', r: 20, home: FAN.more, show, live: true, delay: 0.08 },
];
const run = (sim: Sim, seconds: number) => { for (let i = 0; i < seconds / STEP; i++) step(sim, STEP); };
/** A 500 × 420 stage with Speak at (390, 310) and the three small blobs out and settled. */
function open(): Sim {
  const sim = createSim();
  place(sim, 500, 420, 390, 310);
  setSats(sim, FAN3(true));
  run(sim, 3);
  return sim;
}
/** Presses the blob and pulls it to (x, y) over `seconds`. */
function pull(sim: Sim, id: string, x: number, y: number, seconds = 0.6) {
  const s = sim.sats.find(v => v.id === id)!, x0 = s.x, y0 = s.y, n = seconds / STEP;
  press(sim, s, x0, y0);
  pulled(sim);
  for (let i = 1; i <= n; i++) { sim.pointer.x = x0 + (x - x0) * i / n; sim.pointer.y = y0 + (y - y0) * i / n; step(sim, STEP); }
  return s;
}

describe('the liquid simulation', () => {
  it('starts with everything inside Speak, and opens the small blobs onto their slots', () => {
    const sim = createSim();
    place(sim, 500, 420, 390, 310);
    setSats(sim, FAN3(false));
    run(sim, 1);
    expect(sim.main.x).toBeCloseTo(390, 3);
    for (const s of sim.sats) { expect(Math.hypot(s.x - 390, s.y - 310)).toBeLessThan(0.5); expect(s.o).toBeLessThan(0.01); }
    expect(isActive(sim)).toBe(false);
    setSats(sim, FAN3(true));
    expect(isActive(sim)).toBe(true);
    run(sim, 3);
    for (const s of sim.sats) {
      expect(s.x).toBeCloseTo(390 + s.home[0], 1);
      expect(s.y).toBeCloseTo(310 + s.home[1], 1);
      expect(s.o).toBeGreaterThan(0.99);
    }
    expect(sim.openness).toBeGreaterThan(0.99);
    expect(isActive(sim)).toBe(false);          // settled: the page stops drawing at display rate
  });

  it('stays finite and settles after a hard shove (fixed steps of 1/120 s are stable)', () => {
    const sim = open();
    sim.main.vx = 5000; sim.main.vy = -5000;
    run(sim, 6);
    for (const b of [sim.main, ...sim.sats]) for (const v of [b.x, b.y, b.a2c, b.a2s, b.sx, b.sy]) expect(Number.isFinite(v)).toBe(true);
    expect(sim.main.x).toBeCloseTo(390, 1);
    expect(isActive(sim)).toBe(false);
  });

  it('a small pull stays on its strand and flows back when let go', () => {
    const sim = open();
    const s = pull(sim, 'log', 390, 310 - 64 - 50);
    expect(s.attached).toBe(true);
    expect(s.linked).toBe(true);
    expect(layout(sim, 0, 0).strands).toHaveLength(2);      // one half grows out of each end
    release(sim);
    run(sim, 4);
    expect(s.y).toBeCloseTo(310 - 64, 1);
    expect(s.linked).toBe(false);
    expect(layout(sim, 0, 0).strands).toHaveLength(0);
    expect(isActive(sim)).toBe(false);
  });

  it('a long pull snaps the strand; dropped far away the blob stays, and goes home when sent', () => {
    const sim = open();
    const s = pull(sim, 'log', 150, 90, 1);
    run(sim, 0.5);
    expect(s.attached).toBe(false);                          // 110 px past its resting distance: it snapped
    expect(s.linked).toBe(false);
    release(sim);
    run(sim, 3);
    expect(s.x).toBeCloseTo(150, 0);
    expect(s.y).toBeCloseTo(90, 0);
    setSats(sim, FAN3(false));                               // the bubble closes: the others go in, this one stays out
    run(sim, 3);
    expect(s.o).toBeGreaterThan(0.99);
    expect(sim.sats.find(v => v.id === 'type')!.o).toBeLessThan(0.01);
    expect(isActive(sim)).toBe(false);
    sendHome(s);
    run(sim, 4);
    expect(Math.hypot(s.x - 390, s.y - 310)).toBeLessThan(0.5);
    expect(s.attached).toBe(true);
  });

  it('a snapped blob let go near its slot flows back', () => {
    const sim = open();
    const s = pull(sim, 'log', 390, 60, 1);                  // straight up, far past the snap
    expect(s.attached).toBe(false);
    for (let i = 0; i < 120; i++) { sim.pointer.y += (310 - 64 - 30 - sim.pointer.y) * 0.1; step(sim, STEP); }   // and back near the slot
    release(sim);
    expect(s.attached).toBe(true);
    run(sim, 4);
    expect(s.y).toBeCloseTo(310 - 64, 1);
  });

  it('nothing is dropped outside the stage', () => {
    const sim = open();
    const s = pull(sim, 'more', -400, 900, 1);
    run(sim, 0.5);
    release(sim);
    run(sim, 3);
    expect(s.attached).toBe(false);
    expect(s.x).toBeGreaterThanOrEqual(23.9);
    expect(s.y).toBeLessThanOrEqual(420 - 23.9);
  });

  it('the window moving leaves the liquid behind for a moment (it trails), then it catches up', () => {
    const sim = open();
    press(sim, sim.main, 390, 310);
    pulled(sim);
    shift(sim, -40, 0);                                      // the window moved 40 px right
    expect(sim.main.x).toBeCloseTo(350, 3);
    run(sim, 0.05);
    const log = sim.sats.find(v => v.id === 'log')!;
    expect(sim.main.x).toBeGreaterThan(log.x + 5);           // Speak is ahead, the small blob trails
    release(sim);
    run(sim, 4);
    expect(sim.main.x).toBeCloseTo(390, 1);
    expect(log.x).toBeCloseTo(390, 1);
  });

  it('a resized stage moves everything with Speak at once', () => {
    const sim = open();
    const s = pull(sim, 'log', 150, 90, 1);
    run(sim, 0.5); release(sim); run(sim, 3);
    place(sim, 500, 520, 390, 410);                          // the window grew 100 px upwards
    expect(sim.main.y).toBeCloseTo(410, 1);
    expect(s.y).toBeCloseTo(190, 0);
    expect(isActive(sim)).toBe(false);
    place(sim, 320, 230, 262, 176);                          // a small window: the dropped blob is pulled inside
    run(sim, 4);
    expect(s.x).toBeGreaterThanOrEqual(23.9);
    expect(s.x).toBeLessThanOrEqual(320 - 23.9);
  });

  it('the caption buds out of Speak to its size above the cluster, and is drawn back in', () => {
    const sim = open();
    sim.clear = BOX[0].h - 46;
    setCaption(sim, true, 80, 20);
    expect(sim.cap.x).toBeCloseTo(390, 0);                   // it starts as a drop at Speak's centre
    run(sim, 3);
    expect(sim.cap.hw).toBeCloseTo(80, 1);
    expect(sim.cap.hh).toBeCloseTo(20, 1);
    expect(sim.cap.y + sim.cap.hh).toBeCloseTo(310 - (BOX[0].h - 46), 0);   // its bottom clears the open blobs
    setSats(sim, FAN3(false));
    run(sim, 3);
    expect(sim.cap.y + sim.cap.hh).toBeCloseTo(310 - MAIN_R - 14, 0);       // closed: just above Speak
    setCaption(sim, false);
    run(sim, 3);
    expect(sim.cap.alive).toBe(false);
    expect(isActive(sim)).toBe(false);
  });

  it('a shortcut that loses its slot comes home, and its remove-x rides on it while browsing', () => {
    const sim = open();
    const pin = (live: boolean, browse: boolean): SatDef => ({ id: 's:a', r: 18, home: live ? SLOTS[0] : [0, 0], show: live, live, delay: 0,
      rider: { id: 'x:a', dx: 14, dy: -14, r: 8, show: browse } });
    setSats(sim, [...FAN3(true), pin(true, true)]);
    run(sim, 3);
    const s = sim.sats.find(v => v.id === 's:a')!, x = sim.riders[0];
    expect(x.x).toBeCloseTo(s.x + 14, 1);
    expect(pick(sim, x.x, x.y)).toMatchObject({ id: 'x:a' });
    pull(sim, 's:a', 100, 100, 1); run(sim, 0.5); release(sim); run(sim, 2);
    expect(s.attached).toBe(false);
    setSats(sim, [...FAN3(true), pin(false, false)]);        // unpinned while it sat apart
    run(sim, 4);
    expect(s.attached).toBe(true);
    expect(Math.hypot(s.x - 390, s.y - 310)).toBeLessThan(0.5);
    expect(sim.riders[0].o).toBeLessThan(0.01);
  });
});

describe("the frame's shapes", () => {
  it('breathing swells the radius and keeps the shape; a closed blob is not drawn', () => {
    const sim = createSim();
    place(sim, 500, 420, 390, 310);
    setSats(sim, FAN3(false));
    run(sim, 1);
    const still = layout(sim, 1.2, 0), full = layout(sim, 1.2, 1);
    expect(still.shapes).toHaveLength(1);
    expect(still.shapes[0]).toMatchObject({ rx: MAIN_R, ry: MAIN_R, group: 0 });
    expect(full.shapes[0].rx).toBeCloseTo(MAIN_R * 1.03, 2);  // a quarter of the 4.8 s breath: the fullest
    expect(full.shapes[0].rx).toBe(full.shapes[0].ry);
  });

  it('draws Speak with what is joined to it in one box, and a blob that sits apart in its own', () => {
    const sim = open();
    expect(clusters(layout(sim, 0, 0), 40)).toHaveLength(1);
    pull(sim, 'log', 80, 60, 1); run(sim, 0.5); release(sim); run(sim, 3);
    const cl = clusters(layout(sim, 0, 0), 40);
    expect(cl).toHaveLength(2);
    expect(cl[0].groups).toEqual([0]);
    expect(cl[0].x1 - cl[0].x0).toBeLessThan(160);           // the cost follows the liquid, not the window
    expect(cl[1].x1 - cl[1].x0).toBeLessThan(50);
    sim.sats.find(v => v.id === 'log')!.dropx = 330;         // dropped close by: the shadows' room overlaps, one box
    sim.sats.find(v => v.id === 'log')!.dropy = 150;
    run(sim, 4);
    expect(clusters(layout(sim, 0, 0), 40)).toHaveLength(1);
  });
});

// A question laid out above the cluster's box in the 500 × 420 stage, and the Type box under it.
const ASK = { id: 'ask:1', x: 268, y: 150, hw: 172, hh: 40 }, TYPE = { id: 'type', x: 268, y: 181, hw: 172, hh: 16 };

describe('the cards', () => {
  it('a card buds out of Speak to where its text is laid out, and takes no click until it has arrived', () => {
    const sim = open();
    setCards(sim, [ASK]);
    const c = sim.cards[0];
    expect([c.x, c.y, c.hw, c.hh]).toEqual([390, 310, 5, 5]);            // a drop at Speak's centre
    expect(arrived(c)).toBe(false);
    run(sim, 0.1);
    const neck = layout(sim, 0, 0).strands;                              // on its way: a neck from each side to the middle
    expect(neck).toHaveLength(2);
    expect(neck[0].rt).toBeGreaterThan(1.5);
    expect(neck[0].rt).toBeLessThan(neck[0].rb);
    expect(Math.hypot(neck[0].ax - 390, neck[0].ay - 310)).toBeLessThan(MAIN_R);       // one end in Speak
    expect(Math.abs(neck[1].ay - (c.y + c.hh))).toBeLessThan(0.01);                    // the other on the card's edge
    expect(arrived(c)).toBe(false);
    expect(liquidShapes(sim).some(s => 'w' in s && s.w > 20)).toBe(true); // the window already takes the mouse there
    run(sim, 2);
    expect(arrived(c)).toBe(true);
    expect(c.x).toBeCloseTo(268, 1); expect(c.y).toBeCloseTo(150, 1);
    expect(c.hw).toBeCloseTo(172, 1); expect(c.hh).toBeCloseTo(40, 1);
    expect(liquidShapes(sim)).toContainEqual({ x: 96, y: 110, w: 344, h: 80, c: 18 });
    expect(isActive(sim)).toBe(false);                                   // nothing to draw any more
    expect(layout(sim, 0, 0).strands).toEqual([]);                       // at rest it sits apart: no neck
  });

  it('never swings far past its size on the way (there is text on it)', () => {
    const sim = open();
    setCards(sim, [ASK]);
    let widest = 0;
    for (let i = 0; i < 2 / STEP; i++) { step(sim, STEP); widest = Math.max(widest, sim.cards[0].hw); }
    expect(widest).toBeLessThan(172 * 1.02);
  });

  it('a card that moves keeps its body and is not clickable on the way; one that closes flows back into Speak', () => {
    const sim = open();
    setCards(sim, [ASK]);
    run(sim, 2);
    const ask = sim.cards[0];
    setCards(sim, [{ ...ASK, y: 112 }, TYPE]);                            // the Type box opens under it: the question moves up
    expect(sim.cards.find(c => c.id === 'ask:1')).toBe(ask);
    run(sim, 0.05);
    expect(arrived(ask)).toBe(false);
    expect(layout(sim, 0, 0).strands.filter(n => n.ax < 200 || n.ay < 150)).toEqual([]);   // no neck to a card that only moves (the Type box has one: it is budding)
    run(sim, 2);
    expect(arrived(ask)).toBe(true);
    expect(ask.y).toBeCloseTo(112, 1);
    setCards(sim, [TYPE]);                                               // answered
    expect(ask.on).toBe(false);
    expect(arrived(ask)).toBe(false);
    expect(liquidShapes(sim).filter(s => 'w' in s)).toHaveLength(1);     // only the Type box takes the mouse now
    run(sim, 0.15);
    expect(sim.cards).toContain(ask);                                    // still liquid, on its way back
    expect(ask.y).toBeGreaterThan(112);
    let necks = 0;
    for (let i = 0; i < 2 / STEP; i++) { step(sim, STEP); necks = Math.max(necks, layout(sim, 0, 0).strands.length); }
    expect(necks).toBe(2);                                               // drawn in through a neck
    expect(sim.cards.map(c => c.id)).toEqual(['type']);
    expect(isActive(sim)).toBe(false);
  });

  it('a card that comes back while its old body is still flowing home buds again', () => {
    const sim = open();
    setCards(sim, [ASK]);
    run(sim, 2);
    setCards(sim, []);
    run(sim, 0.05);
    setCards(sim, [ASK]);
    expect(sim.cards).toHaveLength(2);
    expect(sim.cards.filter(c => c.on)).toHaveLength(1);
    run(sim, 3);
    expect(sim.cards).toHaveLength(1);
    expect(arrived(sim.cards[0])).toBe(true);
  });

  it('stays where it is on screen when the window grows, and trails when the window is dragged', () => {
    const sim = open();
    setCards(sim, [ASK]);
    run(sim, 2);
    place(sim, 500, 520, 390, 410);                                      // 100 px taller: everything is 100 px lower in it
    const c = sim.cards[0];
    expect(c.y).toBeCloseTo(250, 1);
    expect(arrived(c)).toBe(true);
    shift(sim, -30, 0);                                                  // the window moved 30 px right
    expect(c.x).toBeCloseTo(238, 1);
    expect(arrived(c)).toBe(false);
    run(sim, 2);
    expect(c.x).toBeCloseTo(268, 1);
  });

  it('is a rounded box in the liquid joined to Speak, and the resting ripple leaves it out', () => {
    const sim = open();
    expect(clusters(layout(sim, 0, 0), 40)[0].core).toBeUndefined();     // no cards: as before
    setCards(sim, [ASK, TYPE]);
    run(sim, 2);
    const scene = layout(sim, 0, 0), cards = scene.shapes.filter(s => s.card);
    expect(cards).toHaveLength(2);
    for (const s of cards) expect(s).toMatchObject({ group: 0, k: K_CAP });
    expect(cards[0]).toMatchObject({ rx: expect.closeTo(172, 1), ry: expect.closeTo(40, 1), corner: 18 });
    expect(cards[1].corner).toBeCloseTo(16, 1);                          // a low card: a pill
    const [c] = clusters(scene, 40);
    expect(c.y0).toBeLessThan(112);                                      // drawn with Speak, in one box
    expect(c.core!.y0).toBeGreaterThan(310 - 64 - 20 - 10);              // the ripple's box: Speak and its small blobs only
    expect(c.core!.x1 - c.core!.x0).toBeLessThan(160);
  });

  it('rests fused to the card next to it, and clear of the open blobs and remove buttons under it', () => {
    const fused = (gap: number, k: number) => gap / 2 - k / 4;           // the liquid's edge half way between two bodies; the ripple adds up to 2
    expect(fused(GAP, K_CAP)).toBeLessThan(-2);
    for (const [i, box] of BOX.entries()) {
      const top = [[0, -64 - 20], [0, -118 - 14 - 8], [0, -166 - 14 - 8]][i][1];   // Log; a remove-x on the inner arc's top blob; on the outer's
      const cardsBottom = -(box.h - MAIN_AT.bottom) - GAP_LIQUID;
      expect(fused(top - cardsBottom, K_BODY)).toBeGreaterThan(2);
    }
  });
});

describe('hit shapes', () => {
  const shapes: HitShape[] = [{ x: 100, y: 100, r: 28 }, { x: 10, y: 10, w: 60, h: 30, c: 15 }];

  it('a point is on a circle or a rounded box, with a few px of margin', () => {
    expect(hits(shapes, 100, 100)).toBe(true);
    expect(hits(shapes, 131, 100)).toBe(true);               // 3 px outside the edge: the ripple's margin
    expect(hits(shapes, 133, 100)).toBe(false);
    expect(hits(shapes, 40, 25)).toBe(true);
    expect(hits(shapes, 11, 11, 0)).toBe(false);             // the rounded corner is not the box
    expect(hits(shapes, 11, 25, 0)).toBe(true);
    expect(hits(shapes, 200, 200)).toBe(false);
    expect(hits([], 0, 0)).toBe(false);
  });

  it('the window ignores the mouse only off every shape, never during a press, and not without shapes', () => {
    const on = { shapes, capture: false, x: 100, y: 100 }, off = { ...on, x: 300, y: 300 };
    expect(ignoreNext(false, on)).toBe(false);
    expect(ignoreNext(true, on)).toBe(false);
    expect(ignoreNext(false, off)).toBe(true);
    expect(ignoreNext(false, { ...off, capture: true })).toBe(false);    // the page holds a press: a drag never falls through
    expect(ignoreNext(true, { ...off, capture: true })).toBe(false);
    expect(ignoreNext(false, { ...off, down: true })).toBe(false);       // a button is down: nothing changes mid-drag
    expect(ignoreNext(true, { ...on, down: true })).toBe(true);          // a drag across the desktop is not taken over
    expect(ignoreNext(true, { ...off, shapes: null })).toBe(false);      // no shapes: today's window, every click is Blob's
  });

  it('what the page posts reaches the host in the order it was posted, however long each takes', async () => {
    const got: number[] = [];
    // the first takes longest, the second fails: sent side by side they would arrive 3, 1
    const send = inOrder((n: number) => new Promise<void>((ok, no) => setTimeout(() => { if (n === 2) no(new Error('lost')); else { got.push(n); ok(); } }, 30 - n * 10)));
    send(1); send(2); send(3);
    await new Promise(ok => setTimeout(ok, 80));
    expect(got).toEqual([1, 3]);
  });

  it('only a well-formed list from the page counts', () => {
    expect(parseShapes([{ x: 1, y: 2, r: 3 }, { x: 1, y: 2, w: 3, h: 4 }])).toEqual([{ x: 1, y: 2, r: 3 }, { x: 1, y: 2, w: 3, h: 4, c: 0 }]);
    expect(parseShapes([])).toEqual([]);
    for (const bad of [null, undefined, 'x', {}, [{ x: 1, y: 2 }], [{ x: '1', y: 2, r: 3 }], [{ x: 1, y: NaN, r: 3 }], [{ x: 1, y: 2, r: -1 }], [null],
      [{ x: 1e9, y: 2, r: 3 }], Array.from({ length: 65 }, () => ({ x: 1, y: 2, r: 3 }))]) expect(parseShapes(bad)).toBeNull();
  });

  it("the liquid's shapes are the bodies that are out: never the shadow, never a closed blob", () => {
    const sim = createSim();
    place(sim, 500, 420, 390, 310);
    setSats(sim, FAN3(false));
    run(sim, 1);
    expect(liquidShapes(sim)).toEqual([{ x: 390, y: 310, r: MAIN_R }]);
    setSats(sim, FAN3(true));
    setCaption(sim, true, 80, 20);
    run(sim, 3);
    const out = liquidShapes(sim);
    expect(out).toHaveLength(5);
    expect(out).toContainEqual({ x: 390, y: 246, r: 20 });
    expect(out[4]).toMatchObject({ w: 160, h: 40, c: 18 });
    expect(hits(out, 390 + MAIN_R + 12, 310 + 20)).toBe(false);          // where the shadow falls
  });

  it('the pointer picks the nearest small blob that is out, then Speak, else nothing', () => {
    const sim = open();
    layout(sim, 0, 0);
    expect(pick(sim, 390, 246)).toMatchObject({ id: 'log' });
    expect(pick(sim, 392, 312)).toMatchObject({ id: 'main' });
    expect(pick(sim, 200, 200)).toBeNull();
    setSats(sim, FAN3(false));
    run(sim, 2);
    expect(pick(sim, 390, 300)).toMatchObject({ id: 'main' });           // the closed ones inside Speak are not picked
  });
});

describe('the stage', () => {
  it('without click-through (or without the liquid) the window is as small as it always was', () => {
    expect(stage({ roomy: false, big: false, arcs: 0, cardsH: 0 })).toEqual({ w: 320, h: 230, padR: 8, padB: 8, cardsW: 304 });
    expect(stage({ roomy: false, big: true, arcs: 2, cardsH: 300 })).toEqual({ w: 360, h: 556, padR: 8, padB: 8, cardsW: 344 });
  });

  it('with click-through it has room to pull a blob out past its snapping point, and fits the cards', () => {
    const s = stage({ roomy: true, big: false, arcs: 0, cardsH: 0 }), at = mainAt(s.w, s.h, s);
    expect(s).toMatchObject({ w: 500, h: 420, cardsW: 304 });
    expect(at).toEqual({ x: 390, y: 310 });
    expect(Math.min(at.x, at.y)).toBeGreaterThan(64 + 110 + 20 + 24);    // resting distance + snap + the blob + the edge
    const tall = stage({ roomy: true, big: true, arcs: 2, cardsH: 400 });
    expect(tall.h).toBe(400 + 22 + BOX[2].h + 56);
    expect(tall.cardsW).toBe(344);
    expect(tall.h).toBeLessThanOrEqual(760);                             // the host's limit
    expect(stage({ roomy: true, big: true, arcs: 2, cardsH: 400, gap: GAP_LIQUID }).h).toBe(tall.h + GAP_LIQUID - GAP);   // the lit liquid's wider gap
  });

  it('keeps the small blobs of the fan and of the arcs apart at rest', () => {
    const fan = Object.values(FAN);
    for (const a of fan) for (const b of fan) if (a !== b) expect(Math.hypot(a[0] - b[0], a[1] - b[1]) - 40).toBeGreaterThan(8);
    for (let i = 1; i < 5; i++) expect(Math.hypot(SLOTS[i][0] - SLOTS[i - 1][0], SLOTS[i][1] - SLOTS[i - 1][1]) - 36).toBeGreaterThan(8);
  });
});

describe("the host's cursor watch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  // a window at (1000, 500) physical px on a 2x screen, 500 x 420 CSS px
  function fake() {
    const calls: boolean[] = [], over: boolean[] = [];
    let gone = 0;
    const cursor: Cursor = { x: 0, y: 0, down: false };
    const win = {
      getPosition: () => ({ x: 1000, y: 500 }), getInnerSize: () => ({ width: 500, height: 420 }), scaleFactor: () => 2,
      setIgnoreCursorEvents: (v: boolean) => { calls.push(v); }, getCursorPosition: () => ({ x: 0, y: 0 }),
    };
    const ct = clickThrough(win, { over: on => over.push(on), gone: () => gone++ }, () => ({ ...cursor }));
    return { ct, calls, over, cursor, gone: () => gone };
  }
  const main = [{ x: 390, y: 310, r: 28 }];

  it('does nothing until the page sends shapes, then follows the cursor on and off them', () => {
    const { ct, calls, over, cursor } = fake();
    expect(ct.available).toBe(true);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
    ct.set({ shapes: main });                                // the cursor is at the screen's corner: off Blob
    expect(calls).toEqual([true]);
    expect(over).toEqual([false]);
    cursor.x = 1000 + 390 * 2; cursor.y = 500 + 310 * 2;     // onto Speak (physical px)
    vi.advanceTimersByTime(110);
    expect(calls).toEqual([true, false]);
    expect(over).toEqual([false, true]);
    cursor.x += 80;                                          // 40 CSS px right: off it
    vi.advanceTimersByTime(30);
    expect(calls).toEqual([true, false, true]);
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(3);                           // only changes reach the window
    ct.stop();
  });

  it('never ignores while the page holds a press, and changes nothing while a button is down', () => {
    const { ct, calls, cursor } = fake();
    cursor.x = 1780; cursor.y = 1120;
    ct.set({ shapes: main });
    expect(calls).toEqual([]);                               // on Speak from the start
    ct.set({ capture: true });
    cursor.x = 0;                                            // dragged far off the shapes
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([]);
    ct.set({ capture: false });
    cursor.down = true;                                      // the page let go, the button is still down
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([]);
    cursor.down = false;
    vi.advanceTimersByTime(150);
    expect(calls).toEqual([true]);
    ct.set({ capture: true });                               // a press is told at once, not at the next look
    expect(calls).toEqual([true, false]);
    ct.stop();
  });

  it('takes every click again when the page has no shapes, or sends something else', () => {
    const { ct, calls } = fake();
    ct.set({ shapes: main });
    ct.set({ shapes: null });
    expect(calls).toEqual([true, false]);
    vi.advanceTimersByTime(500);
    ct.set({ shapes: [{ x: 'no' }] });
    ct.set('junk');
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([true, false]);
    ct.stop();
  });

  it('without a way to read the cursor, or with a window that refuses, there is no click-through', () => {
    const calls: boolean[] = [];
    let gone = 0;
    const base = { getPosition: () => ({ x: 0, y: 0 }), getInnerSize: () => ({ width: 500, height: 420 }), scaleFactor: () => 1, getCursorPosition: () => ({ x: 0, y: 0 }) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const none = clickThrough({ ...base, setIgnoreCursorEvents: v => { calls.push(v); } }, { over() {}, gone: () => gone++ }, undefined);
    expect(none.available).toBe(false);
    none.set({ shapes: main });
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
    const refuses = clickThrough({ ...base, setIgnoreCursorEvents: v => { if (v) throw new Error('no'); calls.push(v); } }, { over() {}, gone: () => gone++ }, () => ({ x: 900, y: 900 }));
    refuses.set({ shapes: main });
    expect(refuses.available).toBe(false);
    expect(gone).toBe(1);
    expect(calls).toEqual([false]);
    refuses.set({ shapes: main });
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([false]);
    log.mockRestore();
  });
});

describe('a drag of the window', () => {
  // a window at (1000, 500) physical px on a 1.5x screen
  function fake(read: (() => Cursor) | undefined) {
    const at = { x: 1000, y: 500 };
    const win = { getPosition: () => ({ ...at }), setPosition: (x: number, y: number) => { at.x = x; at.y = y; }, scaleFactor: () => 1.5 };
    return { at, f: follower(win, read) };
  }
  it('follows the cursor in physical px, and answers in the CSS px of the window', () => {
    const cursor: Cursor = { x: 300, y: 300, down: true };
    const { at, f } = fake(() => ({ ...cursor }));
    f.start();
    expect(f.move()).toEqual({ dx: 0, dy: 0 });
    cursor.x = 330; cursor.y = 285;
    expect(f.move()).toEqual({ dx: 20, dy: -10 });
    expect(at).toEqual({ x: 1030, y: 485 });
    at.x -= 40;                                    // the window was resized meanwhile: it is not pulled back
    cursor.x = 331;
    f.move();
    expect(at).toEqual({ x: 991, y: 485 });
  });
  it('moves nothing before a press begins, or once the button is up', () => {
    const cursor: Cursor = { x: 300, y: 300, down: true };
    const { at, f } = fake(() => ({ ...cursor }));
    expect(f.move()).toBeUndefined();
    f.start();
    cursor.x = 400; cursor.down = false;
    expect(f.move()).toEqual({ dx: 0, dy: 0 });
    expect(at).toEqual({ x: 1000, y: 500 });
    f.stop();                                      // a finger's press: the page's numbers move the window
    expect(f.move()).toBeUndefined();
  });
  it('leaves it to the page where the cursor cannot be read', () => {
    const none = fake(undefined);
    none.f.start();
    expect(none.f.move()).toBeUndefined();
    const broken = fake(() => { throw new Error('no'); });
    broken.f.start();
    expect(broken.f.move()).toBeUndefined();
  });
});

describe('the pill', () => {
  // the running pill as the page lays it out in a 344 px window: the orb, the line, Stop, 4 px apart, 10 px from the top
  const RUNNING = [
    { id: 'orb', x: 40, y: 28, hw: 18, hh: 18 },
    { id: 'core', x: 162, y: 28, hw: 100, hh: 17.5 },
    { id: 'stop', x: 293, y: 28, hw: 27, hh: 18 },
  ];
  const PAUSED = [
    { id: 'core', x: 202, y: 47.5, hw: 180, hh: 37.5 },
    { id: 'c0', x: 150, y: 113.5, hw: 49, hh: 16.5 },
    { id: 'c1', x: 260, y: 113.5, hw: 55, hh: 16.5 },
    { id: 'acts', x: 202, y: 162.5, hw: 180, hh: 20.5 },
  ];
  const up = () => { const sim = createSim(); setPill(sim, RUNNING); run(sim, 2); return sim; };

  it('asks for a window with room for its shadow, the same on both sides and no more above than the 2D pill', () => {
    expect(pillWindow(300, 36, false)).toEqual({ w: 320, h: 56 });
    expect(pillWindow(300, 36, true)).toEqual({ w: 300 + 2 * PAD_LIQUID.side, h: 36 + PAD_LIQUID.top + PAD_LIQUID.bottom });
    expect(PAD_LIQUID.top).toBe(10);                                     // the pill stays where it was on screen
    expect(pillWindow(360, 600, true).w).toBeLessThanOrEqual(520);       // the widest card still fits the host's limit
  });

  it('buds out of where its line will be, and comes to rest on the page\'s boxes', () => {
    const sim = createSim();
    setPill(sim, RUNNING);
    for (const c of sim.cards) expect([c.x, c.y, c.hw, c.hh]).toEqual([162, 28, 5, 5]);
    expect(isActive(sim)).toBe(true);
    run(sim, 2);
    expect(isActive(sim)).toBe(false);                                   // nothing moves: no display-rate frames
    expect(sim.cards.every(arrived)).toBe(true);
    const { shapes, strands } = pillScene(sim);
    expect(strands).toEqual([]);
    expect(shapes.map(s => s.corner)).toEqual([0, expect.closeTo(17.5, 1), expect.closeTo(18, 1)]);   // a ball, two capsules
    expect(shapes.every(s => s.k === K_PILL && s.group === 0 && !s.card)).toBe(true);
    shapes.forEach((s, i) => { expect(s.x).toBeCloseTo(RUNNING[i].x, 0); expect(s.rx).toBeCloseTo(RUNNING[i].hw, 0); });
    // 4 px apart they join (the blend reaches K / 4 from each side), 12 px apart they would not
    expect(K_PILL / 4).toBeGreaterThan(2);
    expect(K_PILL / 4 + 2).toBeLessThan(6);                              // ... even with the ripple's 2 px
  });

  it('paused: the orb and Stop flow back into the line, which grows into the card; its choices and buttons bud out of it', () => {
    const sim = up();
    setPill(sim, PAUSED);
    const core = sim.cards.find(c => c.id === 'core')!, c0 = sim.cards.find(c => c.id === 'c0')!;
    expect([c0.x, c0.y, c0.hw]).toEqual([sim.main.x, sim.main.y, 5]);    // from the pill's middle
    expect(Math.hypot(c0.x - 162, c0.y - 28)).toBeLessThan(1);
    expect(sim.cards.filter(c => !c.on).map(c => c.id)).toEqual(['orb', 'stop']);
    expect(arrived(core)).toBe(false);                                   // the same body, on its way: no click lands yet
    run(sim, 2);
    expect(sim.cards.map(c => c.id)).toEqual(['core', 'c0', 'c1', 'acts']);
    expect(sim.cards.every(arrived)).toBe(true);
    expect(isActive(sim)).toBe(false);
    expect([core.hw, core.hh].map(Math.round)).toEqual([180, 38]);
    const scene = pillScene(sim);
    expect(scene.shapes.map(s => !!s.card)).toEqual([false, true, true, true]);
    const cl = clusters(scene, 40)[0];                                   // the resting ripple redraws the card only
    expect(cl.core!.y1).toBeLessThan(PAUSED[1].y - PAUSED[1].hh);
    expect(cl.y1).toBeGreaterThan(PAUSED[3].y);
  });

  it('resumed: the choices and buttons flow back into the pill, and the orb and Stop bud out again', () => {
    const sim = up();
    setPill(sim, PAUSED);
    run(sim, 2);
    setPill(sim, RUNNING);
    run(sim, 0.1);
    const acts = sim.cards.find(c => c.id === 'acts')!;
    expect(acts.on).toBe(false);
    expect(acts.y).toBeLessThan(160);                                    // on its way up into the pill
    run(sim, 2);
    expect(sim.cards.map(c => c.id).sort()).toEqual(['core', 'orb', 'stop']);
    expect(sim.cards.every(arrived)).toBe(true);
  });

  it('stays where it is on screen when its window grows around it', () => {
    const sim = up();
    place(sim, 344, 82, sim.anchor.x, sim.anchor.y);
    place(sim, 404, 240, sim.anchor.x + 30, sim.anchor.y);               // 60 px wider, centred: the layout moves 30 px right
    setPill(sim, RUNNING.map(d => ({ ...d, x: d.x + 30 })));
    expect(isActive(sim)).toBe(false);                                   // already there: nothing springs across
    expect(sim.cards.find(c => c.id === 'orb')!.x).toBeCloseTo(70, 0);
  });
});
