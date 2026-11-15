import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { ThinkingOrb } from 'thinking-orbs';
import { BorderBeam } from 'border-beam';
import type { Model } from '../brain.ts';
import { formatLog, type LogRow } from '../log.ts';
import { ICONS, MAX_PINNED } from '../shared.ts';
import { Icon } from './icons.tsx';
import { DOWNLOAD_MB, Recorder, isDownloaded, load, transcribe } from './speech.ts';

declare global { interface Window { webviewjs?: { startDragging(): void } } }

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-token': TOKEN }, body: JSON.stringify(body) });
/** Gives the keyboard back to the window the user was in before clicking the bubble. */
const back = () => void post('/focus-back');

const MODELS: Model[] = ['sonnet', 'haiku', 'default'];
const LABEL: Record<Model, string> = { sonnet: 'Sonnet', haiku: 'Haiku', default: 'Default' };
const T = { duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
const GOO = { blur: 13.5, contrast: 40, fill: '#e9e9e9', waviness: 8 };
const HOLD_MS = 350;   // a press longer than this is press-and-hold; shorter is a tap (tap again to finish)
const STILL_MS = 150;  // a press that stays still this long starts the mic
const DRAG_PX = 4;     // a press that moves further than this drags the window instead
const RING = 84;       // the voice ring: Speak's face (its loops fill about 40% of the canvas, which overhangs the blob)

// Shortcut blobs sit on arcs around Speak, from straight left to straight up: 5 on the inner one, 7 more on the outer.
const arc = (r: number, n: number) => Array.from({ length: n }, (_, i) => {
  const a = Math.PI + (i * Math.PI) / 2 / (n - 1);
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))] as const;
});
const SLOTS = [...arc(118, MAX_PINNED), ...arc(166, 7)];
// The cluster's box for 0, 1 or 2 arcs in use (Speak's centre stays 50 px from the right and 46 px from the bottom).
const BOX = [{ w: 150, h: 140 }, { w: 192, h: 186 }, { w: 240, h: 234 }];

type Phase = 'idle' | 'ask' | 'downloading' | 'recording' | 'transcribing';
type ShortcutInfo = { id: string; name: string; icon: string; pinned: boolean };
type Offer = { name: string } | { why: string } | null;
type Check = { id: string; ok: boolean; label: string; fix: string };

const Keys = () => <svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="6" width="18" height="12" rx="2.5" fill="none" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" fill="none" /></svg>;
const List = () => <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" fill="none" /></svg>;

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* below */ }
  const t = document.createElement('textarea');
  t.value = text;
  document.body.appendChild(t);
  t.select();
  const ok = document.execCommand('copy');
  t.remove();
  return ok;
}

function App() {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [hint, setHint] = useState<string | null>(null);     // a shortcut blob's name, while hovered
  const [rows, setRows] = useState<LogRow[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutInfo[]>([]);
  const [offer, setOffer] = useState<Offer>(null);
  const [offerName, setOfferName] = useState('');
  const [offerIcon, setOfferIcon] = useState<string>(ICONS[0]);
  const [asks, setAsks] = useState<{ id: string; question: string }[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [micProblem, setMicProblem] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);            // the + view: every saved shortcut, to pin or remove
  const [model, setModel] = useState<Model>('sonnet');
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [text, setText] = useState('');
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const rec = useRef<{ recorder: Recorder } | null>(null);
  const press = useRef<{ x: number; y: number; t: number; timer: number; started: Promise<boolean> | null; wasRecording: boolean } | null>(null);
  const dragging = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = m => {
      const e = JSON.parse(m.data);
      if (e.type === 'caption') setCaption(e.text);
      if (e.type === 'busy') setBusy(e.busy);
      if (e.type === 'row') setRows(r => [...r, e.row]);
      if (e.type === 'shortcuts') setShortcuts(e.list);
      if (e.type === 'setup') setChecks(e.checks);
      if (e.type === 'ask') setAsks(a => [...a, { id: e.id, question: e.question }]);
      if (e.type === 'ask-done') setAsks(a => a.filter(x => x.id !== e.id));
      if (e.type === 'offer') {
        setOffer(e.offer);
        if (e.offer?.name) { setOfferName(e.offer.name); setOfferIcon(ICONS[0]); }
      }
    };
    return () => es.close();
  }, []);

  const failing = checks.filter(c => !c.ok);
  const big = typeOpen || logOpen || !!offer || asks.length > 0 || failing.length > 0 || !!micProblem;
  const arcs = browsing ? (shortcuts.length > MAX_PINNED ? 2 : 1) : shortcuts.some(s => s.pinned) ? 1 : 0;
  const box = BOX[arcs];
  // The window is as tall as the cards need (at least room for a three-line caption) plus the bubble's box.
  const [cardsH, setCardsH] = useState(0);
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCardsH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    void post('/size', { w: Math.max(big ? 360 : 320, box.w + 16), h: Math.max(90, cardsH + 22) + box.h });
  }, [big, box, cardsH]);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [rows, logOpen]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTypeOpen(false); setLogOpen(false); setBrowsing(false);
      back();
    };
    // After a window drag (Speak, or the empty space around it) the next plain move hands the keyboard back.
    const moved = (e: PointerEvent) => { if (dragging.current && e.buttons === 0) { dragging.current = false; back(); } };
    addEventListener('keydown', esc);
    addEventListener('pointermove', moved);
    return () => { removeEventListener('keydown', esc); removeEventListener('pointermove', moved); };
  }, []);
  useEffect(() => { if (!shortcuts.length) setBrowsing(false); }, [shortcuts]);

  // ── Speak: a still press talks (hold, or tap and tap again), a moving press drags the window ──
  async function begin(): Promise<boolean> {
    if (!(await isDownloaded())) { setPhase('ask'); return false; }
    const recorder = new Recorder();
    try { await recorder.start(); } catch (err) {
      const name = (err as Error).name;
      setMicProblem(name === 'NotFoundError' ? 'No microphone found. Plug one in, then try Speak again.' : `Pronto can't use the microphone (${(err as Error).message}).`);
      return false;
    }
    setMicProblem(null);
    rec.current = { recorder };
    setMicStream(recorder.stream ?? null);
    setPhase('recording');
    setCaption('Listening…');
    void post('/prewarm', { model });               // Claude starts while the user is still talking
    void load(() => {});                            // and Whisper loads from the cache
    return true;
  }

  /** Stops the mic without sending anything (the press became a drag). */
  function discard() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    void r.recorder.stop().catch(() => {});
    setMicStream(null);
    setPhase('idle');
    setCaption('');
    void post('/cancel');
  }

  async function finish() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setMicStream(null);
    setPhase('transcribing');
    setCaption('Transcribing…');
    try {
      const audio = await r.recorder.stop();
      const said = audio.length > 16000 * 0.3 ? await transcribe(audio) : '';
      if (!said) { setCaption("Didn't catch that."); void post('/cancel'); }
      else { setCaption(said); void post('/run', { text: said, model }); }
    } catch (err) {
      setCaption(`Speech: ${(err as Error).message}`);
      void post('/cancel');
    }
    setPhase('idle');
  }

  function speakDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = { x: e.screenX, y: e.screenY, t: Date.now(), timer: 0, started: null as Promise<boolean> | null, wasRecording: !!rec.current };
    const canStart = !busy && !p.wasRecording && (phase === 'idle' || phase === 'ask');
    if (canStart) p.timer = window.setTimeout(() => { if (press.current === p) p.started = begin(); }, STILL_MS);
    press.current = p;
  }

  function speakMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const p = press.current;
    if (!p || Math.hypot(e.screenX - p.x, e.screenY - p.y) <= DRAG_PX) return;
    clearTimeout(p.timer);
    press.current = null;
    if (p.started) void p.started.then(ok => { if (ok) discard(); });
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragging.current = true;
    window.webviewjs?.startDragging();
  }

  function speakUp() {
    const p = press.current;
    if (!p) return;
    press.current = null;
    clearTimeout(p.timer);
    if (p.started) {
      // This press started the mic: a long press was hold-to-talk, a short one starts tap-to-talk.
      if (Date.now() - p.t > HOLD_MS) void p.started.then(ok => { if (ok) void finish(); });
    } else if (p.wasRecording) void finish();          // the second tap
    else if (busy) setCaption('Still working on the last request.');
    else if (phase === 'idle' || phase === 'ask') void begin();   // a quick tap
    back();
  }

  function speakCancel() {
    const p = press.current;
    press.current = null;
    if (p) clearTimeout(p.timer);
  }

  async function download() {
    setPhase('downloading');
    setPercent(0);
    try {
      await load(setPercent);
      setCaption('Speech is ready. Hold the bubble and talk, or tap to start and tap to stop.');
    } catch (err) {
      setCaption(`Download failed: ${(err as Error).message}`);
    }
    setPhase('idle');
    back();
  }

  function send() {
    const t = text.trim();
    if (!t) return;
    if (busy) { setCaption('Still working on the last request.'); return; }
    void post('/run', { text: t, model });          // the host hands the keyboard back
    setText('');
    setTypeOpen(false);
  }

  async function copyLog() {
    setCaption((await copyText(formatLog(rows))) ? 'Log copied.' : 'Could not copy the log.');
    back();
  }

  function clickShortcut(s: ShortcutInfo) {
    if (browsing) void post('/shortcut/pin', { id: s.id, pinned: !s.pinned });
    else void post('/shortcut/run', { id: s.id });   // the host hands the keyboard back first
    if (browsing) back();
  }

  const open = hover || busy || phase === 'recording' || browsing;
  const pinned = shortcuts.filter(s => s.pinned);
  // While Pronto works only the orb shows: no step-by-step text on the bubble (the Log has it).
  const shown = !busy && (caption || phase === 'ask' || phase === 'downloading');
  return (
    <div className="root" data-webview-drag-region="deep"
      onPointerDown={e => { if (!(e.target as Element).closest('button, input, .log')) dragging.current = true; }}>
      <Liquid {...GOO} className="cards" ref={cardsRef}>
        {logOpen && (
          <Liquid.Item observe>
            <div className="card log" data-webview-drag-region="false">
              <button className="btn copy" onClick={() => void copyLog()}>Copy</button>
              {rows.length === 0 && <div className="empty">No calls yet.</div>}
              {rows.map((r, i) => r.kind === 'request' ? <div key={i} className="req">› {r.text}</div>
                : r.kind === 'answer' ? <div key={i} className="ans">{r.text}</div>
                : <div key={i} className={`call ${r.outcome}`} title={r.line}><b>{r.tool}{r.action ? ` · ${r.action}` : ''}</b> <span>{r.line}</span></div>)}
              <div ref={logEnd} />
            </div>
          </Liquid.Item>
        )}
        {(failing.length > 0 || micProblem) && (
          <Liquid.Item observe>
            <div className="card setup">
              <div className="title">Before Pronto can work</div>
              {failing.map(c => (
                <div key={c.id} className="check">
                  {c.label}: <button className="cmd" title="Click to copy, then run it in a terminal"
                    onClick={() => void copyText(c.fix).then(ok => { if (ok) setCaption(`Copied: ${c.fix}`); back(); })}>{c.fix}</button>
                </div>
              ))}
              {micProblem && (
                <div className="check">{micProblem} <button className="btn" onClick={() => { setMicProblem(null); void post('/setup/mic'); }}>Microphone settings</button></div>
              )}
              {failing.length > 0 && <div className="row"><button className="btn" onClick={() => void post('/setup/check')}>Check again</button></div>}
            </div>
          </Liquid.Item>
        )}
        {asks.slice(0, 1).map(a => (
          <Liquid.Item observe key={a.id}>
            <div className="card ask">
              <div>{a.question}</div>
              <div className="row">
                <button className="btn" onClick={() => void post('/answer', { id: a.id, yes: false })}>No</button>
                <button className="btn strong" onClick={() => void post('/answer', { id: a.id, yes: true })}>Yes</button>
              </div>
            </div>
          </Liquid.Item>
        ))}
        {offer && (
          <Liquid.Item observe>
            {'why' in offer ? (
              <div className="card offer">
                <div>{offer.why}</div>
                <div className="row"><button className="btn" onClick={() => void post('/offer/dismiss')}>OK</button></div>
              </div>
            ) : (
              <div className="card offer">
                <div className="title">Save as a shortcut?</div>
                <input value={offerName} maxLength={60} onChange={e => setOfferName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void post('/offer/save', { name: offerName, icon: offerIcon }); }} />
                <div className="icons">
                  {ICONS.map(i => (
                    <button key={i} className={`pick${i === offerIcon ? ' on' : ''}`} aria-label={i} onClick={() => setOfferIcon(i)}><Icon name={i} size={16} /></button>
                  ))}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => void post('/offer/dismiss')}>Not now</button>
                  <button className="btn strong" onClick={() => void post('/offer/save', { name: offerName, icon: offerIcon })}>Save</button>
                </div>
              </div>
            )}
          </Liquid.Item>
        )}
        {typeOpen && (
          <div className="type-row">
            <Liquid.Item observe>
              <div className="card type">
                <input autoFocus value={text} placeholder="Ask clawdcursor…" onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') send(); }} />
              </div>
            </Liquid.Item>
            <Liquid.Item observe>
              <button className="card chip" title="Model" onClick={() => setModel(MODELS[(MODELS.indexOf(model) + 1) % MODELS.length])}>{LABEL[model]}</button>
            </Liquid.Item>
          </div>
        )}
        {(hint || shown) && (
          <Liquid.Item observe>
            <div className="card caption" title={hint ?? caption}>
              {hint ?? (phase === 'ask'
                ? <>Speech needs a one-time download (~{DOWNLOAD_MB} MB). <button className="link" onClick={() => void download()}>Download</button></>
                : phase === 'downloading' ? `Downloading speech… ${percent}%` : caption)}
            </div>
          </Liquid.Item>
        )}
      </Liquid>

      <div className="goo-box" style={{ width: box.w, height: box.h }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setHint(null); }}>
        <Liquid {...GOO} className="goo" style={{ width: box.w, height: box.h }}>
          <Liquid.Item className="it-small" x={open ? -54 : 0} y={open ? -34 : 0} transition={T}>
            <button className={`blob small${open ? '' : ' shut'}`} aria-label="Type"
              onClick={() => { const next = !typeOpen; setTypeOpen(next); if (!next) back(); }}><Keys /></button>
          </Liquid.Item>
          <Liquid.Item className="it-small" x={0} y={open ? -64 : 0} transition={T} delay={40}>
            <button className={`blob small${open ? '' : ' shut'}`} aria-label="Log" onClick={() => { setLogOpen(v => !v); back(); }}><List /></button>
          </Liquid.Item>
          <Liquid.Item className="it-small" x={open ? -64 : 0} y={0} transition={T} delay={80}>
            <button className={`blob small${open ? '' : ' shut'}`} aria-label="Shortcuts" onClick={() => {
              if (!shortcuts.length) setCaption('No shortcuts yet. When every step of a task confirms, Pronto offers to save it.');
              else setBrowsing(v => !v);
              back();
            }}><Icon name={browsing ? 'x' : 'plus'} /></button>
          </Liquid.Item>
          {shortcuts.flatMap((s, i) => {
            const slot = browsing ? i : s.pinned ? pinned.indexOf(s) : -1;
            const visible = slot >= 0 && slot < SLOTS.length && (browsing || open);
            const [x, y] = visible ? SLOTS[slot] : [0, 0];
            const delay = 120 + 40 * Math.max(slot, 0);
            return [
              <Liquid.Item key={s.id} className="it-pin" x={x} y={y} transition={T} delay={delay}>
                <button className={`blob pin${visible ? '' : ' shut'}${browsing && !s.pinned ? ' off' : ''}`} aria-label={s.name}
                  onClick={() => clickShortcut(s)}
                  onMouseEnter={() => setHint(browsing ? `${s.name}: ${s.pinned ? 'pinned, click to unpin' : 'click to pin'}` : s.name)}
                  onMouseLeave={() => setHint(null)}><Icon name={s.icon} /></button>
              </Liquid.Item>,
              <Liquid.Item key={s.id + '-x'} className="it-x" x={browsing ? x + 14 : 0} y={browsing ? y - 14 : 0} transition={T} delay={delay}>
                <button className={`blob xs${browsing ? '' : ' shut'}`} aria-label={`Remove ${s.name}`}
                  onClick={() => { void post('/shortcut/delete', { id: s.id }); setHint(null); back(); }}><Icon name="x" size={10} /></button>
              </Liquid.Item>,
            ];
          })}
          <Liquid.Item className="it-main">
            <button className={`blob main ${phase}`} aria-label="Speak"
              onPointerDown={speakDown} onPointerMove={speakMove} onPointerUp={speakUp} onPointerCancel={speakCancel}>
              {busy ? <ThinkingOrb state="working" size={32} theme="light" />
                : <span className="face"><VoiceRing size={RING} type="mono" theme="light" stream={micStream ?? undefined}
                    state={phase === 'recording' ? 'listening' : phase === 'transcribing' || phase === 'downloading' ? 'processing' : 'idle'} /></span>}
            </button>
          </Liquid.Item>
        </Liquid>
        <div className="beam"><BorderBeam size="sm" colorVariant="mono" theme="light" active={busy} borderRadius={28}><div className="beam-dot" /></BorderBeam></div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
