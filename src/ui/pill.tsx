// clawdcursor's pill, drawn by Blob in its own small window (main.ts): the same liquid as the bubble (the lit WebGL
// one; with reduced motion, or no usable GPU, the 2D liquid-gooey group).
// Running: an orb, what the agent is doing, and Stop. Paused: it morphs into the "waiting for you" card.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { ThinkingOrb } from 'thinking-orbs';
import type { PillAnswer, PillState } from '../pill.ts';
import { GOO } from '../shared.ts';
import { startPill, type PillEngine } from './liquid/pillengine.ts';
import { PAD_LIQUID, pillWindow } from './liquid/pillscene.ts';
import { useSettled } from './settle.ts';
import { Title, Words, useSwap } from './text.tsx';

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-token': TOKEN }, body: JSON.stringify(body) });
const send = (a: PillAnswer) => void post('/pill/answer', a);
const keyboard = (on: boolean) => void post('/pill/keyboard', { on });
const MORPH_MS = 600;    // the window shrinks only after the liquid has
const CALM = matchMedia('(prefers-reduced-motion: reduce)');

/** The lit liquid under the pill: a canvas over the whole window that draws a body for every [data-card] in the
    group, each where the page laid it out (the group is their offset parent). The text and buttons stay DOM. */
function PillLiquid({ group, fail }: { group: RefObject<HTMLDivElement>; fail: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), engine = useRef<PillEngine>();
  useEffect(() => {
    const el = group.current!;
    const e = startPill(canvas.current!, () => {
      const o = el.getBoundingClientRect();
      return [...el.querySelectorAll<HTMLElement>('[data-card]')].map(c =>
        ({ id: c.dataset.card!, el: c, x: o.left + c.offsetLeft, y: o.top + c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
    }, fail);
    if (!e) { fail(); return; }
    engine.current = e;
    const ro = new ResizeObserver(() => e.relayout());     // a font that loads, a line that changes
    ro.observe(el);
    return () => { ro.disconnect(); e.destroy(); engine.current = undefined; };
  }, []);
  useEffect(() => engine.current?.relayout());
  return <canvas className="liq pill-liq" ref={canvas} />;
}
/** In the lit liquid a body needs no wrapper: the canvas draws it from its element's box. */
const Bare = ({ children }: { children: ReactNode; observe?: boolean; morph?: { shape: boolean } }) => <>{children}</>;

function Pill() {
  const [state, setState] = useState<PillState | null>(null);
  const [typing, setTyping] = useState(false);   // "Something else": the reply box in place of the buttons
  const [text, setText] = useState('');
  const group = useRef<HTMLDivElement>(null);
  const sized = useRef({ w: 0, h: 0, timer: 0 });
  const [gl, setGl] = useState(!CALM.matches);
  const gpuGone = useRef(false);

  useEffect(() => {
    const es = new EventSource(`/pill-events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = m => {
      const next: PillState | null = JSON.parse(m.data).state;
      setState(next);
      if (next?.mode !== 'running') { setTyping(false); setText(''); }   // a new card, or none
    };
    const calm = () => setGl(!CALM.matches && !gpuGone.current);
    CALM.addEventListener('change', calm);
    return () => { es.close(); CALM.removeEventListener('change', calm); };
  }, []);

  // The window is as big as the liquid group plus its padding (pillWindow): grow at once, shrink once the morph is over.
  function fit() {
    const el = group.current, s = sized.current;
    if (!el) return;
    const { w, h } = pillWindow(el.offsetWidth, el.offsetHeight, gl);
    if (w === s.w && h === s.h) return;
    const shrinks = w < s.w || h < s.h;
    s.w = w; s.h = h;
    clearTimeout(s.timer);
    s.timer = window.setTimeout(() => void post('/pill/size', { w: s.w, h: s.h }), shrinks ? MORPH_MS : 0);
  }
  useLayoutEffect(fit);
  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!state, gl]);

  // The card that just took the pill's place takes no click for a moment: one meant for Stop must not pick a choice.
  const settled = useSettled(state?.mode === 'paused' ? state.message : state?.mode);
  const answer = (a: PillAnswer) => { if (settled()) send(a); };
  // What the agent is doing, in Blob's voice: a new line condenses out of goo and the one before it dissolves.
  const [line, lineRef] = useSwap<HTMLSpanElement>(state?.mode === 'running' ? { id: state.activity, node: <Words text={state.activity} /> } : null);
  if (!state) return null;
  const paused = state.mode === 'paused' ? state : null;
  const input = paused?.input ?? null;
  const reply = () => { if (text.trim()) answer({ kind: 'reply', text }); };
  function keys(e: KeyboardEvent) {
    if (e.key === 'Enter' && (!input?.multiline || e.ctrlKey)) { e.preventDefault(); reply(); }   // a longer answer: Enter adds a line
    if (e.key !== 'Escape') return;
    if (!input) { setText(''); setTyping(false); }   // "Something else" closes; a card's own box stays, with what was typed
    (e.target as HTMLElement).blur();
    keyboard(false);
  }
  const box = { value: text, placeholder: input?.placeholder ?? 'Type your answer…', onKeyDown: keys, onPointerDown: () => keyboard(true) };

  const Item = gl ? Bare : Liquid.Item;
  const body = <>
        <div className="pill-row" onDoubleClick={paused ? undefined : () => answer({ kind: 'stop' })}>
          {!paused && (
            <Item observe>
              <div className="card orb" data-card="orb"><ThinkingOrb state="working" size={20} theme="light" /></div>
            </Item>
          )}
          <Item morph={{ shape: true }}>
            <div className={paused ? 'card wait' : 'card activity'} data-card="core">
              {paused ? <>
                <Title text={`Waiting for you${paused.app ? ` · ${paused.app}` : ''}`} />
                <div className="message bv">{paused.message}</div>
              </> : line && <span ref={lineRef} className="pill-line bv">{line.node}</span>}
            </div>
          </Item>
          {!paused && (
            <Item observe>
              <button className="card chip stop" data-card="stop" onClick={() => answer({ kind: 'stop' })}>Stop</button>
            </Item>
          )}
        </div>
        {paused && paused.choices.length > 0 && (
          <div className="choices">
            {paused.choices.map((c, i) => (
              <Item observe key={i}>
                <button className="card chip choice" data-card={`c${i}`} onClick={() => answer({ kind: 'choice', index: i })}>{c}</button>
              </Item>
            ))}
          </div>
        )}
        {paused && (
          <Item observe>
            <div className="card acts" data-card="acts">
              {(input || typing) && (
                <div className="reply">
                  {input?.multiline
                    ? <textarea {...box} onChange={e => setText(e.target.value)} />
                    : <input {...box} autoFocus={typing} onChange={e => setText(e.target.value)} />}
                  <button className="btn strong" onClick={reply}>Send</button>
                </div>
              )}
              {input && <div className="note">Don't type passwords here.{input.multiline ? ' Ctrl+Enter sends.' : ''}</div>}
              {!typing && (
                <div className="row">
                  {!input && <button className="btn else" onClick={() => { setTyping(true); keyboard(true); }}>Something else…</button>}
                  <button className="btn" onClick={() => answer({ kind: 'end' })}>End task</button>
                  <button className={paused.choices.length ? 'btn' : 'btn strong'} onClick={() => answer({ kind: 'resume' })}>Resume</button>
                </div>
              )}
            </div>
          </Item>
        )}
  </>;
  return gl ? (
    <div className="pill-root" style={{ padding: `${PAD_LIQUID.top}px ${PAD_LIQUID.side}px ${PAD_LIQUID.bottom}px` }}>
      <PillLiquid group={group} fail={() => { gpuGone.current = true; setGl(false); }} />
      <div className="pill gl" ref={group}>{body}</div>
    </div>
  ) : (
    <div className="pill-root">
      <Liquid {...GOO} className="pill" ref={group}>{body}</Liquid>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<Pill />);
