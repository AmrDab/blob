// clawdcursor's pill, drawn by Blob in its own small window (main.ts): the same liquid group as the bubble.
// Running: an orb, what the agent is doing, and Stop. Paused: it morphs into the "waiting for you" card.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { ThinkingOrb } from 'thinking-orbs';
import type { PillAnswer, PillState } from '../pill.ts';
import { GOO } from '../shared.ts';

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-token': TOKEN }, body: JSON.stringify(body) });
const answer = (a: PillAnswer) => void post('/pill/answer', a);
const keyboard = (on: boolean) => void post('/pill/keyboard', { on });
const PAD = 10;          // .pill-root's padding: room for the liquid's edge
const MORPH_MS = 600;    // the window shrinks only after the liquid has

function Pill() {
  const [state, setState] = useState<PillState | null>(null);
  const [typing, setTyping] = useState(false);   // "Something else": the reply box in place of the buttons
  const [text, setText] = useState('');
  const group = useRef<HTMLDivElement>(null);
  const sized = useRef({ w: 0, h: 0, timer: 0 });

  useEffect(() => {
    const es = new EventSource(`/pill-events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = m => {
      const next: PillState | null = JSON.parse(m.data).state;
      setState(next);
      if (next?.mode !== 'running') { setTyping(false); setText(''); }   // a new card, or none
    };
    return () => es.close();
  }, []);

  // The window is as big as the liquid group plus its padding: grow at once, shrink once the morph is over.
  function fit() {
    const el = group.current, s = sized.current;
    if (!el) return;
    const w = el.offsetWidth + 2 * PAD, h = el.offsetHeight + 2 * PAD;
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
  }, [!state]);

  if (!state) return null;
  const paused = state.mode === 'paused' ? state : null;
  const input = paused?.input ?? null;
  const send = () => { if (text.trim()) answer({ kind: 'reply', text }); };
  function keys(e: KeyboardEvent) {
    if (e.key === 'Enter' && (!input?.multiline || e.ctrlKey)) { e.preventDefault(); send(); }   // a longer answer: Enter adds a line
    if (e.key !== 'Escape') return;
    if (!input) { setText(''); setTyping(false); }   // "Something else" closes; a card's own box stays, with what was typed
    (e.target as HTMLElement).blur();
    keyboard(false);
  }
  const box = { value: text, placeholder: input?.placeholder ?? 'Type your answer…', onKeyDown: keys, onPointerDown: () => keyboard(true) };

  return (
    <div className="pill-root">
      <Liquid {...GOO} className="pill" ref={group}>
        <div className="pill-row" onDoubleClick={paused ? undefined : () => answer({ kind: 'stop' })}>
          {!paused && (
            <Liquid.Item observe>
              <div className="card orb"><ThinkingOrb state="working" size={20} theme="light" /></div>
            </Liquid.Item>
          )}
          <Liquid.Item morph={{ shape: true }}>
            <div className={paused ? 'card wait' : 'card activity'}>
              {paused ? <>
                <div className="title">Waiting for you{paused.app ? ` · ${paused.app}` : ''}</div>
                <div className="message">{paused.message}</div>
              </> : state.mode === 'running' && state.activity}
            </div>
          </Liquid.Item>
          {!paused && (
            <Liquid.Item observe>
              <button className="card chip stop" onClick={() => answer({ kind: 'stop' })}>Stop</button>
            </Liquid.Item>
          )}
        </div>
        {paused && paused.choices.length > 0 && (
          <div className="choices">
            {paused.choices.map((c, i) => (
              <Liquid.Item observe key={i}>
                <button className="card chip choice" onClick={() => answer({ kind: 'choice', index: i })}>{c}</button>
              </Liquid.Item>
            ))}
          </div>
        )}
        {paused && (
          <Liquid.Item observe>
            <div className="card acts">
              {(input || typing) && (
                <div className="reply">
                  {input?.multiline
                    ? <textarea {...box} onChange={e => setText(e.target.value)} />
                    : <input {...box} autoFocus={typing} onChange={e => setText(e.target.value)} />}
                  <button className="btn strong" onClick={send}>Send</button>
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
          </Liquid.Item>
        )}
      </Liquid>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<Pill />);
