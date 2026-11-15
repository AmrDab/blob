// theblob: one blob in the middle; scrolling buds new blobs off it through the goo, each with one line.
import { useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { GOO } from '../src/shared.ts';   // the app's own liquid

const REPO = 'https://github.com/AmrDab/blob';
const LINES = [
  ['A tiny blob on your desktop.', 'Tell it what to do. It does it.'],
  ['Talk or type.', 'Hold it and speak, or type one line.'],
  ['It does it on your computer.', 'Your own Claude thinks. clawdcursor is its hands.'],
  ['It learns your shortcuts.', 'Do a task three times and it becomes one tap.'],
  ['Just ask it to change.', 'No settings menu. It always asks Yes first.'],
  ['Private by design.', 'It reads app names, never screenshots. What it learns stays on your computer.'],
  ['Your phone too.', 'Scan a QR code and ask from your phone.'],
];
const LAST = LINES.length + 1;   // scroll runs 0 (hero) … LAST (how to get it), one step per blob
// Where each blob rests once it is read, as a droplet around the hero: [angle in degrees, size, extra distance].
const DROPS_WIDE = [[-130, 44, 0], [50, 38, 0], [-90, 50, 0], [130, 42, 0], [-50, 36, 0], [90, 46, 0], [-72, 30, 52]];
const DROPS_NARROW = [[-195, 38, 0], [-160, 44, 0], [-125, 38, 0], [-90, 46, 0], [-55, 38, 0], [-20, 42, 0], [15, 38, 0]];

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 → 1 as s goes a → b, eased. */
const span = (s: number, a: number, b: number) => { const t = clamp((s - a) / (b - a)); return t * t * (3 - 2 * t); };

type Box = { x: number; y: number; w: number; h: number; r: number };
const place = (b: Box): CSSProperties =>
  ({ width: b.w, height: b.h, borderRadius: b.r, translate: `${b.x - b.w / 2}px ${b.y - b.h / 2}px` });

/** Every blob's box at scroll step s, in a w × h window. */
function layout(s: number, w: number, h: number) {
  const narrow = w < 760;
  const D = narrow ? 120 : 168;                       // the hero
  const S = narrow ? Math.min(236, w - 48) : 264;     // a blob with a line in it
  const end = span(s, LAST - 0.6, LAST);              // everything flows back into one
  const cx = w / 2;
  const GAP = 44;                                     // between the hero and the blob it is showing
  const cy = narrow ? h / 2 - (GAP + S) / 2 * span(s, 0.1, 0.8) * (1 - end) : h / 2;   // phones: the hero makes room below
  const card = { w: Math.min(440, w - 32), h: 276 };
  const hero: Box = { x: cx, y: cy, w: mix(D, card.w, end), h: mix(D, card.h, end), r: mix(D / 2, 44, end) };
  const blobs = LINES.map((_, k) => {
    const i = k + 1;
    const out = span(s, i - 0.75, i - 0.2);           // buds off the hero
    const back = span(s, i + 0.2, i + 0.7);           // read: shrinks into a droplet
    const side = k % 2 ? -1 : 1;
    const slot = narrow ? { x: side * 12, y: D / 2 + GAP + S / 2 } : { x: side * (D / 2 + GAP + 12 + S / 2), y: side * ((k % 3) - 1) * 28 };
    const [deg, d, far] = (narrow ? DROPS_NARROW : DROPS_WIDE)[k];
    const reach = D / 2 + 30 + d / 2 + far, a = deg * Math.PI / 180;
    const size = mix(mix(40, S, out), d, back);
    const box: Box = {
      x: cx + mix(slot.x * out, Math.cos(a) * reach, back) * (1 - end),
      y: cy + mix(slot.y * out, Math.sin(a) * reach, back) * (1 - end),
      w: size, h: size, r: size / 2,
    };
    return { box, text: span(s, i - 0.4, i - 0.15) * (1 - span(s, i + 0.15, i + 0.35)) };
  });
  return { D, S, hero, blobs, end, card };
}

function useWindow() {
  const read = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return { w: document.documentElement.clientWidth, h: innerHeight, s: max > 0 ? clamp(scrollY / max) * LAST : 0 };
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

function Get() {
  return <>
    <h2>Get it</h2>
    <pre>{`git clone ${REPO}\ncd blob\nnpm install\nnpm start`}</pre>
    <a href={REPO}>GitHub</a>
    <small>Windows first. Needs Node.js 20+.</small>
  </>;
}

const Ring = ({ size, paused }: { size: number; paused?: boolean }) =>
  <VoiceRing size={size} type="mono" theme="light" state="idle" paused={paused} />;

/** Reduced motion: the same blobs, still, one under the other. */
function Calm({ w, h }: { w: number; h: number }) {
  const { D, S, card } = layout(0, w, h);
  const round = (d: number) => ({ width: d, height: d, borderRadius: d / 2 });
  return (
    <Liquid {...GOO} className="goo">
      <Liquid.Item observe>
        <div className="b" style={round(D)}><span className="ring"><Ring size={D * 1.5} paused /></span></div>
      </Liquid.Item>
      <p className="mark">theblob</p>
      {LINES.map(([title, sub], k) => (
        <Liquid.Item observe key={k}>
          <div className="b" style={round(S)}><div className="txt" style={{ width: S * 0.72 }}><h2>{title}</h2><p>{sub}</p></div></div>
        </Liquid.Item>
      ))}
      <Liquid.Item observe>
        <div className="b" style={{ width: card.w, height: card.h, borderRadius: 44 }}><div className="get" style={{ width: card.w - 56 }}><Get /></div></div>
      </Liquid.Item>
    </Liquid>
  );
}

function Site() {
  const { w, h, s } = useWindow();
  const calm = useCalm();
  if (calm) return <div className="calm"><Calm w={w} h={h} /></div>;
  const { D, S, hero, blobs, end, card } = layout(s, w, h);
  return (
    <>
      <div className="stage">
        <Liquid {...GOO} className="goo">
          {LINES.map(([title, sub], k) => (
            <Liquid.Item observe key={k}>
              <div className="b" style={place(blobs[k].box)}><div className="txt" style={{ width: S * 0.72, opacity: blobs[k].text }}><h2>{title}</h2><p>{sub}</p></div></div>
            </Liquid.Item>
          ))}
          <Liquid.Item observe>
            <div className="b hero" style={{ ...place(hero), '--breath': 1 - end } as CSSProperties}>
              <span className="ring" style={{ opacity: 1 - end }}><Ring size={D * 1.5} /></span>
              <div className="get" style={{ width: card.w - 56, opacity: span(end, 0.7, 1), visibility: end > 0.7 ? 'visible' : 'hidden' }}><Get /></div>
            </div>
          </Liquid.Item>
        </Liquid>
      </div>
      <p className="mark" style={{ top: hero.y + D / 2 + 26, opacity: 1 - span(s, 0, 0.35) }}>theblob</p>
      <p className="hint" style={{ opacity: 0.45 * (1 - span(s, 0, 0.2)) }}>scroll</p>
      <div className="track" />
    </>
  );
}

createRoot(document.getElementById('app')!).render(<Site />);
