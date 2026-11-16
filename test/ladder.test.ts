// When Blob hands a request to the next model, and when it never does.
import { describe, expect, it } from 'vitest';
import type { Call } from '../src/brain.ts';
import { continueText, firstTier, stepUp, userDecided } from '../src/ladder.ts';

// `line` stands for the whole result here: the parser marks a call as the user's decision from that (brain.ts).
const call = (server: string, tool: string, line: string, outcome = line.match(/^\[(\w+)/)?.[1] ?? 'ok'): Call =>
  ({ server, tool, args: {}, outcome, line, ...(userDecided(server, line) && { decided: true }) });
const notFound = call('clawdcursor', 'accessibility', '[failed · NOT_FOUND · hint: read the tree first]');
const cantMove = call('files', 'move', '[failed · CANT_MOVE · hint: busy]');
const cantRun = call('files', 'run', '[failed · CANT_RUN · hint: spawn failed]');
const three = [notFound, cantMove, cantRun];
type In = Parameters<typeof stepUp>[0];
const up = (o: Partial<In> = {}) => stepUp({ brain: 'claude', model: 'auto', tier: 'haiku', halted: false, sawResult: true, resultError: false, calls: [], ...o });

describe('stepping up', () => {
  it('when the run used up its steps (an error result too)', () => {
    expect(up({ stop: 'max_turns', resultError: true })).toEqual({ tier: 'sonnet', why: 'it ran out of steps' });
  });

  it('when the model asked for it', () => {
    expect(up({ calls: [call('blob', 'step_up', 'Noted. End your turn now with no reply text.')] })).toEqual({ tier: 'sonnet', why: 'it asked for a stronger model' });
  });

  it('when three steps failed, on Haiku and on Sonnet', () => {
    expect(up({ calls: three })).toEqual({ tier: 'sonnet', why: 'its steps kept failing' });
    expect(up({ calls: [notFound, cantMove, call('clawdcursor', 'computer', '[refused · FENCED · hint: outside the window]')] })?.tier).toBe('sonnet');
    expect(up({ calls: [notFound, cantMove, call('clawdcursor', 'system', 'boom', 'error')] })?.tier).toBe('sonnet');
    expect(up({ tier: 'sonnet', calls: three })).toEqual({ tier: 'opus', why: 'its steps kept failing' });
  });
});

describe('not stepping up', () => {
  it('for two failures, wherever they are', () => {
    expect(up({ calls: [call('files', 'make_folder', 'Made /a.\n[confirmed]', 'confirmed'), notFound, cantMove] })).toBeUndefined();
  });

  it('for looking around and finding nothing', () => {
    const times = (c: Call) => [c, c, c];
    expect(up({ calls: times(call('files', 'list_dir', '[failed · NOT_FOUND · hint: /x]')) })).toBeUndefined();
    expect(up({ calls: times(call('files', 'run', '[failed · EXIT_1 · hint: the command ended with an error; its output is above]')) })).toBeUndefined();
    expect(up({ calls: times(call('', 'Read', 'File does not exist.', 'error')) })).toBeUndefined();
  });

  it('after the user said No, pressed Stop or took the screen back, even out of steps', () => {
    for (const code of ['USER_SAID_NO', 'STOPPED', 'NOT_CONFIRMED', 'PAUSED']) {
      const said = call(code === 'USER_SAID_NO' ? 'files' : 'clawdcursor', 'run', `[refused · ${code} · hint: leave it]`);
      expect(said.decided, code).toBe(true);
      expect(up({ calls: [...three, said] }), code).toBeUndefined();
      expect(up({ calls: [said], stop: 'max_turns', resultError: true }), code).toBeUndefined();
    }
    for (const status of ['ended', 'timed_out']) {
      const pause = call('clawdcursor', 'system', `{"status":"${status}","message":"Sign in"}`);
      expect(up({ calls: [...three, pause], stop: 'max_turns', resultError: true }), status).toBeUndefined();
    }
    expect(userDecided('clawdcursor', '{"status":"replied","choice":"Yes"}')).toBe(false);
    expect(userDecided('', 'the log says · STOPPED')).toBe(false);          // a built-in read is never the user's word
    // a No on one of Blob's own cards (a scheduled task, a setting) counts too: the next model must not ask again
    expect(up({ calls: [call('blob', 'schedule_add', '[refused · USER_SAID_NO · hint: nothing changed]'), call('blob', 'step_up', 'Noted.')] })).toBeUndefined();
  });

  it('after a batch the user stopped: it has no outcome line, only its steps\' words', () => {
    for (const text of [
      'batch: stopped by the user — they took control back, and nothing runs until they give it back. Do not retry.',
      'batch: 1/3 completed, halted at step 1 — step 1 (computer · click) errored\nstep 1: not confirmed: confirm mode asked the user whether to click Send, and they said no — nothing was sent.',
      'batch: 2/2 completed\nstep 0: ok\nstep 1: {"status":"ended","message":"Sign in"}',
    ]) {
      expect(up({ calls: [...three, call('clawdcursor', 'batch', text, 'error')], stop: 'max_turns', resultError: true }), text).toBeUndefined();
    }
    expect(up({ calls: [notFound, cantMove, call('clawdcursor', 'batch', 'batch: 1/3 completed, halted at step 1 — step 1 (computer · click) errored', 'error')] })?.tier).toBe('sonnet');
  });

  it('for an error a stronger model would only repeat', () => {
    expect(up({ calls: three, resultError: true, stop: 'api_error' })).toBeUndefined();
  });

  it('from Opus, a pinned model, Codex, a stopped run or one with no result', () => {
    const stuck = { calls: [...three, call('blob', 'step_up', 'Noted.')], stop: 'max_turns', resultError: true };
    expect(up(stuck)?.tier).toBe('sonnet');
    expect(up({ ...stuck, tier: 'opus' })).toBeUndefined();
    expect(up({ ...stuck, model: 'haiku' })).toBeUndefined();
    expect(up({ ...stuck, brain: 'codex' })).toBeUndefined();
    expect(up({ ...stuck, halted: true })).toBeUndefined();
    expect(up({ ...stuck, sawResult: false })).toBeUndefined();
  });
});

describe('the ladder', () => {
  it('starts auto on Haiku and a pinned model on itself', () => {
    expect(firstTier('auto')).toBe('haiku');
    expect(firstTier('opus')).toBe('opus');
    expect(firstTier('default')).toBe('default');
  });

  it('tells the next model why, and not to redo what worked', () => {
    const t = continueText('x');
    expect(t).toContain('(x)');
    expect(t).toContain('Do not redo');
    expect(t).toContain('said No');
    expect(t).toContain('Never mention this hand-off');
  });
});
