// Blob's phone page: a remote microphone for the Blob on your computer. The room and the secret come from the
// link's #fragment (never sent to a server): it is read once at load, taken out of the address bar and kept in
// sessionStorage only. Every message is end-to-end encrypted before it reaches the relay.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { ThinkingOrb } from 'thinking-orbs';
import { CLOSE, isHello, pairKeys, parseFragment, randomB64url, type Channel, type PairKeys, type PcMsg, type PhoneMsg, type RelayMsg } from '../src/pair-crypto.ts';
import { turn } from './speech.ts';
import { startLiquid, type Box } from '../site/gl.ts';

declare const __RELAY__: string;   // set at build time when the relay is on another host; '' = this page's host

const T = { duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
const GOO = { blur: 13.5, contrast: 40, fill: '#e9e9e9', waviness: 8 };
const HOLD_MS = 350;      // a press longer than this is press-and-hold; shorter is a tap (tap again to finish)
const SETTLE_MS = 400;    // iPhone: recognition starts this long after a voice, never together with one
const ORB = 190;
const RETRY_MS = [1000, 2000, 5000, 10000];
const CHOICE_GAP = 82;   // from one choice to the next: far enough apart that each stays its own blob

// Before anything connects: the room and the secret leave the address bar (and the history entry) and live in
// sessionStorage, so a reload still works and nothing outlasts the tab.
const KEEP = 'blob-link';
const LINK = (() => {
  const hash = location.hash;
  if (hash) history.replaceState(null, '', location.pathname);
  try {
    if (parseFragment(hash)) sessionStorage.setItem(KEEP, hash);
    return parseFragment(sessionStorage.getItem(KEEP) ?? '');
  } catch { return parseFragment(hash); }
})();
/** This phone's own id (random, kept in this browser): the relay lets only the first phone into a room. */
function device(): string {
  try {
    let d = localStorage.getItem('blob-device') ?? '';
    if (!/^[\w-]{22}$/.test(d)) localStorage.setItem('blob-device', d = randomB64url(16));
    return d;
  } catch { return randomB64url(16); }
}

type Ask = Extract<PcMsg, { t: 'ask' }>;
type Mode = 'ready' | 'listening' | 'working' | 'answer';
type Over = 'unpaired' | 'expired' | 'taken' | 'bad-link';
const OVER: Record<Over, string> = {
  unpaired: 'Unpaired. To use this phone again, scan a new code from Blob on your computer.',
  expired: 'This code has expired. Show a new one from Blob on your computer.',
  taken: 'This code is in use on another phone or tab.',
  'bad-link': 'This link is not a Blob pairing code. Scan the code that Blob shows on your computer.',
};

// The phone browser's speech recognition (Chrome, Safari). Without it the page is typed only.
const Recognition: (new () => any) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
// iPhone and iPad: a turn that the page cuts with stop() leaves every later one deaf (iOS 27), so there a turn is
// ended with abort().
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

/** Reads text aloud; `on` hears true when the voice really starts and false when it ends. */
function say(text: string, on?: (speaking: boolean) => void) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language;
  u.onstart = () => on?.(true);
  u.onend = u.onerror = () => on?.(false);
  speechSynthesis.speak(u);
}
// iOS Safari stays silent until one speak() has run inside a tap: the first tap anywhere says nothing, once.
let unlocked = !('speechSynthesis' in window);
if (!unlocked) {
  const unlock = () => {
    unlocked = true;
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    removeEventListener('touchend', unlock); removeEventListener('click', unlock);
  };
  addEventListener('touchend', unlock); addEventListener('click', unlock);
}

// The blobs are the website's lit liquid (WebGL), drawn on a canvas under the buttons. Reduced motion, no WebGL or a
// lost context: the 2D goo, as before.
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A blob's place in the lit liquid: x/y move it from where the layout puts it, in CSS, and the liquid follows. */
function Plain({ x = 0, y = 0, delay = 0, className, children }: { x?: number; y?: number; delay?: number; className?: string; children?: ReactNode; transition?: unknown; observe?: boolean }) {
  return <div className={className} style={{ '--x': `${x}px`, '--y': `${y}px`, transitionDelay: `${delay}ms` } as CSSProperties}>{children}</div>;
}

/** One liquid group. Lit: a canvas that draws a body under `hero` and under every other .blob, where they are on
 *  screen in each frame; `swell` (0..1) grows the hero with the voice. `lost` hears when WebGL is not there, or goes. */
function Goo({ lit, lost, hero, n, swell, className, style, children }: { lit: boolean; lost: () => void; hero: string; n: number;
  swell?: { current: () => number }; className: string; style?: CSSProperties; children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const stop = startLiquid(c, () => {
      const o = c.getBoundingClientRect();
      const box = (el: Element, k = 1): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2 - o.x, y: r.y + r.height / 2 - o.y, w: r.width * k, h: r.height * k, r: Math.min(r.width, r.height) * k / 2 };
      };
      const h = box(c.parentElement!.querySelector(hero)!, 1 + 0.05 * (swell?.current() ?? 0));
      // a blob that is still wholly inside the hero is not drawn: it does not show
      const blobs = [...c.parentElement!.querySelectorAll(`.blob:not(${hero})`)].map(el => box(el))
        .filter(b => Math.hypot(b.x - h.x, b.y - h.y) + Math.max(b.w, b.h) / 2 > h.r);
      return { hero: h, blobs, breath: 1, neck: 32 };   // 32: a choice 34 px under the orb stays its own blob
    }, n);
    if (!stop) return lost();
    c.addEventListener('webglcontextlost', lost);   // the buttons have no fill of their own: without the canvas, the 2D goo
    return () => { stop(); c.removeEventListener('webglcontextlost', lost); };
  }, [lit]);
  return lit ? <div className={`${className} gl`} style={style}><canvas ref={canvas} aria-hidden="true" />{children}</div>
    : <Liquid {...GOO} className={className} style={style}>{children}</Liquid>;
}

const Keys = () => <svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" /></svg>;
const Stop = () => <svg viewBox="0 0 24 24" width="22" height="22"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
const Send = () => <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
const Off = () => <svg viewBox="0 0 24 24" width="56" height="56"><path d="M9 15l6-6M10.5 6.5l1-1a4.2 4.2 0 0 1 6 6l-1 1M13.5 17.5l-1 1a4.2 4.2 0 0 1-6-6l1-1M4 4l16 16" /></svg>;

function App() {
  const link = LINK;
  const [open, setOpen] = useState(false);            // the relay socket is open
  const [pcOn, setPcOn] = useState(false);            // the computer is in the room
  const [over, setOver] = useState<Over | null>(link ? null : 'bad-link');
  const [mode, setMode] = useState<Mode>('ready');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [heard, setHeard] = useState('');             // what the phone heard, or what was typed
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');               // a short line under the orb
  const [typing, setTyping] = useState(!Recognition);
  const [text, setText] = useState('');
  const [sure, setSure] = useState(false);            // Unpair was tapped once
  const [speaking, setSpeaking] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const keys = useRef<PairKeys | null>(null);
  const ch = useRef<Channel | null>(null);     // this connection's keys; none until both hellos crossed
  const rec = useRef<ReturnType<typeof turn> | null>(null);   // the turn that is listening
  const press = useRef(0);
  const voiceOff = useRef(false);                     // recognition was refused: the text field stays open
  const level = useRef(0);                            // the ring's level: there is no mic stream to read on a phone
  const [gl, setGl] = useState(!CALM);                // the lit liquid; false = the 2D goo
  const voice = useRef((): number => 0);              // how much the orb swells: the ring's level, without its decay

  const send = (msg: PhoneMsg) => {
    const s = ws.current;
    void ch.current?.seal(msg).then(f => { if (s?.readyState === WebSocket.OPEN) s.send(f); });
  };

  /** Ends a turn that is still listening, without sending it: a voice and the recognition never run together. */
  function drop() {
    if (!rec.current) return;
    rec.current.drop();
    rec.current = null;
    setMode(v => (v === 'listening' ? 'ready' : v));
  }

  function got(m: PcMsg) {
    if (m.t === 'answer' || m.t === 'ask') drop();
    if (m.t === 'status') {
      if (m.state === 'working') { setMode('working'); setNote(m.text ?? ''); }
      else setMode(v => (v === 'working' ? 'ready' : v));
    } else if (m.t === 'answer') {
      setMode('answer'); setAnswer(m.text); setNote('');
      say(m.text, setSpeaking);
    } else if (m.t === 'ask') {
      setAsk(m);
      if (m.input) setTyping(true);
      say(m.question);
    } else if (m.t === 'ask-done') setAsk(a => (a?.id === m.id ? null : a));
  }

  useEffect(() => {
    if (!link) return;
    let tries = 0, timer = 0, done = false;
    const end = (why: Over) => {
      done = true;
      setOver(why); setAsk(null); setOpen(false);
      try { sessionStorage.removeItem(KEEP); } catch { /* nothing kept */ }
    };
    async function connect() {
      const k = keys.current ??= await pairKeys(link!.secret, link!.room, 'phone');
      if (done) return;
      const base = __RELAY__ || location.origin.replace(/^http/, 'ws');
      const s = ws.current = new WebSocket(`${base}/room/${link!.room}?role=phone&auth=${k.auth}&dev=${device()}`);
      s.binaryType = 'arraybuffer';
      s.onopen = () => { tries = 0; setOpen(true); };
      let line: Promise<unknown> = Promise.resolve();    // frames are handled one at a time, in order
      const frame = async (data: string | ArrayBuffer) => {
        if (typeof data === 'string') {
          const m = JSON.parse(data) as RelayMsg;
          if (m.t !== 'peer') { end(m.t === 'replaced' ? 'taken' : m.t); s.close(); return; }
          ch.current = null;                             // a new connection: new keys, once the computer's hello is here
          setPcOn(false); setMode('ready'); setAsk(null);
          if (m.on) s.send(await k.hello());
        } else if (isHello(data)) {
          if (ch.current) return;                        // one hello per connection: a second one changes nothing
          ch.current = await k.channel(data);
          setPcOn(true);
        } else if (ch.current) got(await ch.current.open(data));
      };
      s.onmessage = e => { line = line.then(() => frame(e.data)).catch(() => { /* not from our computer, or a replay: dropped */ }); };
      s.onclose = e => {
        if (ws.current !== s || done) return;
        ws.current = null;
        setOpen(false); setPcOn(false);
        if (e.code === CLOSE.unpaired) return end('unpaired');
        if (e.code === CLOSE.gone || e.code === CLOSE.badAuth) return end('expired');
        if (e.code === CLOSE.taken) return end('taken');
        timer = window.setTimeout(connect, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
      };
    }
    void connect();
    // Back from the lock screen or another app: reconnect at once.
    const back = () => {
      if (document.hidden) return;
      setGl(!CALM);                                     // a lost WebGL context (lock screen, another app): the lit liquid is tried again
      if (!ws.current && !done) { clearTimeout(timer); void connect(); }
    };
    const hide = () => ws.current?.close();             // leaving the page: the computer sees the phone go
    document.addEventListener('visibilitychange', back);
    addEventListener('pagehide', hide);
    return () => { done = true; clearTimeout(timer); document.removeEventListener('visibilitychange', back); removeEventListener('pagehide', hide); ws.current?.close(); };
  }, [link]);

  const live = open && pcOn && !over;

  function request(said: string) {
    const t = said.trim();
    if (!t) { setMode('ready'); setNote("Didn't catch that."); return; }
    setHeard(t); setAnswer(''); setNote('');
    setMode('working');
    send({ t: 'req', id: randomB64url(6), text: t });
  }

  function listen() {
    if (!Recognition) { setTyping(true); return; }
    const wait = IOS && (!unlocked || window.speechSynthesis?.speaking);   // the first tap's silent voice, or an answer being read
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    const r = new Recognition();
    r.lang = navigator.language;
    r.interimResults = true;
    const t = rec.current = turn(r, {
      cut: IOS,
      heard: said => { voiceOff.current = false; level.current = 0.9; setHeard(said); },
      error: err => { setNote(err.note); if (err.off) { voiceOff.current = true; setTyping(true); } },
      done: (said, why) => {
        if (rec.current === t) rec.current = null;
        if (said || why === 'end') return request(said);
        setMode('ready');
        if (why !== 'quiet') return;
        setTyping(true);
        setNote(IOS ? "Didn't hear anything. You can type, or tap the box and use the mic on the keyboard." : "Didn't hear anything. You can type instead.");
      },
    });
    setHeard(''); setAnswer(''); setNote('');
    setMode('listening');
    t.start(wait ? SETTLE_MS : 0);
  }

  // The orb: hold to talk, or tap to start and tap again (or just stop talking) to finish.
  function orbDown(e: ReactPointerEvent) {
    if (!live || ask || e.button !== 0) return;
    press.current = Date.now();
    if (mode === 'listening') rec.current?.finish();
    else if (mode !== 'working') listen();
    else press.current = 0;
  }
  function orbUp() {
    if (press.current && Date.now() - press.current > HOLD_MS) rec.current?.finish();
    press.current = 0;
  }

  function reply(r: { yes?: boolean; choice?: string; text?: string }) {
    if (!ask) return;
    send({ t: 'reply', id: ask.id, ...r });
    setAsk(null);
    window.speechSynthesis?.cancel();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || !live) return;
    if (ask) reply({ text: t });
    else if (mode !== 'working') request(t);
    else return;
    setText('');
    if (Recognition && !voiceOff.current) setTyping(false);
  }

  function unpair() {
    if (!sure) { setSure(true); setTimeout(() => setSure(false), 3000); return; }
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: 'unpair' }));
  }

  const state = over ? 'over' : !live ? 'connecting' : ask ? 'ask' : mode;
  const choices = ask ? ask.choices ?? [] : [];
  const yesNo = !!ask && !choices.length && !ask.input;
  const words = over ? OVER[over]
    : !open ? 'Connecting…'
    : !pcOn ? 'Waiting for Blob on your computer…'
    : ask ? ask.question
    : mode === 'answer' ? answer
    : mode === 'listening' ? heard || 'Listening…'
    : mode === 'working' ? heard
    : '';
  const hint = over || !live || ask ? ''
    : note ? note
    : mode === 'listening' ? 'Tap when you are done'
    : mode === 'working' ? 'Working on your computer…'
    : Recognition ? 'Tap or hold to talk' : 'This browser has no speech recognition. Type your request.';
  const side = live && !ask;                         // the small blobs beside the orb
  const Item = gl ? Plain : Liquid.Item;
  const flat = () => setGl(false);
  voice.current = () => (speaking ? 0.3 + 0.3 * Math.abs(Math.sin(performance.now() / 170)) : mode === 'listening' ? level.current : 0);
  const gooH = 20 + ORB + (yesNo ? 90 : choices.length ? 34 + choices.length * CHOICE_GAP : 30);

  return (
    <div className="page" data-state={state}>
      <header>
        <b>Blob</b>
        {!over && open && <button className="unpair" onClick={unpair}>{sure ? 'Tap again to unpair' : 'Unpair'}</button>}
      </header>

      <div className="mid">
      <div className={`words${mode === 'working' && !ask && live ? ' dim' : ''}`}><p className={!!heard && words === heard ? 'you' : undefined}>{words}</p></div>

      <Goo lit={gl} lost={flat} hero=".orb" n={8} swell={voice} className="goo" style={{ height: gooH }}>
        <Item className="it-side" x={side && mode !== 'working' && Recognition ? -128 : 0} y={side && mode !== 'working' && Recognition ? 70 : 0} transition={T}>
          <button className={`blob side${side && mode !== 'working' && Recognition ? '' : ' shut'}`} aria-label="Type" onClick={() => setTyping(v => !v)}><Keys /></button>
        </Item>
        <Item className="it-side" x={side && mode === 'working' ? 128 : 0} y={side && mode === 'working' ? 70 : 0} transition={T}>
          <button className={`blob side${side && mode === 'working' ? '' : ' shut'}`} aria-label="Stop" onClick={() => send({ t: 'stop' })}><Stop /></button>
        </Item>
        {[['No', false], ['Yes', true]].map(([label, yes], i) => (
          <Item key={String(label)} className="it-yn" x={yesNo ? (i ? 80 : -80) : 0} y={yesNo ? 122 : 0} transition={T} delay={i * 60}>
            <button className={`blob yn${yesNo ? '' : ' shut'}${yes ? ' strong' : ''}`} onClick={() => reply({ yes: yes as boolean })}>{label}</button>
          </Item>
        ))}
        {choices.map((c, i) => (
          <Item key={c} className="it-choice" y={ORB / 2 + 58 + i * CHOICE_GAP} transition={T} delay={i * 60}>
            <button className="blob choice" onClick={() => reply({ choice: c })}>{c}</button>
          </Item>
        ))}
        <Item className="it-orb">
          <button className="blob orb" aria-label="Talk" onPointerDown={orbDown} onPointerUp={orbUp} onPointerCancel={orbUp}
            onContextMenu={e => e.preventDefault()}>
            {over ? <Off />
              : !live ? <span className="think"><ThinkingOrb state="connecting" size={64} theme="light" /></span>
              : mode === 'working' && !ask ? <span className="think"><ThinkingOrb state="working" size={64} theme="light" /></span>
              : <span className="face"><VoiceRing size={ORB * 1.5} type="mono" theme="light"
                  state={mode === 'listening' ? 'listening' : speaking ? 'speaking' : 'idle'}
                  level={() => (speaking ? 0.3 + 0.3 * Math.abs(Math.sin(performance.now() / 170)) : (level.current *= 0.97))} /></span>}
          </button>
        </Item>
      </Goo>
      </div>

      <p className="hint">{hint}</p>

      {typing && live && (
        <form onSubmit={submit}>
          <Goo lit={gl} lost={flat} hero="input" n={1} className="type-row">
            <Item observe className="type-item">
              <input autoFocus value={text} onChange={e => setText(e.target.value)} enterKeyHint="send" autoComplete="off"
                placeholder={ask ? 'Type your answer…' : 'Type a request…'} />
            </Item>
            <Item><button className="blob send" aria-label="Send"><Send /></button></Item>
          </Goo>
        </form>
      )}
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
