// The per-system files (src/os/): what each one has, and what a system without a file gets.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('starts a command in the system\'s shell, and ends a whole process group with the signal it is given', () => {
    const [w, m, l] = ['win32', 'darwin', 'linux'].map(osFor);
    expect([w, m, l, osFor('freebsd')].map(o => o.shell.dialect)).toEqual(['powershell', 'posix', 'posix', 'posix']);
    expect(w.shell.argv('Get-Date', {})[0]).toBe('powershell.exe');
    expect(w.shell.argv('Get-Date', {})[1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(m.shell.argv('date', { SHELL: '/bin/zsh' })).toEqual(['/bin/zsh', ['-lc', 'date']]);
    expect(l.shell.argv('date', {})).toEqual(['/bin/sh', ['-lc', 'date']]);
    expect([w, m, l].map(o => o.spawnGroup)).toEqual([false, true, true]);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      m.killTree(4321, 'SIGTERM');
      l.killTree(4322, 'SIGKILL');
      expect(kill.mock.calls).toEqual([[-4321, 'SIGTERM'], [-4322, 'SIGKILL']]);   // the group, not the one process
      kill.mockImplementation(() => { throw new Error('ESRCH'); });
      expect(() => l.killTree(4323, 'SIGKILL')).not.toThrow();                      // already gone
    } finally { kill.mockRestore(); }
  });

  it('starts npm\'s tools, Claude Code and Codex the way the system needs', () => {
    const [w, m, l] = ['win32', 'darwin', 'linux'].map(osFor), bsd = osFor('freebsd');
    expect(w.cli(['npm', 'i'])).toEqual({ command: 'cmd', args: ['/c', 'npm', 'i'] });
    expect([m, l, bsd].map(o => o.cli(['npm', 'i']))).toEqual(Array(3).fill({ command: 'npm', args: ['i'] }));
    const none = { exists: () => false, read: () => '' }, local = join('/home/a', '.local', 'bin', 'claude');
    expect([w, m, l, bsd].map(o => o.findCodex({}, none))).toEqual(Array(4).fill({ command: 'codex', args: [] }));
    expect(w.npmCli(join('C:', 'node', 'node.exe'))).toBe(join('C:', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));   // beside node.exe
    expect([m, l].map(o => o.npmCli(join('/usr', 'local', 'bin', 'node')))).toEqual(Array(2).fill(join('/usr', 'local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
    // Windows: where its installer put it (Blob's own PATH is older than an install Blob just ran), else by name
    expect(w.findClaude({}, join('C:', 'Users', 'a'), () => true)).toBe(join('C:', 'Users', 'a', '.local', 'bin', 'claude.exe'));
    expect(w.findClaude({}, '/home/a', () => false)).toBe('claude');
    expect(w.findClaude({}, '/home/a', () => { throw new Error('EPERM'); })).toBe('claude');
    expect([m, l, bsd].map(o => o.findClaude({}, '/home/a', p => p === local))).toEqual([local, local, local]);
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

  it('reads the computer, and works windows in the background, where the system can', () => {
    const [w, m, l, bsd] = ['win32', 'darwin', 'linux', 'freebsd'].map(osFor);
    const has = (o: typeof w) => [!!o.readProfile, !!o.openApps, !!o.processes, !!o.frontWindow, !!o.desk];
    expect(has(w)).toEqual([true, true, true, true, true]);
    expect(has(m)).toEqual([true, true, false, false, false]);
    expect([has(l), has(bsd)]).toEqual([Array(5).fill(false), Array(5).fill(false)]);
    expect(typeof m.openApps!(1)).toBe('function');                                // macOS names its apps itself: no process list needed
  });

  it('has the web view flags on Windows only, and a reminder sound of its own on macOS only', () => {
    const [w, m, l] = ['win32', 'darwin', 'linux'].map(osFor);
    expect(Object.keys(w.webviewEnv ?? {})).toEqual(['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']);
    expect(w.webviewEnv!.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toContain('--use-fake-ui-for-media-stream');
    expect([m.webviewEnv, l.webviewEnv]).toEqual([undefined, undefined]);
    expect([w, m, l].map(o => !!o.reminderSound)).toEqual([false, true, false]);
  });

  it('tells the pages what they used to ask the browser: the keys that send a longer reply, and whose the microphone is', () => {
    const [w, m, l, bsd] = ['win32', 'darwin', 'linux', 'freebsd'].map(osFor);
    expect([w, m, l, bsd].map(o => o.sendKey)).toEqual(['Ctrl+Enter', '⌘Return', 'Ctrl+Enter', 'Ctrl+Enter']);
    expect([w, m, l, bsd].map(o => !!o.micOfLauncher)).toEqual([false, true, false, false]);
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
