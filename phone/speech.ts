// The parts of the phone's speech recognition that need no browser: what was said, and what to tell the user
// when recognition fails.

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();   // words only: no case, no punctuation
const starts = (a: string, b: string) => b === a || b.startsWith(a + ' ');            // b begins with all of a's words

/** What was said, rebuilt from the whole result list on every event (finals, then the interim one). iPhone Safari
 *  can send a phrase again, or again with more words on the end: those repeats are dropped. */
export function transcript(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  const kept: string[] = [];
  for (const r of Array.from(results)) {
    const t = String(r[0]?.transcript ?? '').trim(), k = key(t), prev = key(kept[kept.length - 1] ?? '');
    if (!k) continue;
    if (prev && starts(prev, k)) kept[kept.length - 1] = t;   // the last phrase again, with more on the end
    else if (!starts(k, prev)) kept.push(t);                  // not just the last phrase (or its start) again
  }
  return kept.join(' ');
}

const TYPE = ' You can type instead.';
/** The line to show for a recognition error, and whether voice is off until something changes (the text field
 *  then stays open). Nothing for 'no-speech' and unknown codes: those read as "Didn't catch that." */
export function voiceError(code: string): { note: string; off: boolean } | undefined {
  switch (code) {
    case 'not-allowed': return { note: 'This browser did not allow the microphone.' + TYPE, off: true };
    // iPhone: Siri & Dictation off, a restriction, or another app's browser. 'aborted' is how the first of these can arrive.
    case 'service-not-allowed':
    case 'aborted': return { note: 'Voice is not available here. Check that Dictation is on in Settings, or scan the code with the Camera app.' + TYPE, off: true };
    case 'language-not-supported': return { note: "Voice is not available in this phone's language." + TYPE, off: true };
    case 'audio-capture': return { note: 'The microphone is busy. Try again, or type.', off: false };
    case 'network': return { note: 'Voice needs a connection right now. Try again, or type.', off: false };
  }
}

export const QUIET_MS = 8000;   // listening, and nothing new for this long: the turn is ended here (an iPhone's recognition can go dead without saying so)
export const PAUSE_MS = 2000;   // iPhone, after the first words: a pause this long ends the turn, if iOS does not end it itself
export const TAIL_MS = 500;     // iPhone, after the tap or release that ends a turn: the last words are still on their way

type Why = 'end' | 'error' | 'quiet' | 'tap';   // recognition ended by itself, ended after an error, went quiet, or the user ended it

/** One listening turn on a recognition object. `cut` (iPhone): the turn is ended with abort(), never stop(), which
 *  leaves every later turn deaf there. `done` is called once, with what was said; after drop(), never. */
export function turn(r: any, o: { cut: boolean; heard(said: string): void; error(err: { note: string; off: boolean }): void; done(said: string, why: Why): void }) {
  let said = '', over = false, began = false, failed = false, closing = false, timer: ReturnType<typeof setTimeout> | undefined;
  const close = (why: Why) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (why !== 'end' && why !== 'error') r.abort();
    o.done(said.trim(), why);
  };
  const arm = (ms: number, why: Why) => { clearTimeout(timer); timer = setTimeout(() => close(why), ms); };
  r.onstart = () => { began = true; };
  r.onresult = (e: any) => {
    if (over) return;
    said = transcript(e.results);
    o.heard(said);
    if (!closing) arm(o.cut && said.trim() ? PAUSE_MS : QUIET_MS, 'quiet');
  };
  r.onerror = (e: any) => {
    if (over || (e.error === 'aborted' && began)) return;   // aborted after it began: a call, Siri, the lock screen. Not "voice is off".
    const err = voiceError(e.error);
    if (!err) return;
    failed = true;
    o.error(err);
  };
  r.onend = () => close(failed ? 'error' : 'end');
  return {
    /** Starts listening, now or after `delay` ms (a drop() before then cancels it). */
    start(delay = 0) {
      const go = () => {
        if (over) return;
        try { r.start(); arm(QUIET_MS, 'quiet'); } catch { over = true; o.done('', 'error'); }
      };
      if (delay) setTimeout(go, delay); else go();
    },
    /** The user is done: the turn is sent with what was heard. */
    finish() {
      if (over) return;
      if (!o.cut) return r.stop();
      closing = true;
      arm(TAIL_MS, 'tap');
    },
    /** Ends the turn without sending it. */
    drop() {
      if (over) return;
      over = true;
      clearTimeout(timer);
      r.abort();
    },
  };
}
