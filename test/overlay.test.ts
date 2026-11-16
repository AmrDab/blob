// The pill window's native side off Windows, against a fake window: no system call is made.
import type { BrowserWindow } from '@webviewjs/webview';
import { describe, expect, it, vi } from 'vitest';
import { overlay } from '../src/overlay.ts';

function fakeWin() {
  const calls: string[] = [];
  const win = {
    show: () => { calls.push('show'); }, hide: () => { calls.push('hide'); }, focus: () => { calls.push('focus'); },
    setContentProtection: () => { calls.push('protect'); },
  } as unknown as BrowserWindow;
  return { win, calls };
}

describe('the pill window on macOS', () => {
  it('takes the keyboard for the reply box, and gives the front back when it closes', () => {
    const { win, calls } = fakeWin();
    const keeper = { restore: vi.fn(), stop: vi.fn() };
    const o = overlay(win, 'darwin', { keeper, mine: () => true, chime: () => {} });
    o.keyboard(true);
    expect(calls).toEqual(['protect', 'focus']);
    expect(keeper.restore).not.toHaveBeenCalled();
    o.keyboard(false);
    expect(keeper.restore).toHaveBeenCalledTimes(1);
    expect(o.asksRefocus).toBe(false);
  });

  it('leaves the front alone when the pill closes while it does not have the keyboard (the user types in the bubble)', () => {
    const keeper = { restore: vi.fn(), stop: vi.fn() };
    overlay(fakeWin().win, 'darwin', { keeper, mine: () => false, chime: () => {} }).keyboard(false);
    expect(keeper.restore).not.toHaveBeenCalled();
  });

  it('plays the pause card\'s sound', () => {
    const chime = vi.fn();
    overlay(fakeWin().win, 'darwin', { keeper: { restore() {}, stop() {} }, mine: () => true, chime }).beep();
    expect(chime).toHaveBeenCalledTimes(1);
  });
});

describe('the pill window on Linux', () => {
  it('is as before: no hand-back of its own, no sound, clawdcursor is asked to refocus', () => {
    const { win } = fakeWin();
    const keeper = { restore: vi.fn(), stop: vi.fn() }, chime = vi.fn();
    const o = overlay(win, 'linux', { keeper, mine: () => true, chime });
    o.keyboard(false);
    o.beep();
    expect(keeper.restore).not.toHaveBeenCalled();
    expect(chime).not.toHaveBeenCalled();
    expect(o.asksRefocus).toBe(true);
  });
});
