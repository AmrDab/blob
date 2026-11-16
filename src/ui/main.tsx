import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { ThinkingOrb } from 'thinking-orbs';
import { BorderBeam } from 'border-beam';
import type { Model } from '../brain.ts';
import { formatLog, type LogRow } from '../log.ts';
import { GOO, MAX_PINNED } from '../shared.ts';
import { Icon } from './icons.tsx';
import { Bubble, type Item } from './liquid/Bubble.tsx';
import { BOX, FAN, GAP_LIQUID, SLOTS, stage } from './liquid/stage.ts';
import { useSettled } from './settle.ts';
import { Command, Title, Words, useSwap, type Line } from './text.tsx';
import { DOWNLOAD_MB, Recorder, isDownloaded, load, transcribe } from './speech.ts';

declare global { interface Window { webviewjs?: { startDragging(): void } } }

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-token': TOKEN }, body: JSON.stringify(body) });
/** Gives the keyboard back to the window the user was in before clicking the bubble. */
const back = () => void post('/focus-back');

const MODELS: Model[] = ['auto', 'haiku', 'sonnet', 'opus', 'default'];
const LABEL: Record<Model, string> = { auto: 'Auto', sonnet: 'Sonnet', haiku: 'Haiku', opus: 'Opus', default: 'Default' };
const T = { duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
const HOLD_MS = 350;   // a press longer than this is press-and-hold; shorter is a tap (tap again to finish)
const STILL_MS = 150;  // a press that stays still this long starts the mic
const DRAG_PX = 4;     // a press that moves further than this drags the window instead
const RING = 84;       // the voice ring: Speak's face (its loops fill about 40% of the canvas, which overhangs the blob)

// The lit WebGL liquid is the bubble; with reduced motion, or no usable GPU, it is the 2D liquid-gooey one.
const CALM = matchMedia('(prefers-reduced-motion: reduce)');

// A card's place in the column. The 2D bubble draws its shape there (a liquid-gooey item); in the lit liquid the canvas
// draws every card's body, so the card itself (marked data-card) is all there is.
const Bare = (p: { observe?: boolean; children?: ReactNode }) => <>{p.children}</>;

type Phase = 'idle' | 'ask' | 'downloading' | 'recording' | 'transcribing';
type ShortcutInfo = { id: string; name: string; icon: string; pinned: boolean };
type Check = { id: string; ok: boolean; label: string; fix: string; alt?: string; tap?: string; text?: string };
type FirstRun = { key: string; title: string; text: string };
const PAIR_CARD: FirstRun = { key: 'pair', title: 'Pair your phone?', text: 'Talk to Blob from your phone. You scan a code once.' };

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
  const [qr, setQr] = useState<string | null>(null);         // the phone pairing code, as an SVG
  const [asks, setAsks] = useState<{ id: string; question: string; detail?: string }[]>([]);
  const [reminders, setReminders] = useState<{ id: string; text: string; at: string }[]>([]);   // each stays until dismissed
  const [checks, setChecks] = useState<Check[]>([]);
  const [micProblem, setMicProblem] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);            // the + view: every saved shortcut, to pin or remove
  const [model, setModel] = useState<Model>('auto');          // the settings' model: a click on the chip changes it
  const [codex, setCodex] = useState(false);                  // the brain is Codex: it runs its own default model, so the chip only says so
  const [voice, setVoice] = useState(true);
  const [first, setFirst] = useState<{ onboarded: boolean; cards: FirstRun[] }>({ onboarded: true, cards: [] });
  const [step, setStep] = useState(0);                         // the first-run card that is up
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [text, setText] = useState('');
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const rec = useRef<{ recorder: Recorder } | null>(null);
  const press = useRef<{ x: number; y: number; t: number; timer: number; started: Promise<boolean> | null; wasRecording: boolean } | null>(null);
  const dragging = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const [liquid, setLiquid] = useState(!CALM.matches);
  const gpuGone = useRef(false);
  const [roomy, setRoomy] = useState(false);                  // the host lets clicks through the window's empty pixels: a wider stage
  const [resting, setResting] = useState(false);              // the liquid has settled: the voice ring holds still too
  const [captionH, setCaptionH] = useState(0);                // the liquid caption's height: the cards leave it room
  const leave = useRef(() => {});
  const typed = useRef('');
  const heard = useRef('');                                   // the caption that is the user's own words (the plain voice)

  useEffect(() => {
    const es = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = m => {
      const e = JSON.parse(m.data);
      if (e.type === 'caption') setCaption(e.text);
      if (e.type === 'busy') setBusy(e.busy);
      if (e.type === 'row') setRows(r => [...r, e.row]);
      if (e.type === 'shortcuts') setShortcuts(e.list);
      if (e.type === 'setup') setChecks(e.checks);
      if (e.type === 'ask') setAsks(a => [...a, { id: e.id, question: e.question, detail: e.detail }]);
      if (e.type === 'reminder') setReminders(r => [...r, { id: e.id, text: e.text, at: e.at }]);
      if (e.type === 'reminder-done') setReminders(r => r.filter(x => x.id !== e.id));
      if (e.type === 'ask-done') setAsks(a => a.filter(x => x.id !== e.id));
      if (e.type === 'settings') {
        setModel(e.model); setCodex(e.brain === 'codex'); setVoice(e.voice);
        // the phone's card comes once, also after the first run (for someone onboarded before phones were on)
        setFirst({ onboarded: e.onboarded, cards: [...(e.onboarded ? [] : e.firstRun), ...(e.offerPair ? [PAIR_CARD] : [])] });
      }
      if (e.type === 'qr') setQr(e.svg);
      if (e.type === 'stage') setRoomy(e.clickThrough);
      if (e.type === 'over') {                      // the cursor went off Blob (the window lets the mouse through now), or came back
        dispatchEvent(new CustomEvent('blob-over', { detail: e.on }));
        if (e.on) clearTimeout(typeLeave.current); else leave.current();
      }
    };
    const calm = () => setLiquid(!CALM.matches && !gpuGone.current);
    CALM.addEventListener('change', calm);
    return () => { es.close(); CALM.removeEventListener('change', calm); };
  }, []);
  // Without the liquid the window takes the mouse everywhere, as it always did.
  useEffect(() => { if (!liquid) { setHover(false); setResting(false); setCaptionH(0); void post('/hit', { shapes: null, capture: false }); } }, [liquid]);

  // Setup comes first, one card at a time; then the first-run questions, one at a time.
  const need = checks.find(c => !c.ok);
  const ready = (!first.onboarded || first.cards.length > 0) && checks.length > 0 && !need;
  const asking = ready ? first.cards[step] : undefined;
  useEffect(() => { if (ready && step >= first.cards.length) void post('/firstrun', { done: true }); }, [ready, step, first.cards.length]);
  // What can be tapped on the cards: when it changes, taps wait a moment (settle.ts).
  const settled = useSettled(`${need?.id}|${asks[0]?.id}|${asking?.key}|${!!qr}`);
  const big = typeOpen || logOpen || !!qr || asks.length > 0 || reminders.length > 0 || !!need || !!asking || !!micProblem;
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
  }, [liquid]);                                               // the column is another element in each of the two liquids
  const st = stage({ roomy: liquid && roomy, big, arcs, cardsH, gap: liquid ? GAP_LIQUID : undefined });
  const sized = useRef(0);
  useEffect(() => {
    const size = () => void post('/size', { w: st.w, h: st.h, r: st.padR, b: st.padB });
    // In the lit liquid a card that closes flows back into Speak first: the window gives up its room a moment later.
    const wait = liquid && st.h < sized.current;
    sized.current = st.h;
    if (!wait) { size(); return; }
    const t = setTimeout(size, 600);
    return () => clearTimeout(t);
  }, [st.w, st.h, st.padR, st.padB]);
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
  // A caption is read, then goes: a few seconds plus a little per character (not while the mouse is on Blob).
  useEffect(() => {
    if (!caption || hover || busy || phase !== 'idle') return;
    const t = setTimeout(() => setCaption(''), Math.min(20_000, 4_000 + caption.length * 60));
    return () => clearTimeout(t);
  }, [caption, hover, busy, phase]);
  // The Type box goes away by itself: when another window is clicked, or soon after the pointer leaves an empty box.
  const typeLeave = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!typeOpen) return;
    const blur = () => setTypeOpen(false);
    addEventListener('blur', blur);
    return () => { removeEventListener('blur', blur); clearTimeout(typeLeave.current); };
  }, [typeOpen]);

  // ── Speak: a still press talks (hold, or tap and tap again), a moving press drags the window ──
  async function begin(): Promise<boolean> {
    if (!voice) { setTypeOpen(true); setCaption('Voice is off. Type here, or ask me to turn voice on.'); return false; }
    if (!(await isDownloaded())) { setPhase('ask'); return false; }
    const recorder = new Recorder();
    try { await recorder.start(); } catch (err) {
      const name = (err as Error).name;
      setMicProblem(name === 'NotFoundError' ? 'No microphone found. Plug one in, then try Speak again.' : `Blob can't use the microphone (${(err as Error).message}).`);
      return false;
    }
    setMicProblem(null);
    rec.current = { recorder };
    setMicStream(recorder.stream ?? null);
    setPhase('recording');
    setCaption('Listening…');
    void post('/prewarm');                          // Claude starts while the user is still talking
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
      else { heard.current = said; setCaption(said); void post('/run', { text: said }); }
    } catch (err) {
      setCaption(`Speech: ${(err as Error).message}`);
      void post('/cancel');
    }
    setPhase('idle');
  }

  function pressStart(x: number, y: number) {
    const p = { x, y, t: Date.now(), timer: 0, started: null as Promise<boolean> | null, wasRecording: !!rec.current };
    const canStart = !busy && !p.wasRecording && (phase === 'idle' || phase === 'ask');
    if (canStart) p.timer = window.setTimeout(() => { if (press.current === p) p.started = begin(); }, STILL_MS);
    press.current = p;
  }

  /** The press became a drag of the window: no mic. */
  function pressDragged() {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.timer);
    press.current = null;
    if (p.started) void p.started.then(ok => { if (ok) discard(); });
  }

  function speakDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressStart(e.screenX, e.screenY);
  }

  function speakMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const p = press.current;
    if (!p || Math.hypot(e.screenX - p.x, e.screenY - p.y) <= DRAG_PX) return;
    pressDragged();
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

  /** The press was taken away (another window came up, the pointer was lost): it is no tap, and a mic it started stops. */
  const speakCancel = pressDragged;

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
    void post('/run', { text: t });                 // the host hands the keyboard back
    setText('');
    setTypeOpen(false);
  }

  /** A first-run card's answer: a feature on or off, or the phone's QR now or later. */
  function pick(card: FirstRun, yes: boolean) {
    if (!settled()) return;
    void post('/firstrun', { key: card.key, value: yes });   // 'pair' with Yes: the host shows the QR
    setStep(s => s + 1);
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
  // While Blob works only the orb shows: no step-by-step text on the bubble (the Log has it).
  const shown = !busy && (caption || phase === 'ask' || phase === 'downloading');
  // The caption's line: what Blob says is in its voice and condenses out of goo (the one before it dissolves); what
  // the user said is plain type, and a shortcut's name is a label that is simply there.
  const line: Line | null = hint ? { id: `hint:${hint}`, plain: true, node: hint }
    : !shown ? null
    : phase === 'ask' ? { id: 'ask', blob: true, node: <Words text={`Speech needs a one-time download (~${DOWNLOAD_MB} MB).`} /> }
    : phase === 'downloading' ? { id: 'downloading', blob: true, node: <Words text={`Downloading speech… ${percent}%`} /> }
    : { id: `c:${caption}`, blob: caption !== heard.current, node: <Words text={caption} /> };
  const [capLine, capRef] = useSwap<HTMLSpanElement>(line);
  // (the Download button sits after the line, not in it: a button never goes through the goo)
  const captionNode = capLine && <>
    <span ref={capRef} className={capLine.blob ? 'cap-t bv' : 'cap-t'}>{capLine.node}</span>
    {capLine.id === 'ask' && <button className="link" onClick={() => void download()}>Download</button>}
  </>;
  const wait = liquid ? 300 : 0;                              // a card's title forms once its liquid has arrived
  // The Type box goes away soon after the pointer leaves it empty.
  // (With the liquid, "leaves" is the pointer going off Blob's shapes, which is sooner than off its window: a box
  // typed into meanwhile stays.)
  typed.current = text;
  leave.current = () => {
    clearTimeout(typeLeave.current);
    if (typeOpen && !text.trim()) typeLeave.current = setTimeout(() => { if (!typed.current.trim()) { setTypeOpen(false); back(); } }, 1500);
  };

  // The bubble's buttons. The 2D liquid hides a closed one's icon; in the lit liquid an icon fades with its body.
  const shut = (out: boolean) => out || liquid ? '' : ' shut';
  const typeBtn = (
    <button className={`blob small${shut(open)}`} aria-label="Type"
      onClick={() => { const next = !typeOpen; setTypeOpen(next); if (!next) back(); }}><Keys /></button>
  );
  const logBtn = <button className={`blob small${shut(open)}`} aria-label="Log" onClick={() => { setLogOpen(v => !v); back(); }}><List /></button>;
  const moreBtn = (
    <button className={`blob small${shut(open)}`} aria-label="Shortcuts" onClick={() => {
      if (!shortcuts.length) setCaption('No shortcuts yet. After a task, say "save that as a shortcut".');
      else setBrowsing(v => !v);
      back();
    }}><Icon name={browsing ? 'x' : 'plus'} /></button>
  );
  const pins = shortcuts.map((s, i) => {
    const slot = browsing ? i : s.pinned ? pinned.indexOf(s) : -1;
    const live = slot >= 0 && slot < SLOTS.length, visible = live && (browsing || open);
    const tip = browsing ? `${s.name}: ${s.pinned ? 'pinned, click to unpin' : 'click to pin'}` : s.name;
    return {
      s, slot, live, visible, tip, delay: 120 + 40 * Math.max(slot, 0),
      btn: (
        <button className={`blob pin${shut(visible)}${browsing && !s.pinned ? ' off' : ''}`} aria-label={s.name}
          onClick={() => clickShortcut(s)} onMouseEnter={() => setHint(tip)} onMouseLeave={() => setHint(null)}><Icon name={s.icon} /></button>
      ),
      x: (
        <button className={`blob xs${shut(browsing)}`} aria-label={`Remove ${s.name}`}
          onClick={() => { void post('/shortcut/delete', { id: s.id }); setHint(null); back(); }}><Icon name="x" size={10} /></button>
      ),
    };
  });
  // Speak: the 2D liquid's button takes the press itself; in the lit liquid the canvas does (Bubble's `on`).
  const mainBtn = (
    <button className={`blob main ${phase}`} aria-label="Speak"
      {...(liquid ? {} : { onPointerDown: speakDown, onPointerMove: speakMove, onPointerUp: speakUp, onPointerCancel: speakCancel })}>
      {busy ? <ThinkingOrb state="working" size={32} theme="light" />
        : <span className="face"><VoiceRing size={RING} type="mono" theme="light" stream={micStream ?? undefined} paused={phase === 'idle' && (liquid ? resting : !hover)}
            state={phase === 'recording' ? 'listening' : phase === 'transcribing' || phase === 'downloading' ? 'processing' : 'idle'} /></span>}
    </button>
  );
  const beam = <div className="beam"><BorderBeam size="sm" colorVariant="mono" theme="light" active={busy} borderRadius={28}><div className="beam-dot" /></BorderBeam></div>;
  const items: Item[] = liquid ? [
    { id: 'type', r: 20, home: FAN.type, show: open, live: true, delay: 0, node: typeBtn },
    { id: 'log', r: 20, home: FAN.log, show: open, live: true, delay: 0.04, node: logBtn },
    { id: 'more', r: 20, home: FAN.more, show: open, live: true, delay: 0.08, node: moreBtn },
    ...pins.map(p => ({
      id: `s:${p.s.id}`, r: 18, home: p.live ? SLOTS[p.slot] : [0, 0] as const, show: p.visible, live: p.live, delay: p.delay / 1000, node: p.btn, hint: p.tip,
      rider: { id: `x:${p.s.id}`, dx: 14, dy: -14, r: 8, show: browsing, node: p.x },
    })),
  ] : [];
  const Slot = liquid ? Bare : Liquid.Item;
  const column = (cards: ReactNode) => liquid
    ? <div className="cards" ref={cardsRef} style={{ width: st.cardsW }}>{cards}</div>
    : <Liquid {...GOO} className="cards" ref={cardsRef}>{cards}</Liquid>;
  return (
    <div className={`root${liquid ? ' gl' : ''}`} style={liquid ? { paddingRight: st.padR, paddingBottom: st.padB, gap: GAP_LIQUID } : undefined} data-webview-drag-region="deep"
      onMouseLeave={() => leave.current()}
      onMouseEnter={() => clearTimeout(typeLeave.current)}
      onPointerDown={e => { if (!(e.target as Element).closest('button, input, .log, canvas')) dragging.current = true; }}>
      {liquid && (
        <Bubble st={st} zone={box} items={items} main={mainBtn} beam={beam} caption={captionNode} captionTitle={hint ?? caption} post={post}
          on={{
            hover: on => { setHover(on); if (!on) setHint(null); }, hint: setHint, resting: setResting, captionH: setCaptionH,
            mainDown: () => pressStart(0, 0), mainDrag: pressDragged, mainDragEnd: back, mainUp: speakUp, mainCancel: speakCancel, miss: back,
            fail: () => { gpuGone.current = true; setLiquid(false); },
          }} />
      )}
      {column(<>
        {logOpen && (
          <Slot observe>
            <div className="card log" data-card="log" data-webview-drag-region="false">
              <button className="btn copy" onClick={() => void copyLog()}>Copy</button>
              {rows.length === 0 && <div className="empty">No calls yet.</div>}
              {rows.map((r, i) => r.kind === 'request' ? <div key={i} className="req">› {r.text}</div>
                : r.kind === 'answer' ? <div key={i} className="ans">{r.text}</div>
                : <div key={i} className={`call ${r.outcome}`} title={r.line}><b>{r.tool}{r.action ? ` · ${r.action}` : ''}</b> <span>{r.line}</span></div>)}
              <div ref={logEnd} />
            </div>
          </Slot>
        )}
        {(need || micProblem) && (
          <Slot observe>
            <div className="card setup" data-card={`setup:${need?.id ?? 'mic'}`}>
              {need && <>
                <Title text={need.label} wait={wait} />
                {need.text && <div>{need.text}</div>}
                {need.tap ? (
                  <div className="row">
                    <button className="btn strong" disabled={busy} onClick={() => { if (settled()) void post('/setup/fix', { id: need.id }); }}>{busy ? 'Working…' : need.tap}</button>
                  </div>
                ) : <>
                  {[need.fix, ...(need.alt ? [need.alt] : [])].map(cmd => (
                    <div className="check" key={cmd}><button className="cmd" title="Click to copy, then run it in a terminal"
                      onClick={() => void copyText(cmd).then(ok => { if (ok) setCaption(`Copied: ${cmd}`); back(); })}>{cmd}</button></div>
                  ))}
                  <div className="row"><button className="btn" onClick={() => void post('/setup/check')}>Check again</button></div>
                </>}
              </>}
              {micProblem && (
                <div className="check">{micProblem} <button className="btn" onClick={() => { setMicProblem(null); void post('/setup/mic'); }}>Microphone settings</button></div>
              )}
            </div>
          </Slot>
        )}
        {asking && (
          <Slot observe>
            <div className="card ask" data-card={`first:${asking.key}`}>
              <Title text={asking.title} wait={wait} />
              <div>{asking.text}</div>
              <div className="row">
                <button className="btn" onClick={() => pick(asking, false)}>{asking.key === 'pair' ? 'Later' : 'No'}</button>
                <button className="btn strong" onClick={() => pick(asking, true)}>{asking.key === 'pair' ? 'Show QR' : 'Yes'}</button>
              </div>
            </div>
          </Slot>
        )}
        {asks.slice(0, 1).map(a => (   // the oldest open question: a new one never takes its place under a click
          <Slot observe key={a.id}>
            <div className="card ask" data-card={`ask:${a.id}`}>
              {/* Blob's question: the title over a command, else a sentence in its voice */}
              {a.detail ? <Title text={a.question} wait={wait} /> : <div className="bv">{a.question}</div>}
              {/* the command (or the task) exactly as it will run: all of it, wrapped, never cut or scrolled */}
              {a.detail && <Command text={a.detail} />}
              <div className="row">
                <button className="btn" onClick={() => { if (settled()) void post('/answer', { id: a.id, yes: false }); }}>No</button>
                <button className="btn strong" onClick={() => { if (settled()) void post('/answer', { id: a.id, yes: true }); }}>Yes</button>
              </div>
            </div>
          </Slot>
        ))}
        {reminders.slice(0, 1).map(r => (
          <Slot observe key={r.id}>
            <div className="card ask" data-card={`reminder:${r.id}`}>
              <Title text={`Reminder · ${r.at}${reminders.length > 1 ? ` (and ${reminders.length - 1} more)` : ''}`} wait={wait} />
              <div className="said">{r.text}</div>
              <div className="row"><button className="btn strong" onClick={() => void post('/reminder/done', { id: r.id })}>OK</button></div>
            </div>
          </Slot>
        ))}
        {qr && (
          <Slot observe>
            <div className="card qr" data-card="qr">
              <Title text="Scan with your phone" wait={wait} />
              {/* shapes only, hidden from accessibility: the code is for a camera, never for a program reading the screen */}
              <div className="code" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qr }} />
              <div className="row"><button className="btn" onClick={() => void post('/pair/close')}>Close</button></div>
            </div>
          </Slot>
        )}
        {typeOpen && (
          <div className="type-row">
            <Slot observe>
              <div className="card type" data-card="type">
                <input autoFocus value={text} placeholder="Ask Blob…" onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') send(); }} />
              </div>
            </Slot>
            <Slot observe>
              <button className="card chip" data-card="chip" title="Model" onClick={() => { if (!codex) void post('/model', { model: MODELS[(MODELS.indexOf(model) + 1) % MODELS.length], stay: true }); }}>{codex ? 'Codex' : LABEL[model]}</button>
            </Slot>
          </div>
        )}
        {!liquid && captionNode != null && (
          <Slot observe>
            <div className="card caption" title={hint ?? caption}>{captionNode}</div>
          </Slot>
        )}
        {liquid && captionH > 0 && <div style={{ height: captionH }} />}
      </>)}

      {liquid ? <div className="goo-box" style={{ width: box.w, height: box.h }} /> : (
        <div className="goo-box" style={{ width: box.w, height: box.h }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setHint(null); }}>
          <Liquid {...GOO} className="goo" style={{ width: box.w, height: box.h }}>
            <Liquid.Item className="it-small" x={open ? -54 : 0} y={open ? -34 : 0} transition={T}>{typeBtn}</Liquid.Item>
            <Liquid.Item className="it-small" x={0} y={open ? -64 : 0} transition={T} delay={40}>{logBtn}</Liquid.Item>
            <Liquid.Item className="it-small" x={open ? -64 : 0} y={0} transition={T} delay={80}>{moreBtn}</Liquid.Item>
            {pins.flatMap(p => {
              const [x, y] = p.visible ? SLOTS[p.slot] : [0, 0];
              return [
                <Liquid.Item key={p.s.id} className="it-pin" x={x} y={y} transition={T} delay={p.delay}>{p.btn}</Liquid.Item>,
                <Liquid.Item key={p.s.id + '-x'} className="it-x" x={browsing ? x + 14 : 0} y={browsing ? y - 14 : 0} transition={T} delay={p.delay}>{p.x}</Liquid.Item>,
              ];
            })}
            <Liquid.Item className="it-main">{mainBtn}</Liquid.Item>
          </Liquid>
          {beam}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
