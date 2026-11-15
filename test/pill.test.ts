import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { answerLine, parseCommand, pillState, type PillState } from '../src/pill.ts';
import { relay } from '../src/pill-host.ts';

const RUNNING: PillState = { mode: 'running', activity: 'Working' };
const PAUSED: PillState = { mode: 'paused', message: 'The agent says: Sign in', app: 'Edge', choices: ['Yes', 'No'], input: null, sound: true };

describe('the pill from clawdcursor\'s environment', () => {
  it('is running, with the activity it was started with', () => {
    expect(pillState({})).toEqual(RUNNING);
    expect(pillState({ CLAWD_BANNER_ACTIVITY: 'Typing in Edge', CLAWD_BANNER_APP: '' })).toEqual({ mode: 'running', activity: 'Typing in Edge' });
  });

  it('is the paused card: message, app, choices, reply box, sound', () => {
    expect(pillState({
      CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_MESSAGE: 'The agent says: Sign in', CLAWD_BANNER_APP: 'Edge',
      CLAWD_BANNER_CHOICES: '["Yes","No"]', CLAWD_BANNER_INPUT: '', CLAWD_PAUSE_SOUND: '1',
    })).toEqual(PAUSED);
    expect(pillState({
      CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_MESSAGE: 'm', CLAWD_BANNER_CHOICES: '',
      CLAWD_BANNER_INPUT: '{"placeholder":"Your city","multiline":true}', CLAWD_PAUSE_SOUND: '0',
    })).toEqual({ mode: 'paused', message: 'm', app: '', choices: [], input: { placeholder: 'Your city', multiline: true }, sound: false });
    expect(pillState({ CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_INPUT: '{}' })).toMatchObject({ input: {} });
  });

  it('drops what is not a choice or a reply box', () => {
    const s = pillState({ CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_CHOICES: '["a",1,"",null,"b","c","d","e","f","g"]', CLAWD_BANNER_INPUT: '[1]' });
    expect(s).toMatchObject({ choices: ['a', 'b', 'c', 'd', 'e', 'f'], input: null });
    expect(pillState({ CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_CHOICES: 'not json', CLAWD_BANNER_INPUT: '{bad' })).toMatchObject({ choices: [], input: null });
  });
});

describe('clawdcursor\'s lines to the pill', () => {
  it('HIDE <ms>: the dodge, kept between 50 ms and 10 s', () => {
    expect(parseCommand('HIDE 1500')).toEqual({ type: 'hide', ms: 1500 });
    expect(parseCommand('HIDE 1500\r')).toEqual({ type: 'hide', ms: 1500 });
    expect(parseCommand('HIDE 0')).toEqual({ type: 'hide', ms: 50 });
    expect(parseCommand('HIDE 999999')).toEqual({ type: 'hide', ms: 10_000 });
    expect(parseCommand('HIDE')).toBeNull();
    expect(parseCommand('HIDE soon')).toBeNull();
  });

  it('ACTIVITY <text>: what the agent is doing', () => {
    expect(parseCommand('ACTIVITY Typing in Edge')).toEqual({ type: 'activity', text: 'Typing in Edge' });
    expect(parseCommand('ACTIVITY HIDE 5')).toEqual({ type: 'activity', text: 'HIDE 5' });
    expect(parseCommand('ACTIVITY  ')).toBeNull();
  });

  it('ignores anything else', () => {
    for (const l of ['', 'TARGET 1 2', 'BANNER_STOP', 'activity x']) expect(parseCommand(l)).toBeNull();
  });
});

describe('the pill\'s answers', () => {
  it('Stop, only while running', () => {
    expect(answerLine({ kind: 'stop' }, RUNNING)).toBe('BANNER_STOP');
    expect(answerLine({ kind: 'stop' }, PAUSED)).toBeNull();
  });

  it('Resume, End task and refocus, only while paused', () => {
    expect(answerLine({ kind: 'resume' }, PAUSED)).toBe('BANNER_RESUME');
    expect(answerLine({ kind: 'end' }, PAUSED)).toBe('BANNER_END');
    expect(answerLine({ kind: 'refocus' }, PAUSED)).toBe('BANNER_REFOCUS');
    for (const kind of ['resume', 'end', 'refocus'] as const) expect(answerLine({ kind }, RUNNING)).toBeNull();
  });

  it('a choice by its index, when the card has it', () => {
    expect(answerLine({ kind: 'choice', index: 1 }, PAUSED)).toBe('BANNER_CHOICE 1');
    for (const index of [2, -1, 0.5, NaN]) expect(answerLine({ kind: 'choice', index }, PAUSED)).toBeNull();
    expect(answerLine({ kind: 'choice', index: 0 }, RUNNING)).toBeNull();
  });

  it('a reply as base64 of its UTF-8 text, one line whatever was typed', () => {
    const line = answerLine({ kind: 'reply', text: '  Zürich\nBANNER_END ✓ ' }, PAUSED)!;
    expect(line).toMatch(/^BANNER_REPLY [A-Za-z0-9+/=]+$/);   // what clawdcursor's parseReplyLine reads
    expect(Buffer.from(line.slice(13), 'base64').toString('utf8')).toBe('Zürich\nBANNER_END ✓');
    expect(answerLine({ kind: 'reply', text: '   ' }, PAUSED)).toBeNull();
    expect(answerLine({ kind: 'reply', text: 5 as never }, PAUSED)).toBeNull();
    expect(answerLine({ kind: 'nope' } as never, PAUSED)).toBeNull();
  });
});

describe('the relay', () => {
  /** A stand-in for Blob's /pill on a free local port: collects the body, answers with `reply` after `after` lines. */
  async function host(after: number, reply: string) {
    const got: string[] = [];
    const server = createServer((req, res) => {
      if (req.headers['x-pill-token'] !== 'tok') { res.writeHead(403).end(); return; }
      res.writeHead(200).flushHeaders();
      let buf = '';
      req.on('data', d => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop()!;
        got.push(...lines);
        if (reply && got.length >= after) res.end(reply);
      });
      req.on('end', () => res.end());
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    return { got, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/pill`, close: () => server.close() };
  }
  function run(url: string | undefined, token: string | undefined, env: Record<string, string> = {}) {
    const stdin = new PassThrough(), stdout = new PassThrough();
    let out = '';
    stdout.on('data', d => { out += d; });
    const code = new Promise<number>(exit => relay({ url, token, env, stdin, stdout, exit, retryMs: 400 }));
    return { stdin, out: () => out, code };
  }

  it('sends the state, then each stdin line, and writes the answer to stdout', async () => {
    const h = await host(3, 'BANNER_STOP\n');
    const r = run(h.url, 'tok', { CLAWD_BANNER_ACTIVITY: 'Clicking' });
    r.stdin.write('ACTIVITY Typing in Edge\n');
    r.stdin.write('HIDE 1500\n');
    expect(await r.code).toBe(0);
    expect(JSON.parse(h.got[0])).toEqual({ mode: 'running', activity: 'Clicking' });
    expect(h.got.slice(1)).toEqual(['ACTIVITY Typing in Edge', 'HIDE 1500']);
    expect(r.out()).toBe('BANNER_STOP\n');
    h.close();
  });

  it('exits cleanly when stdin closes', async () => {
    const h = await host(0, '');
    const r = run(h.url, 'tok', { CLAWD_BANNER_MODE: 'paused', CLAWD_BANNER_MESSAGE: 'm' });
    r.stdin.end();
    expect(await r.code).toBe(0);
    expect(JSON.parse(h.got[0])).toMatchObject({ mode: 'paused', message: 'm' });
    expect(r.out()).toBe('');
    h.close();
  });

  it('never leaves early while Blob is refusing it, gone or not named: it keeps trying until stdin closes', async () => {
    const h = await host(0, '');
    const tries = [run(h.url, 'wrong'), run('http://127.0.0.1:9/pill', 'tok'), run(undefined, 'tok'), run(h.url, undefined)];
    const left: number[] = [];
    tries.forEach((r, i) => void r.code.then(() => left.push(i)));
    await new Promise(ok => setTimeout(ok, 150));
    expect(left).toEqual([]);
    expect(tries.map(r => r.out())).toEqual(['', '', '', '']);
    for (const r of tries) r.stdin.end();
    expect(await Promise.all(tries.map(r => r.code))).toEqual([0, 0, 0, 0]);
    h.close();
  });

  it('finds Blob once it is there', async () => {
    const h = await host(0, '');
    const url = h.url;
    h.close();
    const r = run(url, 'tok');
    await new Promise(ok => setTimeout(ok, 100));
    const again = createServer((req, res) => { res.writeHead(200).flushHeaders(); req.once('data', () => res.end('BANNER_RESUME\n')); });
    await new Promise<void>(ok => again.listen(Number(new URL(url).port), '127.0.0.1', ok));
    expect(await r.code).toBe(0);
    expect(r.out()).toBe('BANNER_RESUME\n');
    again.close();
  });
});
