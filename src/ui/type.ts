// Blob's type. Two voices: Fraunces for what Blob says (captions, card titles, the pill's line), Geist for everything
// else, Geist Mono for a command shown word for word. A new line condenses out of goo and the old one dissolves back
// into it (about half a second, then plain DOM text with no filter). Card titles keep their letters fused at rest
// (one static SVG filter per font size) and carry droplet dots. Body text, buttons and commands never animate.
// The first half of this file is plain logic (tested in test/type.test.ts); the second half touches the DOM.

/** A line's words and the spaces between them; a word with a digit in it is a number (set in Geist, tabular). */
export function tokens(text: string): { text: string; space: boolean; num: boolean }[] {
  return text.split(/(\s+)/).filter(Boolean).map(t => ({ text: t, space: /^\s+$/.test(t), num: /\d/.test(t) }));
}

/** A display word around each "i" (its dot is drawn as a droplet), and whether it closes with a full stop (also one). */
export function letters(word: string): { parts: string[]; stop: boolean } {
  const stop = word.length > 1 && word.endsWith('.') && !word.endsWith('..');
  return { parts: (stop ? word.slice(0, -1) : word).split(/(i)/).filter(Boolean), stop };
}

/**
 * A command, line by line, each line in pieces that it may wrap between: after a path separator. A line wraps at its
 * spaces first, then between these pieces, and inside a piece only when that piece alone is wider than the box.
 * Joined back (pieces with nothing, lines with a newline) it is the command, character for character.
 */
export const commandLines = (text: string): string[][] =>
  text.split('\n').map(line => line.match(/[^\\/]*[\\/]+|[^\\/]+/g) ?? ['']);

export type Fuse = { sd: number; slope: number; at: number };
/** No filter at all: blur 0 and the alpha row "1 0" pass the text through untouched. */
export const PLAIN: Fuse = { sd: 0, slope: 1, at: 0.5 };
/** How much a title fuses, from its font size: a blur of 0.035em and a soft threshold at 35% coverage. Gaps narrower
    than about 0.065em close into a bridge; the slope keeps the edge about one pixel wide, so it stays antialiased. */
export function fuseOf(px: number): Fuse {
  const sd = Math.max(0.6, px * 0.035);
  return { sd, slope: Math.max(2.5, 2.25 * sd), at: 0.35 };
}
/** The goo's blur at its fullest, from the font size. */
export const gooBlur = (px: number) => Math.min(9, Math.max(2.2, px * 0.2));
/** The filter at k (1 = all goo: alpha * 20 - 2.5; 0 = the line at rest), so the last frame equals the rest frame and
    antialiased edges are never cut hard. */
export const gooAt = (k: number, s0: number, end: Fuse): Fuse =>
  ({ sd: end.sd + (s0 - end.sd) * k, slope: end.slope + (20 - end.slope) * k, at: end.at + (0.15 - end.at) * k });
/** The colour matrix whose alpha row is alpha' = slope * (alpha - at) + 0.5. */
export const alphaRow = (f: Fuse) =>
  `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${f.slope.toFixed(3)} ${(0.5 - f.slope * f.at).toFixed(3)}`;

/**
 * One line at a time, latest wins: the line on screen goes (`hide`), the newest one wanted at that moment is put in its
 * place (`show`) and forms (`form`). A line that arrives meanwhile waits; only lines replaced before they could be
 * shown are skipped, so the last one asked for is always the one left on screen.
 */
export function swapper<L>(io: {
  same(a: L | null, b: L | null): boolean;
  hide(old: L, next: L | null): Promise<void>; show(next: L | null): Promise<void>; form(next: L): Promise<void>;
}): (next: L | null) => Promise<void> {
  let shown: L | null = null, want: L | null = null, busy = false;
  return async next => {
    want = next;
    if (busy) return;
    busy = true;
    try {
      while (!io.same(shown, want)) {
        if (shown !== null) await io.hide(shown, want);
        const to = want;
        shown = to;
        await io.show(to);
        if (to !== null) await io.form(to);
      }
    } finally { busy = false; }
  };
}

// ── the DOM half ──

const NS = 'http://www.w3.org/2000/svg';
const ease = (p: number) => 1 - Math.pow(1 - p, 3);
let defs: SVGDefsElement | null = null;
let fid = 0;
const runs = new WeakMap<HTMLElement, number>();   // the newest goo run on each line: an older one leaves it alone

function home(): SVGDefsElement {
  if (defs) return defs;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  defs = document.createElementNS(NS, 'defs');
  svg.append(defs);
  document.body.append(svg);
  return defs;
}

/** blur → alpha row (→ the sharp glyphs back on top, when `merge`). */
function makeFilter(id: string, merge: boolean) {
  const f = document.createElementNS(NS, 'filter');
  f.id = id;
  for (const [k, v] of [['x', '-15%'], ['y', '-100%'], ['width', '130%'], ['height', '300%'], ['color-interpolation-filters', 'sRGB']]) f.setAttribute(k, v);
  const blur = document.createElementNS(NS, 'feGaussianBlur');
  const mat = document.createElementNS(NS, 'feColorMatrix');
  mat.setAttribute('type', 'matrix');
  f.append(blur, mat);
  if (merge) {
    mat.setAttribute('result', 'goo');
    const m = document.createElementNS(NS, 'feMerge');
    for (const src of ['goo', 'SourceGraphic']) { const n = document.createElementNS(NS, 'feMergeNode'); n.setAttribute('in', src); m.append(n); }
    f.append(m);
  }
  home().append(f);
  return { f, blur, mat };
}
const sizeOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).fontSize) || 13;

/** A line at rest: the static fuse filter for its font size on a title (made once, never animated), no filter at all
    on anything else. */
export function rest(el: HTMLElement, fused: boolean): void {
  if (!fused) { el.style.filter = ''; return; }
  const px = sizeOf(el), id = 'fuse' + Math.round(px * 2);
  if (!document.getElementById(id)) {
    const { blur, mat } = makeFilter(id, true);
    const e = fuseOf(px);
    blur.setAttribute('stdDeviation', e.sd.toFixed(2));
    mat.setAttribute('values', alphaRow(e));
  }
  el.style.filter = `url(#${id})`;
}

/** The liquid part: blur, then an alpha threshold, so nearby strokes merge into goo. `reverse` melts the line, and
    leaves it hidden. It ends by itself even if no frame comes (a window that is not drawn). */
function goo(el: HTMLElement, ms: number, reverse: boolean, fused: boolean): Promise<void> {
  const px = sizeOf(el), s0 = gooBlur(px), end = fused ? fuseOf(px) : PLAIN;
  const { f, blur, mat } = makeFilter('goo' + (++fid), fused);
  const set = (k: number) => {
    const at = gooAt(k, s0, end);
    blur.setAttribute('stdDeviation', at.sd.toFixed(2));
    mat.setAttribute('values', alphaRow(at));
  };
  const mine = fid;
  runs.set(el, mine);
  set(reverse ? 0 : 1);
  el.style.filter = `url(#${f.id})`;
  return new Promise(done => {
    const t0 = performance.now();
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      clearTimeout(guard);
      if (runs.get(el) === mine) {
        if (reverse) el.style.visibility = 'hidden';
        rest(el, fused);
      }
      f.remove();
      done();
    };
    const tick = (now: number) => {
      if (over) return;
      const p = el.isConnected && runs.get(el) === mine ? Math.min(1, (now - t0) / ms) : 1;
      set(reverse ? ease(p) : 1 - ease(p));
      if (p < 1) requestAnimationFrame(tick); else finish();
    };
    const guard = setTimeout(finish, ms + 300);
    requestAnimationFrame(tick);
  });
}

/** Ends any word animation still running on the line. */
const still = (el: HTMLElement) => el.getAnimations({ subtree: true }).forEach(a => a.cancel());

/** A line forms: its words (.w) rise out of the goo one after another. */
export function condense(el: HTMLElement, fused = false): Promise<void> {
  still(el);
  el.style.visibility = '';
  const words = el.querySelectorAll<HTMLElement>('.w');
  const step = Math.min(40, 120 / Math.max(1, words.length));
  words.forEach((w, i) => w.animate(
    [{ opacity: 0, transform: 'translateY(.35em) scale(.55)' }, { opacity: 1, transform: 'none' }],
    { duration: 300, delay: i * step, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
  return goo(el, 380 + words.length * step, false, fused);
}

/** A line melts back toward the bubble (down and to the right), and stays hidden. */
export async function dissolve(el: HTMLElement, fused = false): Promise<void> {
  still(el);
  const words = [...el.querySelectorAll<HTMLElement>('.w')];
  const step = Math.min(25, 100 / Math.max(1, words.length));
  const out = words.map((w, i) => w.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate(.5em,.7em) scale(.5)' }],
    { duration: 300, delay: (words.length - 1 - i) * step, easing: 'ease-in', fill: 'forwards' }));
  await goo(el, 350 + words.length * step, true, fused);
  out.forEach(a => a.cancel());
}

/** With reduced motion, or for a line that does not animate: it is simply there, with a short fade when `fade`. */
export function settle(el: HTMLElement, fused = false, fade = false): void {
  still(el);
  runs.delete(el);
  el.style.visibility = '';
  rest(el, fused);
  if (fade) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
}
