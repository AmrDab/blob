// The per-system files (src/os/): what each one has, and what a system without a file gets.
import { describe, expect, it } from 'vitest';
import { os, osFor } from '../src/os/index.ts';

describe('the operating system', () => {
  it('is the one this process runs on', () => {
    expect(os.id).toBe(process.platform);
    expect(os).toBe(osFor(process.platform));
  });

  it('has a file for Windows, macOS and Linux', () => {
    expect(['win32', 'darwin', 'linux'].map(p => [osFor(p).id, osFor(p).name])).toEqual([['win32', 'Windows'], ['darwin', 'macOS'], ['linux', 'Linux']]);
  });

  it('runs any other system as Linux, under its own name', () => {
    const bsd = osFor('freebsd');
    expect([bsd.id, bsd.name]).toEqual(['freebsd', 'freebsd']);
    expect(osFor('toString').id).toBe('toString');
  });
});
