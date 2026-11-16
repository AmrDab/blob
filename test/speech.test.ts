import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAUSE_MS, QUIET_MS, TAIL_MS, transcript, turn, voiceError } from '../phone/speech.ts';

const list = (...phrases: string[]) => phrases.map(p => [{ transcript: p }]);

describe('transcript', () => {
  it('joins a correct list: the finals, then the interim one', () => {
    expect(transcript(list('open my email', 'and read the newest one'))).toBe('open my email and read the newest one');
    expect(transcript(list(' open my email ', ' and read it'))).toBe('open my email and read it');
    expect(transcript([])).toBe('');
  });
  it('drops a phrase that is sent again (Safari 14.1 to 16)', () => {
    expect(transcript(list('open my email', 'open my email', 'open my email'))).toBe('open my email');
  });
  it('keeps the longer one when a phrase is sent again with more on the end (iPhone, continuous)', () => {
    expect(transcript(list('hello', 'hello world'))).toBe('hello world');
    expect(transcript(list('hello', 'hello world', 'hello world how are you'))).toBe('hello world how are you');
    expect(transcript(list('hello world', 'hello'))).toBe('hello world');
  });
  it('sees a repeat through capitals and punctuation, and keeps the newest wording', () => {
    expect(transcript(list('open my email', 'Open my email.'))).toBe('Open my email.');
    expect(transcript(list('Open my email.', 'open my email and read it'))).toBe('open my email and read it');
  });
  it('compares whole words: a phrase that only starts with the same letters is kept', () => {
    expect(transcript(list('a', 'and then close it'))).toBe('a and then close it');
    expect(transcript(list('no', 'not that one'))).toBe('no not that one');
  });
  it('keeps words the speaker repeated inside one phrase, and skips empty results', () => {
    expect(transcript(list('no no no', '', 'stop'))).toBe('no no no stop');
  });
  it("reads a browser's result list: not an array, each result with isFinal", () => {
    const results = { length: 2, 0: { length: 1, isFinal: true, 0: { transcript: 'open my email', confidence: 0.9 } }, 1: { length: 1, isFinal: false, 0: { transcript: ' and read it', confidence: 0 } } };
    expect(transcript(results)).toBe('open my email and read it');
  });
  // Accepted: only a phrase that starts with all of the last one's words replaces it. Dropping on "most words the
  // same" would also drop a real second phrase ("open my email", "open my calendar").
  it('keeps both when a later phrase changes an earlier word', () => {
    expect(transcript(list('open my male', 'open my mail and read it'))).toBe('open my male open my mail and read it');
  });
});

describe('voiceError', () => {
  it('blames the microphone only when the microphone was refused', () => {
    expect(voiceError('not-allowed')).toMatchObject({ note: expect.stringContaining('microphone'), off: true });
    for (const code of ['service-not-allowed', 'aborted', 'language-not-supported']) {
      expect(voiceError(code)!.off).toBe(true);
      expect(voiceError(code)!.note).not.toContain('microphone');
    }
  });
  it('leaves voice on for errors that pass, and says nothing for no-speech', () => {
    expect(voiceError('audio-capture')!.off).toBe(false);
    expect(voiceError('network')!.off).toBe(false);
    expect(voiceError('no-speech')).toBeUndefined();
  });
});

describe('turn', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const make = (cut = true, start?: () => void) => {
    const r: any = { calls: [] as string[], start() { start?.(); r.calls.push('start'); }, stop() { r.calls.push('stop'); }, abort() { r.calls.push('abort'); } };
    const log: unknown[][] = [];
    const t = turn(r, { cut, heard: s => log.push(['heard', s]), error: e => log.push(['error', e.off]), done: (s, why) => log.push(['done', s, why]) });
    return { r, t, log, result: (...p: string[]) => r.onresult({ results: list(...p) }) };
  };

  it('result, end: sends what was heard', () => {
    const { r, t, log, result } = make();
    t.start(); r.onstart(); result('open my email'); r.onend();
    expect(log).toEqual([['heard', 'open my email'], ['done', 'open my email', 'end']]);
    expect(r.calls).toEqual(['start']);
  });
  it('end with nothing heard; a result after the end is not used', () => {
    const { r, t, log, result } = make();
    t.start(); r.onend(); result('late'); r.onend();
    vi.advanceTimersByTime(QUIET_MS);
    expect(log).toEqual([['done', '', 'end']]);
  });
  it('no-speech, end: no error line', () => {
    const { r, t, log } = make();
    t.start(); r.onerror({ error: 'no-speech' }); r.onend();
    expect(log).toEqual([['done', '', 'end']]);
  });
  it('aborted before recognition began: voice is off', () => {
    const { r, t, log } = make();
    t.start(); r.onerror({ error: 'aborted' }); r.onend();
    expect(log).toEqual([['error', true], ['done', '', 'error']]);
  });
  it('aborted after it began (a call, the lock screen): not an error, and what was heard is sent', () => {
    const { r, t, log } = make();
    t.start(); r.onstart(); r.onerror({ error: 'aborted' }); r.onend();
    expect(log).toEqual([['done', '', 'end']]);
    const b = make();
    b.t.start(); b.r.onstart(); b.result('open my email'); b.r.onerror({ error: 'aborted' }); b.r.onend();
    expect(b.log.at(-1)).toEqual(['done', 'open my email', 'end']);
  });
  it('an error that passes, then the end: the error line, nothing sent', () => {
    const { r, t, log } = make();
    t.start(); r.onstart(); r.onerror({ error: 'network' }); r.onend();
    expect(log).toEqual([['error', false], ['done', '', 'error']]);
  });
  it('silence: ended here after QUIET_MS', () => {
    const { r, t, log } = make();
    t.start();
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual([['done', '', 'quiet']]);
    expect(r.calls).toEqual(['start', 'abort']);
  });
  it('a result, then silence: sent after PAUSE_MS on an iPhone, after QUIET_MS elsewhere', () => {
    const a = make(true);
    a.t.start(); a.result('turn it up');
    vi.advanceTimersByTime(PAUSE_MS - 1); a.result('turn it up please');
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(a.log.at(-1)).toEqual(['heard', 'turn it up please']);
    vi.advanceTimersByTime(1);
    expect(a.log.at(-1)).toEqual(['done', 'turn it up please', 'quiet']);
    expect(a.r.calls).toEqual(['start', 'abort']);
    const b = make(false);
    b.t.start(); b.result('turn it up');
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(b.log.at(-1)).toEqual(['heard', 'turn it up']);
    vi.advanceTimersByTime(1);
    expect(b.log.at(-1)).toEqual(['done', 'turn it up', 'quiet']);
  });
  it('finish on an iPhone: abort, never stop, after the last words have had TAIL_MS to arrive', () => {
    const { r, t, log, result } = make(true);
    t.start(); result('close the');
    t.finish(); result('close the window');
    vi.advanceTimersByTime(TAIL_MS);
    expect(log.at(-1)).toEqual(['done', 'close the window', 'tap']);
    expect(r.calls).toEqual(['start', 'abort']);
    r.onend();
    expect(log.filter(l => l[0] === 'done')).toHaveLength(1);
    const none = make(true);                       // a tap by mistake, and a second tap
    none.t.start(); none.t.finish();
    vi.advanceTimersByTime(TAIL_MS);
    expect(none.log).toEqual([['done', '', 'tap']]);
  });
  it('finish elsewhere: stop(), and the turn is sent at its end', () => {
    const { r, t, log, result } = make(false);
    t.start(); result('close the'); t.finish();
    expect(r.calls).toEqual(['start', 'stop']);
    result('close the window'); r.onend();
    expect(log.at(-1)).toEqual(['done', 'close the window', 'end']);
  });
  it('drop (an answer or a question arrives): nothing is sent, also when the end comes late', () => {
    const { r, t, log, result } = make();
    t.start(); result('close the'); t.drop(); result('close the window'); r.onend();
    vi.advanceTimersByTime(QUIET_MS);
    expect(log).toEqual([['heard', 'close the']]);
    expect(r.calls).toEqual(['start', 'abort']);
  });
  it('a delayed start: waits, and a drop before then cancels it', () => {
    const a = make();
    a.t.start(400);
    vi.advanceTimersByTime(399);
    expect(a.r.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(a.r.calls).toEqual(['start']);
    const b = make();
    b.t.start(400); b.t.drop();
    vi.advanceTimersByTime(QUIET_MS + 400);
    expect(b.r.calls).toEqual(['abort']);
    expect(b.log).toEqual([]);
  });
  it('start() that throws: the turn is over, nothing sent', () => {
    const { t, log } = make(true, () => { throw new Error('busy'); });
    t.start();
    vi.advanceTimersByTime(QUIET_MS);
    expect(log).toEqual([['done', '', 'error']]);
  });
});
