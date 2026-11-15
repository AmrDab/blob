// Blob's phone page: a remote microphone for the Blob on your computer. The room and the secret come from the
// link's #fragment (never sent to a server); every message is end-to-end encrypted before it reaches the relay.
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import { VoiceRing } from 'voice-ring';
import { ThinkingOrb } from 'thinking-orbs';
import { CLOSE, channel, parseFragment, randomB64url, type Channel, type PcMsg, type PhoneMsg, type RelayMsg } from '../src/pair-crypto.ts';

declare const __RELAY__: string;   // set at build time when the relay is on another host; '' = this page's host

const T = { duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
const GOO = { blur: 13.5, contrast: 40, fill: '#e9e9e9', waviness: 8 };
const HOLD_MS = 350;      // a press longer than this is press-and-hold; shorter is a tap (tap again to finish)
const ORB = 190;
const RETRY_MS = [1000, 2000, 5000, 10000];

type Ask = Extract<PcMsg, { t: 'ask' }>;
type Mode = 'ready' | 'listening' | 'working' | 'answer';
type Over = 'unpaired' | 'expired' | 'taken' | 'bad-link';
const OVER: Record<Over, string> = {
  unpaired: 'Unpaired. To use this phone again, scan a new code from Blob on your computer.',
  expired: 'This code has expired. Show a new one from Blob on your computer.',
  taken: 'This code is now open on another phone or tab.',
  'bad-link': 'This link is not a Blob pairing code. Scan the code that Blob shows on your computer.',
};

// The phone browser's speech recognition (Chrome, Safari). Without it the page is typed only.
const Recognition: (new () => any) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

function say(text: string, onEnd?: () => void) {
  if (!('speechSynthesis' in window)) return onEnd?.();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language;
  u.onend = u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

const Keys = () => <svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" /></svg>;
const Stop = () => <svg viewBox="0 0 24 24" width="22" height="22"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
const Send = () => <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
const Off = () => <svg viewBox="0 0 24 24" width="56" height="56"><path d="M9 15l6-6M10.5 6.5l1-1a4.2 4.2 0 0 1 6 6l-1 1M13.5 17.5l-1 1a4.2 4.2 0 0 1-6-6l1-1M4 4l16 16" /></svg>;

function App() {
  const [link] = useState(() => parseFragment(location.hash));
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
  const ch = useRef<Channel | null>(null);
  const rec = useRef<any>(null);
  const press = useRef(0);
  const level = useRef(0);                            // the ring's level: there is no mic stream to read on a phone

  const send = (msg: PhoneMsg) => {
    const s = ws.current;
    void ch.current?.seal(msg).then(f => { if (s?.readyState === WebSocket.OPEN) s.send(f); });
  };

  function got(m: PcMsg) {
    if (m.t === 'status') {
      if (m.state === 'working') { setMode('working'); setNote(m.text ?? ''); }
      else setMode(v => (v === 'working' ? 'ready' : v));
    } else if (m.t === 'answer') {
      setMode('answer'); setAnswer(m.text); setNote('');
      setSpeaking(true);
      say(m.text, () => setSpeaking(false));
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
      history.replaceState(null, '', location.pathname);   // the secret leaves the address bar
    };
    async function connect() {
      ch.current ??= await channel(link!.secret, link!.room, 'phone');
      if (done) return;
      const base = __RELAY__ || location.origin.replace(/^http/, 'ws');
      const s = ws.current = new WebSocket(`${base}/room/${link!.room}?role=phone&auth=${ch.current.auth}`);
      s.binaryType = 'arraybuffer';
      s.onopen = () => { tries = 0; setOpen(true); };
      s.onmessage = e => {
        if (typeof e.data === 'string') {
          const m = JSON.parse(e.data) as RelayMsg;
          if (m.t === 'peer') { setPcOn(m.on); if (!m.on) { setMode('ready'); setAsk(null); } }
          else { end(m.t === 'replaced' ? 'taken' : m.t); s.close(); }
          return;
        }
        ch.current!.open(e.data).then(got, () => { /* not from our computer, or a replay: dropped */ });
      };
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
    const back = () => { if (!document.hidden && !ws.current && !done) { clearTimeout(timer); void connect(); } };
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
    speechSynthesis?.cancel();
    setSpeaking(false);
    const r = rec.current = new Recognition();
    let said = '';
    r.lang = navigator.language;
    r.interimResults = true;
    r.onresult = (e: any) => {
      said = Array.from(e.results as ArrayLike<any>, x => x[0].transcript).join(' ');
      level.current = 0.9;
      setHeard(said);
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setNote('This browser did not allow the microphone. You can type instead.');
        setTyping(true);
      }
    };
    r.onend = () => {
      if (rec.current !== r) return;
      rec.current = null;
      request(said);
    };
    setHeard(''); setAnswer(''); setNote('');
    setMode('listening');
    try { r.start(); } catch { rec.current = null; setMode('ready'); }
  }

  // The orb: hold to talk, or tap to start and tap again (or just stop talking) to finish.
  function orbDown(e: ReactPointerEvent) {
    if (!live || ask || e.button !== 0) return;
    press.current = Date.now();
    if (mode === 'listening') rec.current?.stop();
    else if (mode !== 'working') listen();
    else press.current = 0;
  }
  function orbUp() {
    if (press.current && Date.now() - press.current > HOLD_MS) rec.current?.stop();
    press.current = 0;
  }

  function reply(r: { yes?: boolean; choice?: string; text?: string }) {
    if (!ask) return;
    send({ t: 'reply', id: ask.id, ...r });
    setAsk(null);
    speechSynthesis?.cancel();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || !live) return;
    if (ask) reply({ text: t });
    else if (mode !== 'working') request(t);
    else return;
    setText('');
    if (Recognition) setTyping(false);
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
  const gooH = 20 + ORB + (yesNo ? 90 : choices.length ? 22 + choices.length * 62 : 30);

  return (
    <div className="page" data-state={state}>
      <header>
        <b>Blob</b>
        {!over && open && <button className="unpair" onClick={unpair}>{sure ? 'Tap again to unpair' : 'Unpair'}</button>}
      </header>

      <div className={`words${mode === 'working' && !ask && live ? ' dim' : ''}`}><p>{words}</p></div>

      <Liquid {...GOO} className="goo" style={{ height: gooH }}>
        <Liquid.Item className="it-side" x={side && mode !== 'working' && Recognition ? -128 : 0} y={side && mode !== 'working' && Recognition ? 70 : 0} transition={T}>
          <button className={`blob side${side && mode !== 'working' && Recognition ? '' : ' shut'}`} aria-label="Type" onClick={() => setTyping(v => !v)}><Keys /></button>
        </Liquid.Item>
        <Liquid.Item className="it-side" x={side && mode === 'working' ? 128 : 0} y={side && mode === 'working' ? 70 : 0} transition={T}>
          <button className={`blob side${side && mode === 'working' ? '' : ' shut'}`} aria-label="Stop" onClick={() => send({ t: 'stop' })}><Stop /></button>
        </Liquid.Item>
        {[['No', false], ['Yes', true]].map(([label, yes], i) => (
          <Liquid.Item key={String(label)} className="it-yn" x={yesNo ? (i ? 80 : -80) : 0} y={yesNo ? 122 : 0} transition={T} delay={i * 60}>
            <button className={`blob yn${yesNo ? '' : ' shut'}${yes ? ' strong' : ''}`} onClick={() => reply({ yes: yes as boolean })}>{label}</button>
          </Liquid.Item>
        ))}
        {choices.map((c, i) => (
          <Liquid.Item key={c} className="it-choice" y={ORB / 2 + 46 + i * 62} transition={T} delay={i * 60}>
            <button className="blob choice" onClick={() => reply({ choice: c })}>{c}</button>
          </Liquid.Item>
        ))}
        <Liquid.Item className="it-orb">
          <button className="blob orb" aria-label="Talk" onPointerDown={orbDown} onPointerUp={orbUp} onPointerCancel={orbUp}
            onContextMenu={e => e.preventDefault()}>
            {over ? <Off />
              : !live ? <span className="think"><ThinkingOrb state="connecting" size={64} theme="light" /></span>
              : mode === 'working' && !ask ? <span className="think"><ThinkingOrb state="working" size={64} theme="light" /></span>
              : <span className="face"><VoiceRing size={ORB * 1.5} type="mono" theme="light"
                  state={mode === 'listening' ? 'listening' : speaking ? 'speaking' : 'idle'}
                  level={() => (speaking ? 0.3 + 0.3 * Math.abs(Math.sin(performance.now() / 170)) : (level.current *= 0.97))} /></span>}
          </button>
        </Liquid.Item>
      </Liquid>

      <p className="hint">{hint}</p>

      {typing && live && (
        <form onSubmit={submit}>
          <Liquid {...GOO} className="type-row">
            <Liquid.Item observe className="type-item">
              <input value={text} onChange={e => setText(e.target.value)} enterKeyHint="send" autoComplete="off"
                placeholder={ask ? 'Type your answer…' : 'Type a request…'} />
            </Liquid.Item>
            <Liquid.Item><button className="blob send" aria-label="Send"><Send /></button></Liquid.Item>
          </Liquid>
        </form>
      )}
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
