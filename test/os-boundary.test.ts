// The rule src/os/ exists for: no file outside it asks which operating system this is. The lists below name the
// files that still do. They may only shrink: a file that stops is taken off its list, and none is ever added.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');
const slashes = (f: string) => f.replaceAll('\\', '/');
const all = (readdirSync(SRC, { recursive: true }) as string[]).map(slashes).filter(f => /\.tsx?$/.test(f)).sort();
const inOs = (f: string) => f.startsWith('os/');
const text = (f: string) => readFileSync(join(SRC, f), 'utf8');
const having = (re: RegExp) => all.filter(f => !inOs(f) && re.test(text(f)));

/** The files that still name a system. */
const NAMES = [
  'brain.ts', 'clickthrough.ts', 'computer.ts', 'focus.ts', 'mac.ts', 'main.ts', 'overlay.ts',
  'own-ui.ts', 'persona.ts', 'setup.ts', 'shell.ts', 'watch.ts',
];
/** The pages that still ask the browser (the host will tell them instead). */
const PAGES = ['ui/main.tsx', 'ui/pill.tsx'];

/** The files a file loads when it runs (`import type` loads nothing). */
const imports = (f: string) => [...text(f).matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)]
  .map(m => slashes(relative(SRC, resolve(SRC, dirname(f), m[1]))));

describe('the operating system boundary', () => {
  it('process.platform is read only in src/os/', () => {
    expect(having(/process\.platform/)).toEqual([]);
  });

  it('a system is named only in src/os/, and in the files still on the list', () => {
    expect(having(/['"](win32|darwin|linux)['"]/)).toEqual(NAMES);
  });

  it('only the pages still on the list ask the browser', () => {
    expect(having(/navigator\.platform/)).toEqual(PAGES);
  });

  it('nothing src/os/ loads loads src/os/ back', () => {
    const seen = new Set<string>(), queue = all.filter(inOs);
    for (let f = queue.pop(); f; f = queue.pop()) {
      for (const i of imports(f)) if (!inOs(i) && !seen.has(i)) { seen.add(i); queue.push(i); }
    }
    expect([...seen].filter(f => imports(f).some(inOs))).toEqual([]);
  });
});
