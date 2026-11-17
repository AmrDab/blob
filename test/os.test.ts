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
    // as the code did before src/os: Linux's ways, but a network path told by its mount, as on macOS
    expect(bsd.isLocal).toBe(osFor('darwin').isLocal);
    expect({ ...bsd, id: 'linux', name: 'Linux', isLocal: osFor('linux').isLocal }).toEqual(osFor('linux'));
  });

  it('has a trash, an opener and start at sign-in where the system does', async () => {
    const [w, m, l] = ['win32', 'darwin', 'linux'].map(osFor);
    const ran: string[][] = [], exec = async (cmd: string, args: string[]) => { ran.push([cmd, ...args]); };
    await l.trash('/home/a/x', exec);
    await osFor('freebsd').trash('/home/a/y', exec);
    expect(ran).toEqual([['gio', 'trash', '--', '/home/a/x'], ['gio', 'trash', '--', '/home/a/y']]);
    expect([w, m, l].map(o => !!o.isProgram)).toEqual([false, true, false]);       // only a Mac folder can be a program
    expect(m.isProgram!('/nowhere/Notes.app', '.app')).toBe(true);
    expect(m.isProgram!('/nowhere/Notes', '')).toBe(false);
    expect([w, m, l, osFor('freebsd')].map(o => !!o.autostart)).toEqual([true, true, false, false]);
    expect([w, m].map(o => !!o.autostart!.exe)).toEqual([false, true]);            // Homebrew's Node moves at each upgrade
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
