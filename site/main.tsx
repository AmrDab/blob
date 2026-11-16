// theblob: one blob in the middle; scrolling buds new blobs off it through the liquid, each with one line.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { GOO } from '../src/shared.ts';   // the app's own liquid
import { startLiquid, type Box, type Scene } from './gl.ts';
import { liquidText } from './type.ts';

const REPO = 'https://github.com/AmrDab/blob';
const LINES = [
  ['A tiny blob on your desktop.', 'Tell it what to do. It does it.'],
  ['Talk or type.', 'Hold it and speak, or type one line.'],
  ['It does it on your computer.', 'Apps, files, the web: it clicks and types for you.'],
  ['It learns your shortcuts.', 'Do a task three times and it becomes one tap.'],
  ['Just ask it to change.', 'No settings menu. It always asks Yes first.'],
  ['Private by design.', 'It learns from app names, never screenshots. That stays on your computer unless you say Yes.'],
  ['Your phone too.', 'Scan a QR code and ask from your phone.'],
];
const LAST = LINES.length + 1;   // scroll runs 0 (hero) … LAST (how to get it), one step per blob
// Where each blob rests once it is read, as a droplet around the hero: [angle in degrees, size, extra distance].
const DROPS_WIDE = [[-110, 46, 0], [110, 40, 0], [180, 54, 0], [-70, 44, 0], [150, 38, 0], [-150, 48, 0], [70, 34, 0]];
const DROPS_NARROW = [[-200, 34, 0], [-162, 42, 0], [-124, 34, 0], [-86, 44, 0], [-48, 34, 0], [-10, 40, 0], [28, 34, 0]];
// The 2D goo's own depth (no WebGL, or reduced motion): light inside the top left edge, shade inside the bottom right, a shadow under.
const SHADOW = 'inset 7px 9px 14px rgba(255,255,255,.95), inset -12px -16px 26px rgba(28,28,30,.13), 16px 26px 44px rgba(28,28,30,.13), 3px 6px 10px rgba(28,28,30,.08)';

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 → 1 as s goes a → b, eased. */
const span = (s: number, a: number, b: number) => { const t = clamp((s - a) / (b - a)); return t * t * (3 - 2 * t); };
const place = (b: Box): CSSProperties =>
  ({ width: b.w, height: b.h, borderRadius: b.r, translate: `${b.x - b.w / 2}px ${b.y - b.h / 2}px` });

/** Every blob's box at scroll step s, in a w × h window. */
function layout(s: number, w: number, h: number) {
  const short = w < 1020 && h < 520 && w > h;         // a phone on its side: side by side like the wide page, sized to the height
  const narrow = w < 1020 && !short;
  const D = short ? 96 : narrow ? 132 : 208;          // the hero
  const S = short ? Math.min(304, h - 40) : narrow ? Math.min(304, w - 36) : 328;   // a blob with a line in it
  const GAP = short ? 24 : narrow ? 40 : 52;          // between the hero and the blob it is showing
  const end = span(s, LAST - 0.6, LAST);              // everything flows back into one
  const settle = span(s, 0.1, 0.8) * (1 - end);       // the hero makes room for the blob it is showing
  const cx = Math.max(w / 2 - (narrow ? 0 : (GAP + S) / 2 * settle), short ? 166 * settle : 0);   // short: the droplets stay clear of the wordmark
  const top = h / 2 - (narrow ? 44 : 56);             // the first screen: the tagline sits under the hero
  const cy = mix(mix(top, narrow ? h / 2 + 18 - (GAP + S) / 2 : h / 2, settle), h / 2, end);
  const card = { w: Math.min(480, w - 28), h: short ? h - 76 : 348 };   // short: from under the bar to the bottom edge
  const hero: Box = { x: cx, y: cy + (short ? 20 : -14) * end, w: mix(D, card.w, end), h: mix(D, card.h, end), r: mix(D / 2, 56, end) };
  const blobs = LINES.map((_, k) => {
    const i = k + 1;
    const out = span(s, i - 0.75, i - 0.2);           // buds off the hero
    const back = span(s, i + 0.2, i + 0.7);           // read: shrinks into a droplet
    const side = k % 2 ? -1 : 1;
    const slot = narrow ? { x: side * 10, y: D / 2 + GAP + S / 2 } : { x: D / 2 + GAP + S / 2, y: short ? 0 : side * ((k % 3) - 1) * 26 };
    const [deg, d, far] = (narrow ? DROPS_NARROW : DROPS_WIDE)[k];
    const reach = D / 2 + 30 + d / 2 + far, a = deg * Math.PI / 180;
    const size = mix(mix(40, S, out), d, back);
    const box: Box = {
      x: cx + mix(slot.x * out, Math.cos(a) * reach, back) * (1 - end),
      y: cy + mix(slot.y * out, Math.sin(a) * reach, back) * (1 - end),
      w: size, h: size, r: size / 2,
    };
    return { box, text: span(s, i - 0.4, i - 0.12) * (1 - span(s, i + 0.12, i + 0.36)) };
  });
  return { D, S, hero, blobs, end, card, top, short };
}

function useWindow() {
  const read = () => {
    // iOS Safari: clientHeight and the track's 100vh steps stay the same while the toolbar slides in and out (innerHeight does not).
    const { clientWidth: w, clientHeight: h, scrollHeight } = document.documentElement;
    return { w, h, s: clamp(scrollY / (scrollHeight * LAST / (LAST + 1))) * LAST };
  };
  const [v, set] = useState(read);
  useEffect(() => {
    let raf = 0;
    const on = () => { raf ||= requestAnimationFrame(() => { raf = 0; set(read()); }); };
    on();
    addEventListener('scroll', on, { passive: true });
    addEventListener('resize', on);
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, []);
  return v;
}

function useCalm() {   // prefers-reduced-motion
  const [mq] = useState(() => matchMedia('(prefers-reduced-motion: reduce)'));
  const [calm, set] = useState(mq.matches);
  useEffect(() => { const on = () => set(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [mq]);
  return calm;
}

/** The mark's artwork, once per page: the wordmark's "o" and every droplet dot reuse it. */
const Defs = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <defs>
      <radialGradient id="mk" cx="36%" cy="30%" r="78%">
        <stop offset="0" stopColor="#f6f6f7" /><stop offset=".5" stopColor="#c9c9cd" /><stop offset="1" stopColor="#77777d" />
      </radialGradient>
    </defs>
    <symbol id="mark" viewBox="0 0 32 32">
      <path fill="url(#mk)" d="M16 2.4c7 0 13.3 4.7 13.6 12.8.3 8.3-5.7 14.4-13.7 14.4C7.9 29.6 2.2 24 2.4 15.8 2.6 7.9 8.6 2.4 16 2.4z" />
      <ellipse cx="11.2" cy="9.8" rx="3.4" ry="2.1" fill="#fff" opacity=".9" transform="rotate(-32 11.2 9.8)" />
    </symbol>
  </svg>
);
/** The logo mark: one small glossy blob. */
const Mark = ({ className }: { className: string }) =>
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true"><use href="#mark" /></svg>;

/** Runs the liquid type on a display line: it condenses when `on` turns true and dissolves when it turns false. */
function useLiquidText<T extends HTMLElement>(on: boolean, calm: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => { if (ref.current) liquidText(ref.current, on, calm); }, [on, calm]);
  return ref;
}
/** The wordmark: the "o" is the blob, and the letters bud out of it. */
function Wordmark({ calm }: { calm: boolean }) {
  const ref = useLiquidText<HTMLSpanElement>(true, calm);
  return (
    <span ref={ref} className={calm ? 'wm' : 'wm pre'} role="img" aria-label="theblob">
      <span className="g">thebl</span><Mark className="mark" /><span className="g">b</span>
    </span>
  );
}
/** A word of display type: the dot of each "i" and a closing full stop are droplets. The page's text stays the plain wording
    (the real letters are kept at no size and the dotless "i" is drawn by CSS), so copying and searching it are unchanged. */
function word(w: string): ReactNode[] {
  const out: ReactNode[] = [];
  const stop = w.endsWith('.');
  (stop ? w.slice(0, -1) : w).split(/(i)/).forEach((part, n) => {
    if (part !== 'i') { if (part) out.push(part); return; }
    out.push(
      <span className="ij" key={n}>
        <span className="ij-p">i</span><span className="ij-d" aria-hidden="true"><i><Mark className="tittle" /></i></span>
      </span>,
    );
  });
  if (stop) out.push(<span className="dot" key="dot">.</span>, <Mark className="drop" key="drop" />);
  return out;
}
/** A line in the display voice (h1, h2): fused letterforms, droplet dots, and the Condensate motion driven by `on`. */
function Display({ as: Tag, text, on, calm, style }: { as: 'h1' | 'h2'; text: string; on: boolean; calm: boolean; style?: CSSProperties }) {
  const ref = useLiquidText<HTMLHeadingElement>(on, calm);
  return (
    <Tag ref={ref} className={calm ? undefined : 'pre'} aria-label={text} style={style}>
      {text.split(' ').map((w, n) => <Fragment key={n}>{n ? ' ' : null}<span className="w">{word(w)}</span></Fragment>)}
    </Tag>
  );
}

const Ring = ({ size, paused }: { size: number; paused?: boolean }) =>
  <VoiceRing size={size} type="mono" theme="light" state="idle" paused={paused} />;
/** One scroll line: the headline condenses and dissolves; the body copy stays plain and only fades. */
const Line = ({ k, on, calm }: { k: number; on: boolean; calm: boolean }) => <>
  <Display as="h2" text={LINES[k][0]} on={on} calm={calm} />
  <p className={on ? undefined : 'off'}>{LINES[k][1]}</p>
</>;
const Bar = ({ calm }: { calm: boolean }) => (
  <header className="bar">
    <a className="logo" href="#" aria-label="theblob, back to the top"><Wordmark calm={calm} /></a>
    <a href={REPO}>GitHub</a>
  </header>
);
const Foot = ({ style }: { style?: CSSProperties }) => (
  <footer className="foot" style={style}>
    <span>Open source, MIT. Windows first.</span>
    <span><a href={REPO}>GitHub</a></span>
  </footer>
);
function Get({ on, calm }: { on: boolean; calm: boolean }) {
  return <>
    <Display as="h2" text="Get theblob" on={on} calm={calm} />
    <pre>{[`git clone ${REPO}`, 'cd blob', 'npm install', 'npm start'].map(c => <span key={c}>{c}</span>)}</pre>{/* one block per command: one that wraps hangs in */}
    <a className="cta" href={REPO}>Open on GitHub</a>
    <small>Needs Node.js 20 or newer.</small>
  </>;
}

/** Reduced motion, or a phone without WebGL: the same blobs, still, one under the other. Nothing merges here, so they are
    plain shapes: a goo filter as tall as this page is over WebKit's size limit on a 3x phone, and draws nothing. */
function Calm({ w, h }: { w: number; h: number }) {
  const { D, S, card } = layout(0, w, h);
  const lit = { background: GOO.fill, boxShadow: SHADOW };
  const round = (d: number) => ({ ...lit, width: d, height: d, borderRadius: d / 2 });
  return (
    <div className="calm">
      <Bar calm />
      <div className="goo">
        <div className="b" style={round(D)}><span className="ring"><Ring size={D * 1.5} paused /></span></div>
        <Display as="h1" text="Say it. It’s done." on calm />
        {LINES.map((_, k) => (
          <div className="b" key={k} style={round(S)}><div className="txt" style={{ width: S * 0.66 }}><Line k={k} on calm /></div></div>
        ))}
        <div className="b" style={{ ...lit, width: card.w, height: card.h, borderRadius: 56 }}><div className="get" style={{ width: card.w - (w < 1020 ? 48 : 64) }}><Get on calm /></div></div>
      </div>
      <Foot />
    </div>
  );
}

function Site() {
  const { w, h, s } = useWindow();
  const [gl, setGl] = useState(() => !new URLSearchParams(location.search).has('goo'));   // ?goo shows the 2D fallback
  const still = useCalm() || (!gl && matchMedia('(pointer: coarse)').matches);   // the moving 2D goo is too slow for a phone
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene>(null!);
  const L = layout(s, w, h);
  scene.current = { hero: L.hero, blobs: L.blobs.map(b => b.box), breath: 1 - L.end };
  useEffect(() => {
    if (still || !gl || !canvas.current) return;
    const stop = startLiquid(canvas.current, () => scene.current);
    if (!stop) setGl(false);   // no WebGL: the 2D goo
    return stop ?? undefined;
  }, [still, gl]);
  if (still) return <><Defs /><Calm w={w} h={h} /></>;

  const { D, S, hero, blobs, end, card, short } = L;
  const items: ReactElement[] = LINES.map((_, k) => {
    return (
      <div className="b" key={k} style={place(blobs[k].box)}>
        <div className="txt" style={{ width: S * 0.66, opacity: clamp(blobs[k].text * 3) }}><Line k={k} on={blobs[k].text > 0.5} calm={false} /></div>
      </div>
    );
  });
  items.push(
    <div className="b hero" key="hero" style={{ ...place(hero), '--breath': 1 - end } as CSSProperties}>
      <span className="ring" style={{ opacity: 1 - end }}><Ring size={D * 1.5} /></span>
      <div className="get" style={{ width: card.w - (w < 1020 ? 48 : 64), opacity: span(end, 0.7, 1), visibility: end > 0.7 ? 'visible' : 'hidden' }}><Get on={end > 0.85} calm={false} /></div>
    </div>,
  );
  return (
    <>
      <Defs />
      <Bar calm={false} />
      <div className={gl ? 'stage' : 'stage flat'}>
        {gl
          ? <div className="goo"><canvas ref={canvas} />{items}</div>
          : <Liquid {...GOO} shadow={SHADOW} className="goo">{items.map(el => <Liquid.Item observe key={el.key}>{el}</Liquid.Item>)}</Liquid>}
        <Display as="h1" text="Say it. It’s done." on={s < 0.18} calm={false} style={{ top: L.top + D / 2 + (w < 1020 ? 34 : 44), opacity: clamp(3 - 3 * span(s, 0, 0.35)) }} />
        <p className="hint" style={{ opacity: 1 - span(s, 0, 0.2) }}>Scroll</p>
        <Foot style={{ opacity: span(end, 0.6, 1), visibility: end > 0.6 && !short ? 'visible' : 'hidden' }} />
      </div>
      <div className="track" />
    </>
  );
}

createRoot(document.getElementById('app')!).render(<Site />);
