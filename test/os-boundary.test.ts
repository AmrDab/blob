// The rule src/os/ exists for: no file outside it asks which operating system this is, the pages included (the host
// tells them what they need). There is no list of exceptions.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');
const slashes = (f: string) => f.replaceAll('\\', '/');
const all = (readdirSync(SRC, { recursive: true }) as string[]).map(slashes).filter(f => /\.tsx?$/.test(f)).sort();
const inOs = (f: string) => f.startsWith('os/');
const text = (f: string) => readFileSync(join(SRC, f), 'utf8');
const having = (re: RegExp) => all.filter(f => !inOs(f) && re.test(text(f)));

/** The files a file loads when it runs (`import type` loads nothing). */
const imports = (f: string) => [...text(f).matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)]
  .map(m => slashes(relative(SRC, resolve(SRC, dirname(f), m[1]))));

describe('the operating system boundary', () => {
  it('process.platform is read only in src/os/', () => {
    expect(having(/process\.platform/)).toEqual([]);
  });

  it('a system is named only in src/os/', () => {
    expect(having(/['"](win32|darwin|linux)['"]/)).toEqual([]);
  });

  it('no page asks the browser', () => {
    expect(having(/navigator\.platform/)).toEqual([]);
  });

  it('nothing src/os/ loads loads src/os/ back', () => {
    const seen = new Set<string>(), queue = all.filter(inOs);
    for (let f = queue.pop(); f; f = queue.pop()) {
      for (const i of imports(f)) if (!inOs(i) && !seen.has(i)) { seen.add(i); queue.push(i); }
    }
    expect([...seen].filter(f => imports(f).some(inOs))).toEqual([]);
  });
});
