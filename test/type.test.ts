import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PLAIN, alphaRow, commandLines, fuseOf, gooAt, gooBlur, letters, swapper, tokens } from '../src/ui/type.ts';

describe('a line as words', () => {
  it('keeps every character, and marks spaces and numbers', () => {
    const t = tokens('Downloading speech…  42%');
    expect(t.map(x => x.text).join('')).toBe('Downloading speech…  42%');
    expect(t.map(x => x.space)).toEqual([false, true, false, true, false]);
    expect(t.map(x => x.num)).toEqual([false, false, false, false, true]);
  });
  it('keeps names outside English whole', () => {
    expect(tokens('email Renée and Łukasz').filter(x => !x.space).map(x => x.text)).toEqual(['email', 'Renée', 'and', 'Łukasz']);
  });
  it('is empty for no text', () => { expect(tokens('')).toEqual([]); });
});

describe('the droplets of a title', () => {
  it('splits around each i and finds the closing full stop', () => {
    expect(letters('it.')).toEqual({ parts: ['i', 't'], stop: true });
    expect(letters('Finish')).toEqual({ parts: ['F', 'i', 'n', 'i', 'sh'], stop: false });
  });
  it('leaves an ellipsis, a lone dot and a capital I alone', () => {
    expect(letters('wait...').stop).toBe(false);
    expect(letters('.').stop).toBe(false);
    expect(letters('It').parts).toEqual(['It']);
  });
  it('gives the word back', () => {
    for (const w of ['it.', 'Finish', 'Blob', 'iii', '19:30']) { const l = letters(w); expect(l.parts.join('') + (l.stop ? '.' : '')).toBe(w); }
  });
});

describe('a command shown word for word', () => {
  const cmd = 'Remove-Item -Recurse "C:\\Users\\me\\Downloads\\old builds"\ncurl https://example.com/a/b';
  it('is the same text when joined back', () => {
    expect(commandLines(cmd).map(l => l.join('')).join('\n')).toBe(cmd);
    expect(commandLines('')).toEqual([['']]);
    expect(commandLines('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });
  it('may wrap only after a path separator', () => {
    const [first, second] = commandLines(cmd);
    expect(first).toEqual(['Remove-Item -Recurse "C:\\', 'Users\\', 'me\\', 'Downloads\\', 'old builds"']);
    expect(second).toEqual(['curl https://', 'example.com/', 'a/', 'b']);
  });
});

describe('the goo filter', () => {
  it('is all goo at 1 and exactly the rest frame at 0', () => {
    expect(alphaRow(gooAt(1, gooBlur(13), PLAIN))).toBe('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20.000 -2.500');
    expect(gooAt(0, gooBlur(13), PLAIN)).toEqual(PLAIN);
    expect(alphaRow(PLAIN)).toBe('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.000 0.000');   // the identity: removing the filter shows no step
    expect(gooAt(0, gooBlur(15), fuseOf(15))).toEqual(fuseOf(15));
  });
  it('scales with the font size, within limits', () => {
    expect(gooBlur(8)).toBe(2.2);
    expect(gooBlur(13)).toBeCloseTo(2.6);
    expect(gooBlur(84)).toBe(9);
    expect(fuseOf(15)).toEqual({ sd: 0.6, slope: 2.5, at: 0.35 });
    expect(fuseOf(84).sd).toBeCloseTo(2.94);
  });
});

describe('swapping lines, latest wins', () => {
  type L = { id: string };
  function rig() {
    const log: string[] = [];
    let release = () => {};
    const gate = () => new Promise<void>(r => { release = r; });
    const set = swapper<L>({
      same: (a, b) => a?.id === b?.id,
      hide: async (old, next) => { log.push(`hide ${old.id}>${next?.id ?? '-'}`); await gate(); },
      show: async next => { log.push(`show ${next?.id ?? '-'}`); },
      form: async next => { log.push(`form ${next.id}`); await gate(); },
    });
    return { log, set, step: async () => { release(); await new Promise(r => setTimeout(r, 0)); } };
  }
  it('shows the first line without hiding anything', async () => {
    const r = rig();
    void r.set({ id: 'a' });
    await r.step();
    expect(r.log).toEqual(['show a', 'form a']);
  });
  it('ends on the last of a burst and skips the ones never shown', async () => {
    const r = rig();
    void r.set({ id: 'a' });
    void r.set({ id: 'b' });
    void r.set({ id: 'c' });
    void r.set({ id: 'd' });
    for (let i = 0; i < 6; i++) await r.step();
    expect(r.log).toEqual(['show a', 'form a', 'hide a>d', 'show d', 'form d']);
  });
  it('takes a line that arrives while the old one is going', async () => {
    const r = rig();
    void r.set({ id: 'a' });
    await r.step();                       // a formed
    await r.step();
    void r.set({ id: 'b' });              // hide a is running
    void r.set({ id: 'c' });
    for (let i = 0; i < 4; i++) await r.step();
    expect(r.log.slice(2)).toEqual(['hide a>b', 'show c', 'form c']);
  });
  it('clears, and does nothing for the same line again', async () => {
    const r = rig();
    void r.set({ id: 'a' });
    for (let i = 0; i < 2; i++) await r.step();
    void r.set({ id: 'a' });
    await r.step();
    expect(r.log).toEqual(['show a', 'form a']);
    void r.set(null);
    for (let i = 0; i < 3; i++) await r.step();
    expect(r.log.slice(2)).toEqual(['hide a>-', 'show -']);
    void r.set({ id: 'b' });
    for (let i = 0; i < 2; i++) await r.step();
    expect(r.log.slice(4)).toEqual(['show b', 'form b']);
  });
  it('keeps going after a step throws', async () => {
    let fail = true;
    const seen: string[] = [];
    const set = swapper<L>({
      same: (a, b) => a?.id === b?.id, hide: async () => {}, form: async () => {},
      show: async next => { if (fail) { fail = false; throw new Error('x'); } seen.push(next?.id ?? '-'); },
    });
    await expect(set({ id: 'a' })).rejects.toThrow('x');
    await set({ id: 'b' });
    expect(seen).toContain('b');
  });
});

// ── the stylesheets: the fonts are local files, Inter is gone, and text on the light liquid passes AA ──
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

describe('the type in the stylesheets', () => {
  const app = readFileSync('src/ui/style.css', 'utf8'), phone = readFileSync('phone/style.css', 'utf8');
  it('loads only fonts that are bundled, with latin and latin-ext for each family', () => {
    for (const css of [app, phone]) {
      const files = [...css.matchAll(/url\(\/?fonts\/([^)]+)\)/g)].map(m => m[1]);
      expect(files.length).toBeGreaterThanOrEqual(4);
      for (const f of files) expect(existsSync(`site/fonts/${f}`), f).toBe(true);
      for (const fam of ['fraunces-latin', 'geist-latin']) expect(files.filter(f => f.startsWith(fam)).length).toBe(2);
      expect(css).not.toMatch(/Inter|https?:\/\//);
    }
    expect(app.match(/geist-mono-latin/g)?.length).toBe(2);
    expect(existsSync('site/fonts/LICENSE.txt')).toBe(true);
    for (const b of ['build.mjs', 'phone/build.mjs']) expect(readFileSync(b, 'utf8')).toMatch(/site.{1,6}fonts/);
  });
  it('never breaks a command in the middle of a word by rule', () => {
    expect(app).not.toMatch(/word-break:\s*break-all/);
  });
  it('keeps every text colour at 4.5:1 or better on the liquid, also near the edge of a card', () => {
    const colours = new Set([...app.matchAll(/(?<![-\w])color:\s*(#[0-9a-f]{6})\b/g)].map(m => m[1]));
    expect(colours.size).toBeGreaterThan(5);
    // the darkest grey under text: 12 px in from a card's edge, where the liquid is still rounding off (shader.ts)
    for (const c of colours) expect(contrast(c, '#e0e0e0'), c).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', '#1c1c1e')).toBeGreaterThanOrEqual(4.5);   // the strong button: white on ink
  });
});
