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
    expect({ ...bsd, id: 'linux', name: 'Linux' }).toEqual(osFor('linux'));
  });

  it('carries the words and sizes of each system', () => {
    const [w, m, l] = ['win32', 'darwin', 'linux'].map(osFor);
    expect([w, m, l].map(o => o.shell.label)).toEqual(['PowerShell', 'shell', 'shell']);
    expect([w, m, l].map(o => o.shell.scriptExt)).toEqual(['.ps1', '.sh', '.sh']);
    expect([w, m, l].map(o => o.trashName)).toEqual(['Recycle Bin', 'Trash', 'Trash']);
    expect([w, m, l].map(o => o.settingsScheme)).toEqual(['ms-settings:', 'x-apple.systempreferences:', undefined]);
    expect([w, m, l].map(o => o.claudeInstall)).toEqual([
      'irm https://claude.ai/install.ps1 | iex', 'curl -fsSL https://claude.ai/install.sh | bash', 'curl -fsSL https://claude.ai/install.sh | bash']);
    expect([w, m, l].map(o => [o.dockGap, o.topInset])).toEqual([[56, 0], [90, 40], [56, 0]]);
    expect([w, m, l].map(o => o.micSettings?.[0])).toEqual(['cmd', 'open', undefined]);   // Linux has no link to its microphone settings
  });
});
