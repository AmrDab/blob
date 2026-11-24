import { describe, expect, it } from 'vitest';
import { firstName, greeting, wakeMatcher } from '../src/wake.ts';

const typing = () => {
  let woke = 0;
  const m = wakeMatcher(() => { woke++; });
  const type = (s: string) => { for (const c of s) m.char(c); };
  return { m, type, woke: () => woke };
};

describe('wakeMatcher', () => {
  it('wakes on "hey blob" and "hi blob", in any case', () => {
    for (const s of ['hey blob', 'Hi Blob', 'HEY BLOB', 'hey, blob', 'so hey  blob']) {
      const t = typing(); t.type(s); expect(t.woke(), s).toBe(1);
    }
  });

  it('wakes once per phrase', () => {
    const t = typing(); t.type('hey blob hey blob'); expect(t.woke()).toBe(2);
  });

  it('needs the phrase at the start of a word', () => {
    for (const s of ['they blob', 'ohi blob', 'hey blo', 'hey bloc', 'heyblob']) {
      const t = typing(); t.type(s); expect(t.woke(), s).toBe(0);
    }
  });

  it('follows Backspace', () => {
    const t = typing(); t.type('hey blib'); t.m.back(); t.m.back(); t.type('ob'); expect(t.woke()).toBe(1);
  });

  it('forgets what came before an arrow, a click, Return or Tab', () => {
    const t = typing(); t.type('hey '); t.m.reset(); t.type('blob'); expect(t.woke()).toBe(0);
    t.type('hey\nblob'); expect(t.woke()).toBe(0);
    t.type('hey\tblob'); expect(t.woke()).toBe(0);
  });

  it('keeps only the last few characters', () => {
    const t = typing(); t.type('x'.repeat(1000) + ' hey blob'); expect(t.woke()).toBe(1);
  });
});

describe('greeting', () => {
  it('uses the first name when there is one', () => {
    expect(greeting(firstName('Amr Aldabbas'))).toBe('Hey Amr, how can I help you?');
    expect(greeting(firstName('  '))).toBe('Hey, how can I help you?');
  });
});
