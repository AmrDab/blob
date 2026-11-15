import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Liquid } from 'liquid-gooey';
import type { LogEntry, Model } from '../brain.ts';
import { DOWNLOAD_MB, Recorder, isDownloaded, load, transcribe } from './speech.ts';

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talk-token': TOKEN }, body: JSON.stringify(body) });

const MODELS: Model[] = ['sonnet', 'haiku', 'default'];
const LABEL: Record<Model, string> = { sonnet: 'Sonnet', haiku: 'Haiku', default: 'Default' };
const T = { duration: 550, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
const HOLD_MS = 350;   // a press longer than this is press-and-hold; shorter is a tap (tap again to finish)

type Row = { request: string } | LogEntry;
type Phase = 'idle' | 'ask' | 'downloading' | 'recording' | 'transcribing';

const Mic = () => <svg viewBox="0 0 24 24" width="22" height="22"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" /></svg>;
const Keys = () => <svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="6" width="18" height="12" rx="2.5" fill="none" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" fill="none" /></svg>;
const List = () => <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" fill="none" /></svg>;

function App() {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [typeOpen, setTypeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [model, setModel] = useState<Model>('sonnet');
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [text, setText] = useState('');
  const rec = useRef<{ recorder: Recorder; downAt: number } | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = m => {
      const e = JSON.parse(m.data);
      if (e.type === 'caption') setCaption(e.text);
      if (e.type === 'busy') setBusy(e.busy);
      if (e.type === 'log') setRows(r => [...r, e.entry]);
      if (e.type === 'request') setRows(r => [...r, { request: e.text }]);
    };
    return () => es.close();
  }, []);
  useEffect(() => { void post('/size', { open: typeOpen || logOpen }); }, [typeOpen, logOpen]);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [rows, logOpen]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setTypeOpen(false); setLogOpen(false); } };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, []);

  async function speakDown() {
    if (busy) { setCaption('Still working on the last request.'); return; }
    if (phase === 'recording') return finish();   // the second tap of tap-to-talk
    if (phase !== 'idle' && phase !== 'ask') return;
    if (!(await isDownloaded())) { setPhase('ask'); return; }
    const downAt = Date.now();
    const recorder = new Recorder();
    try { await recorder.start(); } catch (err) { setCaption(`Microphone: ${(err as Error).message}`); return; }
    rec.current = { recorder, downAt };
    setPhase('recording');
    setCaption('Listening…');
    void post('/prewarm', { model });               // Claude starts while the user is still talking
    void load(() => {});                            // and Whisper loads from the cache
  }

  function speakUp() {
    if (rec.current && Date.now() - rec.current.downAt > HOLD_MS) void finish();
  }

  async function finish() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
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
  }

  function send() {
    const t = text.trim();
    if (!t) return;
    if (busy) { setCaption('Still working on the last request.'); return; }
    void post('/run', { text: t, model });
    setText('');
    setTypeOpen(false);
  }

  const open = hover || busy || phase === 'recording';
  return (
    <div className="root" data-webview-drag-region="deep">
      {logOpen && (
        <div className="panel log">
          {rows.length === 0 && <div className="empty">No calls yet.</div>}
          {rows.map((r, i) => 'request' in r
            ? <div key={i} className="req">› {r.request}</div>
            : <div key={i} className={`call ${r.outcome}`} title={r.line}>
                <b>{r.tool}{r.action ? ` · ${r.action}` : ''}</b> <span>{r.line}</span>
              </div>)}
          <div ref={logEnd} />
        </div>
      )}
      {typeOpen && (
        <div className="panel type">
          <input autoFocus value={text} placeholder="Ask clawdcursor…" onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send(); }} />
          <button className="chip" title="Model" onClick={() => setModel(MODELS[(MODELS.indexOf(model) + 1) % MODELS.length])}>{LABEL[model]}</button>
        </div>
      )}
      <div className="goo-box" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <Liquid blur={13.5} contrast={40} fill="#e9e9e9" waviness={8} className="goo">
          <Liquid.Item x={open ? -54 : 0} y={open ? -34 : 0} transition={T}>
            <button className="blob small" aria-label="Type" onClick={() => setTypeOpen(v => !v)}><Keys /></button>
          </Liquid.Item>
          <Liquid.Item x={0} y={open ? -64 : 0} transition={T} delay={40}>
            <button className="blob small" aria-label="Log" onClick={() => setLogOpen(v => !v)}><List /></button>
          </Liquid.Item>
          <Liquid.Item>
            <button className={`blob main ${phase} ${busy ? 'busy' : ''}`} aria-label="Speak"
              onPointerDown={() => void speakDown()} onPointerUp={speakUp}><Mic /></button>
          </Liquid.Item>
        </Liquid>
      </div>
      {phase === 'ask' && (
        <div className="caption">
          Speech needs a one-time download (~{DOWNLOAD_MB} MB). <button className="link" onClick={() => void download()}>Download</button>
        </div>
      )}
      {phase === 'downloading' && <div className="caption">Downloading speech… {percent}%</div>}
      {phase !== 'ask' && phase !== 'downloading' && caption && <div className="caption" title={caption}>{caption}</div>}
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
