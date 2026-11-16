// The display type's liquid: a line condenses out of goo and dissolves back into it, and at rest its letters fuse with
// small liquid bridges (one static SVG filter per font size, no per-frame work). Display text only: h1, h2, the wordmark.
const NS = 'http://www.w3.org/2000/svg';
const ease = (p: number) => 1 - Math.pow(1 - p, 3);

type State = { on: boolean; want: boolean; busy: boolean; goo: boolean };
const states = new WeakMap<HTMLElement, State>();
const live = new Set<HTMLElement>();   // lines whose fuse filter follows the (fluid) font size
let defs: SVGDefsElement | null = null;
let fid = 0, rz = 0;

function home(): SVGDefsElement {
  if (defs) return defs;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  defs = document.createElementNS(NS, 'defs');
  svg.append(defs);
  document.body.append(svg);
  // font sizes are fluid, so the static filter is re-picked after a resize: once, not per frame
  addEventListener('resize', () => {
    clearTimeout(rz);
    rz = window.setTimeout(() => {
      for (const el of live) {
        if (!el.isConnected) { live.delete(el); continue; }
        const st = states.get(el);
        if (st?.on && !st.goo) rest(el);
      }
    }, 150);
  });
  return defs;
}

/** How much a line fuses, from its font size: a blur of 0.035em and a soft threshold at 35% coverage. Gaps narrower than
    about 0.065em close into a bridge; the slope keeps the edge about one pixel wide, so it stays antialiased. */
function fuseOf(el: HTMLElement) {
  const px = parseFloat(getComputedStyle(el).fontSize) || 15;
  const sd = Math.max(0.6, px * 0.035);
  return { px, sd, slope: Math.max(2.5, 2.25 * sd), at: 0.35 };
}
/** The alpha row of the colour matrix: alpha' = slope * (alpha - at) + 0.5. */
const alphaRow = (slope: number, at: number) =>
  `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${slope.toFixed(3)} ${(0.5 - slope * at).toFixed(3)}`;

/** blur → alpha row → the sharp glyphs back on top. */
function makeFilter(id: string) {
  const f = document.createElementNS(NS, 'filter');
  f.id = id;
  for (const [k, v] of [['x', '-15%'], ['y', '-100%'], ['width', '130%'], ['height', '300%'], ['color-interpolation-filters', 'sRGB']]) f.setAttribute(k, v);
  const blur = document.createElementNS(NS, 'feGaussianBlur');
  const mat = document.createElementNS(NS, 'feColorMatrix');
  mat.setAttribute('type', 'matrix');
  mat.setAttribute('result', 'goo');
  const merge = document.createElementNS(NS, 'feMerge');
  for (const src of ['goo', 'SourceGraphic']) { const n = document.createElementNS(NS, 'feMergeNode'); n.setAttribute('in', src); merge.append(n); }
  f.append(blur, mat, merge);
  home().append(f);
  return { f, blur, mat };
}

/** A line at rest: the static fuse filter for its font size (made once, never animated). */
function rest(el: HTMLElement) {
  const e = fuseOf(el), id = 'fuse' + Math.round(e.px * 2);
  if (!document.getElementById(id)) {
    const { blur, mat } = makeFilter(id);
    blur.setAttribute('stdDeviation', e.sd.toFixed(2));
    mat.setAttribute('values', alphaRow(e.slope, e.at));
  }
  el.style.filter = `url(#${id})`;
}

/** Ends any word animation still running on the line. */
const still = (el: HTMLElement) => el.getAnimations({ subtree: true }).forEach(a => a.cancel());

/** The liquid part: blur, then an alpha threshold, so nearby strokes merge into goo. k = 1 is all goo; as k falls to 0
    the filter blends to the line's static fuse values, so the last frame equals the rest frame. `reverse` melts the line. */
function goo(el: HTMLElement, st: State, ms: number, reverse: boolean, sd?: number): Promise<void> {
  const size = parseFloat(getComputedStyle(el).fontSize) || 13;
  const s0 = sd ?? Math.min(9, Math.max(2.2, size * 0.2));
  const end = fuseOf(el);
  const { f, blur, mat } = makeFilter('goo' + (++fid));
  const set = (k: number) => {
    blur.setAttribute('stdDeviation', (end.sd + (s0 - end.sd) * k).toFixed(2));
    mat.setAttribute('values', alphaRow(end.slope + (20 - end.slope) * k, end.at + (0.15 - end.at) * k));
  };
  set(reverse ? 0 : 1);
  el.style.filter = `url(#${f.id})`;
  st.goo = true;
  return new Promise(done => {
    const t0 = performance.now();
    const tick = (now: number) => {
      // a run that is no longer wanted (the line scrolled away mid-way, or left the page) ends at once
      const p = el.isConnected && st.want !== reverse ? Math.min(1, (now - t0) / ms) : 1;
      set(reverse ? ease(p) : 1 - ease(p));
      if (p < 1) { requestAnimationFrame(tick); return; }
      if (reverse) el.classList.add('pre');
      st.goo = false;
      rest(el); f.remove(); done();
    };
    requestAnimationFrame(tick);
  });
}

/** A line forms: its words rise out of the goo one after another. The wordmark's two halves bud out of its blob "o". */
function condense(el: HTMLElement, st: State): Promise<void> {
  still(el);
  el.classList.remove('pre');
  const halves = el.querySelectorAll<HTMLElement>(':scope > .g');
  if (halves.length === 2) {
    const o: KeyframeAnimationOptions = { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' };
    halves[0].animate([{ opacity: 0, transform: 'translateX(55%) scale(.3)' }, { opacity: 1, transform: 'none' }], o);
    halves[1].animate([{ opacity: 0, transform: 'translateX(-130%) scale(.3)' }, { opacity: 1, transform: 'none' }], o);
    return goo(el, st, 620, false, Math.min(6, Math.max(2.5, parseFloat(getComputedStyle(el).fontSize) * 0.09)));
  }
  const words = el.querySelectorAll<HTMLElement>('.w');
  const step = Math.min(50, 600 / Math.max(1, words.length));
  words.forEach((w, i) => w.animate(
    [{ opacity: 0, transform: 'translateY(.35em) scale(.55)' }, { opacity: 1, transform: 'none' }],
    { duration: 340, delay: i * step, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
  return goo(el, st, 430 + words.length * step, false);
}
/** A line melts back into the liquid. */
async function dissolve(el: HTMLElement, st: State): Promise<void> {
  still(el);
  const words = el.querySelectorAll<HTMLElement>('.w, :scope > .g');
  const step = Math.min(30, 300 / Math.max(1, words.length));
  const runs = [...words].map((w, i) => w.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate(.5em,.7em) scale(.5)' }],
    { duration: 300, delay: (words.length - 1 - i) * step, easing: 'ease-in', fill: 'forwards' }));
  await goo(el, st, 380 + words.length * step, true);
  runs.forEach(a => a.cancel());
}

/** Show or hide a display line. Hidden lines carry the class "pre" (visibility: hidden) and start that way.
    Latest wins: a change that arrives mid-animation is applied as soon as the current run ends, so nothing is left stale.
    `calm` (prefers-reduced-motion): no motion at all, only the static letterforms. */
export function liquidText(el: HTMLElement, on: boolean, calm: boolean): void {
  const s = states.get(el) ?? { on: false, want: false, busy: false, goo: false };
  states.set(el, s);
  home(); live.add(el);
  s.want = on;
  if (calm) {
    s.on = on;
    el.classList.toggle('pre', !on);
    void document.fonts.ready.then(() => { if (el.isConnected && !s.goo) rest(el); });
    return;
  }
  if (s.busy) return;
  s.busy = true;
  void (async () => {
    await document.fonts.ready;   // words are measured in the real face
    while (s.on !== s.want && el.isConnected) {
      const to = s.want;
      await (to ? condense(el, s) : dissolve(el, s));
      s.on = to;
    }
    s.busy = false;
  })();
}
