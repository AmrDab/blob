// The keyboard hand-back on macOS, against a fake "app in front": nothing here loads a system library.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { macKeeper } from '../src/focus.ts';
import { osFor } from '../src/os/index.ts';

const ME = 100;

/** `front` is the app in front; activate() brings another one there unless it has quit. */
function fake(front: number) {
  const state = { front, active: undefined as boolean | undefined, activated: [] as number[] };
  const mac = {
    frontPid: () => state.front,
    selfActive: () => state.active ?? state.front === ME,
    keyTitle: () => '',
    activate: (pid: number) => { state.activated.push(pid); state.front = pid; return true; },
  };
  return { state, load: () => mac };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the focus hand-back on macOS', () => {
  it('gives the front back to the app the user was in, once Blob is in front', () => {
    const f = fake(7);
    const k = macKeeper(f.load, ME);
    vi.advanceTimersByTime(150);                   // app 7 is seen in front
    f.state.front = ME;                            // a click on the bubble
    vi.advanceTimersByTime(300);                   // Blob itself is never remembered
    k.restore();
    expect(f.state.activated).toEqual([7]);
    expect(f.state.front).toBe(7);
    k.stop();
  });

  it('goes by Blob being active, not by the system\'s "app in front", which can lag a click', () => {
    const f = fake(7);
    const k = macKeeper(f.load, ME);
    vi.advanceTimersByTime(150);
    f.state.active = true;                         // the click was handled; frontPid still says 7
    k.restore();
    expect(f.state.activated).toEqual([7]);
    k.stop();
  });

  it('does nothing while another app is in front, or before any was seen', () => {
    const f = fake(ME);
    const k = macKeeper(f.load, ME);
    vi.advanceTimersByTime(300);
    k.restore();                                   // nothing to go back to
    f.state.front = 7;
    vi.advanceTimersByTime(150);
    f.state.front = 8;                             // the user moved on by themselves: not pulled back
    k.restore();
    expect(f.state.activated).toEqual([]);
    k.stop();
  });

  it('stops looking after stop()', () => {
    const f = fake(7);
    const k = macKeeper(f.load, ME);
    k.stop();
    vi.advanceTimersByTime(600);
    f.state.front = ME;
    k.restore();
    expect(f.state.activated).toEqual([]);
  });

  it('does nothing, and says so, where the runtime cannot be loaded', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const k = macKeeper(() => { throw new Error('no libobjc'); }, ME);
    expect(() => { k.restore(); k.stop(); }).not.toThrow();
    expect(log.mock.calls[0][0]).toContain('focus hand-back unavailable (no libobjc)');
  });

  it('a call that throws later is no crash', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let bad = false;
    const k = macKeeper(() => ({ frontPid: () => { if (bad) throw new Error('gone'); return 7; }, activate: () => true, selfActive: () => { throw new Error('gone'); }, keyTitle: () => '' }), ME);
    bad = true;
    expect(() => { vi.advanceTimersByTime(300); k.restore(); }).not.toThrow();
    k.stop();
  });

  it('is not used on Linux', () => {
    expect(osFor('linux').focusKeeper).toBeUndefined();
  });
});
