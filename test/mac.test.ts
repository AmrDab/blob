// The macOS-only native set-up, against a fake Objective-C runtime: nothing here loads a system library.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDIT_MENU, acceptFirstClick, afterLaunch, everywhere, loadObjC, macSetup, quitOnTerminate, type ObjC } from '../src/mac.ts';

interface FakeWin { behavior: number; canHide: number }
/** A runtime with an app, its windows and a record of what was replaced and set. */
function fake(opts: { webview?: boolean; policy?: number; windows?: number[] } = {}) {
  const state = { policy: opts.policy ?? 0, sets: [] as string[] };
  const wins: FakeWin[] = (opts.windows ?? []).map(behavior => ({ behavior, canHide: 1 }));
  const nsapp = { app: true }, appClass = { cls: 'TaoApp' }, webClass = { cls: 'WryWebView' };
  const replaced = new Map<string, { cls: unknown; types: string; fn: () => boolean | void }>();
  const objc: ObjC = {
    cls: name => (name === 'NSApplication' ? { cls: name } : name === 'WryWebView' && opts.webview !== false ? webClass : null),
    classOf: obj => (obj === nsapp ? appClass : null),
    send: (_obj, sel) => (sel === 'sharedApplication' ? nsapp : sel === 'windows' ? wins : null),
    at: (obj, _sel, i) => (obj as FakeWin[])[i],
    num: (obj, sel) => (sel === 'activationPolicy' ? state.policy : sel === 'count' ? wins.length : (obj as FakeWin).behavior),
    set(obj, sel, value) {
      state.sets.push(sel);
      if (sel === 'setActivationPolicy:') state.policy = value;
      else if (sel === 'setCanHide:') (obj as FakeWin).canHide = value;
      else (obj as FakeWin).behavior = value;
    },
    replace: (cls, sel, types, fn) => { replaced.set(sel, { cls, types, fn }); },
  };
  return { objc, state, wins, replaced, appClass, webClass };
}

afterEach(() => vi.restoreAllMocks());

describe('the Edit menu', () => {
  it('has the standard editing keys and leaves the app menu (with Quit) to the window library', () => {
    expect(EDIT_MENU.items).toHaveLength(1);
    expect(EDIT_MENU.items[0].label).toBe('Edit');
    expect(EDIT_MENU.items[0].submenu?.items.map(i => i.role)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectall']);
  });
});

describe('the first click on Blob', () => {
  it("reaches the page: the web view's answer becomes yes, with the BOOL of the machine", () => {
    const arm = fake();
    expect(acceptFirstClick(arm.objc, 'arm64')).toBe(true);
    const m = arm.replaced.get('acceptsFirstMouse:')!;
    expect(m.cls).toBe(arm.webClass);
    expect(m.types).toBe('B@:@');
    expect(m.fn()).toBe(true);
    const intel = fake();
    acceptFirstClick(intel.objc, 'x64');
    expect(intel.replaced.get('acceptsFirstMouse:')!.types).toBe('c@:@');
  });

  it('is left alone when there is no web view class', () => {
    const f = fake({ webview: false });
    expect(acceptFirstClick(f.objc, 'arm64')).toBe(false);
    expect(f.replaced.size).toBe(0);
  });
});

describe('Cmd+Q', () => {
  it("runs Blob's quit just after, in place of the native terminate", async () => {
    const f = fake(), quit = vi.fn();
    quitOnTerminate(f.objc, quit);
    const m = f.replaced.get('terminate:')!;
    expect(m.cls).toBe(f.appClass);              // the class the app object really has, not NSApplication
    expect(m.types).toBe('v@:@');
    m.fn();
    expect(quit).not.toHaveBeenCalled();         // not from inside the event pump
    await new Promise(r => setImmediate(r));
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('after the launch', () => {
  it('a window is on every Space and over full-screen apps, without the flags that clash', () => {
    expect(everywhere(0)).toBe(1 | 256);
    expect(everywhere(2 | 128 | 512 | 64)).toBe(1 | 256 | 64);   // move-to-active, full-screen primary and none go; the rest stays
    expect(everywhere(everywhere(0))).toBe(everywhere(0));
  });

  it('Blob becomes an accessory app and every window is moved to every Space, once', () => {
    const f = fake({ policy: 0, windows: [0, 1, 128] });
    afterLaunch(f.objc);
    expect(f.state.policy).toBe(1);
    expect(f.wins.map(w => w.behavior)).toEqual([257, 257, 257]);
    expect(f.wins.map(w => w.canHide)).toEqual([0, 0, 0]);
    // no window can be hidden by the time the Dock icon goes
    expect(f.state.sets.indexOf('setActivationPolicy:')).toBeGreaterThan(f.state.sets.lastIndexOf('setCanHide:'));
    const changes = () => f.state.sets.filter(s => s !== 'setCanHide:').length;
    const n = changes();
    afterLaunch(f.objc);                         // again: nothing left to change
    expect(changes()).toBe(n);
  });
});

describe('the whole set-up', () => {
  it('does nothing off macOS', () => {
    const setMenu = vi.fn(), load = vi.fn(), later = vi.fn();
    macSetup({ setMenu }, () => {}, { platform: 'win32', load, later });
    macSetup({ setMenu }, () => {}, { platform: 'linux', load, later });
    expect(setMenu).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it('sets the menu, both replacements, and looks after the launch a few times', () => {
    const f = fake({ windows: [0] }), setMenu = vi.fn();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    macSetup({ setMenu }, () => {}, { platform: 'darwin', arch: 'arm64', load: () => f.objc, later: (fn, ms) => timers.push({ fn, ms }) });
    expect(setMenu).toHaveBeenCalledWith(EDIT_MENU);
    expect([...f.replaced.keys()].sort()).toEqual(['acceptsFirstMouse:', 'terminate:']);
    expect(timers.length).toBeGreaterThan(1);
    expect(f.state.policy).toBe(0);              // not before the launch: it would be set back to a regular app
    f.state.policy = 0;
    timers[0].fn();
    expect(f.state.policy).toBe(1);
    f.state.policy = 0;                          // the launch came late and made it a regular app again
    timers[1].fn();
    expect(f.state.policy).toBe(1);
  });

  it('keeps going when a step fails, and says which', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fake({ webview: false });
    f.objc.set = () => { throw new Error('boom'); };
    const timers: Array<() => void> = [];
    const setMenu = vi.fn(() => { throw new Error('no menu'); });
    expect(() => macSetup({ setMenu }, () => {}, { platform: 'darwin', load: () => f.objc, later: fn => timers.push(fn) })).not.toThrow();
    expect(f.replaced.has('terminate:')).toBe(true);           // the menu and the first-click step failed; this one still ran
    expect(() => timers.forEach(t => t())).not.toThrow();
    const lines = log.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('copy and paste') && l.includes('no menu'))).toBe(true);
    expect(lines.some(l => l.includes('first click'))).toBe(true);
    expect(lines.some(l => l.includes('Dock icon') && l.includes('boom'))).toBe(true);
    expect(lines.every(l => l.startsWith('Blob: '))).toBe(true);
  });

  it('finds the web view class when it comes later (made in the first event pump), once, and says nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const opts = { webview: false, windows: [0] }, f = fake(opts);
    const timers: Array<() => void> = [];
    macSetup({ setMenu: vi.fn() }, () => {}, { platform: 'darwin', arch: 'arm64', load: () => f.objc, later: fn => timers.push(fn) });
    expect(f.replaced.has('acceptsFirstMouse:')).toBe(false);
    timers[0]();                                 // still not made at the first look
    opts.webview = true;
    const replace = vi.spyOn(f.objc, 'replace');
    timers.slice(1).forEach(t => t());
    expect(f.replaced.get('acceptsFirstMouse:')?.cls).toBe(f.webClass);
    expect(replace).toHaveBeenCalledTimes(1);   // not again at the later looks
    expect(log).not.toHaveBeenCalled();
  });

  it('stops quietly, with the menu set, when the runtime cannot be loaded', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setMenu = vi.fn(), later = vi.fn();
    macSetup({ setMenu }, () => {}, { platform: 'darwin', load: () => { throw new Error('no library'); }, later });
    expect(setMenu).toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'darwin')('the real runtime only loads on macOS', () => {
    expect(() => loadObjC()).toThrow();
  });
});
