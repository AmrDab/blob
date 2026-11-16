// The real "app in front" reader of mac.ts, against a fake koffi: it is loaded more than once at start-up (the
// pill's keeper, the bubble's keeper, the pill's keyboard check), and koffi refuses a second type with the same name.
import { describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => {
  const names = new Set<string>(), sent: string[] = [];
  const NSAPP = { nsapp: true }, KEY = { win: true }, TITLE = { title: true };
  // objc_msgSend by its declared answer: an object, a bool or a C string
  const msg = (ret: string) => (obj: unknown, sel: string) => {
    sent.push(sel);
    if (ret === 'bool') return sel === 'isActive';
    if (ret === 'const char *') return obj === TITLE ? 'Blob pill' : null;
    return sel === 'sharedApplication' ? NSAPP : sel === 'keyWindow' ? KEY : sel === 'title' ? TITLE : null;
  };
  const func = (decl: string) => {
    if (decl.includes('sel_registerName')) return (name: string) => name;
    if (decl.includes('objc_getClass')) return (name: string) => ({ cls: name });
    if (decl.includes('objc_msgSend')) return msg(decl.slice(0, decl.indexOf('objc_msgSend')).trim());
    return () => null;
  };
  const koffi = {
    load: () => ({ func }),
    proto(decl: string) {
      const name = /(\w+)\(/.exec(decl)![1];
      if (names.has(name)) throw new Error(`Duplicate type name '${name}'`);
      names.add(name);
      return name;
    },
    pointer: (t: unknown) => t,
    register: () => ({}),
  };
  return { koffi, sent };
});
vi.mock('node:module', () => ({ createRequire: () => () => k.koffi }));

import { loadFrontApp, loadObjC } from '../src/mac.ts';

describe('the real runtime, loaded more than once', () => {
  it('is made once: no second type of the same name', () => {
    expect(loadObjC()).toBe(loadObjC());
    expect(() => { loadFrontApp(); loadFrontApp(); }).not.toThrow();
  });

  it('asks the app itself whether Blob is active, and for the title of its window with the keyboard', () => {
    const front = loadFrontApp();
    expect(front.selfActive()).toBe(true);
    expect(k.sent).toContain('isActive');
    expect(front.keyTitle()).toBe('Blob pill');
  });
});
