// Starting at sign-in, with a fake system: nothing here touches the registry, the Startup folder or LaunchAgents.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_KEY, macPlist, setAutostart, startCommand, supported, windowsRunValue, windowsScript, type AutostartDeps } from '../src/autostart.ts';

function fake(platform: string, regOk = true) {
  const ran: string[][] = [], files = new Map<string, string>();
  const deps: AutostartDeps = {
    platform, home: join('H'), blobHome: join('H', '.blob'), path: '/opt/homebrew/bin:/usr/bin',
    command: { exe: 'C:\\Program Files\\nodejs\\node.exe', args: ['--import', 'file:///C:/Users/A%20B/tsx/loader.mjs', 'C:\\blob\\src\\main.ts'], cwd: 'C:\\blob' },
    run: async (c, a) => { ran.push([c, ...a]); return regOk; },
    write: (f, t) => { files.set(f, t); },
    remove: f => { files.delete(f); },
  };
  return { deps, ran, files };
}

describe('start at sign-in', () => {
  it('takes the start command from how this Blob was started', () => {
    expect(startCommand({ execPath: '/n/node', execArgv: ['--import', 'tsx'], argv: ['/n/node', '/b/src/main.ts'], cwd: () => '/b' }))
      .toEqual({ exe: '/n/node', args: ['--import', 'tsx', '/b/src/main.ts'], cwd: '/b' });
    expect([supported('win32'), supported('darwin'), supported('linux')]).toEqual([true, true, false]);
  });

  it('Windows: writes ~/.blob/start.cmd and one Run value that starts it hidden', async () => {
    const f = fake('win32');
    const script = join('H', '.blob', 'start.cmd');
    expect(await setAutostart(true, f.deps)).toEqual({ ok: true, text: 'Blob will start when you sign in.' });
    expect(f.files.get(script)).toBe(
      '@echo off\r\ncd /d "C:\\blob"\r\n"C:\\Program Files\\nodejs\\node.exe" "--import" "file:///C:/Users/A%%20B/tsx/loader.mjs" "C:\\blob\\src\\main.ts"\r\n');
    expect(f.ran).toEqual([['reg', 'add', RUN_KEY, '/v', 'Blob', '/t', 'REG_SZ', '/d', windowsRunValue(script), '/f']]);
    expect(RUN_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(windowsRunValue("C:\\Users\\O'Brien\\.blob\\start.cmd")).toBe(
      `powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'C:\\Users\\O''Brien\\.blob\\start.cmd'"`);
    expect(windowsRunValue('C:\\Users\\' + 'u'.repeat(100) + '\\.blob\\start.cmd').length).toBeLessThan(260);   // the Run key's limit
  });

  it('Windows: off removes the value and the script; a refused entry leaves nothing behind', async () => {
    const f = fake('win32');
    await setAutostart(true, f.deps);
    expect(await setAutostart(false, f.deps)).toEqual({ ok: true, text: 'Blob will not start when you sign in.' });
    expect(f.ran[1]).toEqual(['reg', 'delete', RUN_KEY, '/v', 'Blob', '/f']);
    expect(f.files.size).toBe(0);
    const bad = fake('win32', false);
    expect((await setAutostart(true, bad.deps)).ok).toBe(false);
    expect(bad.files.size).toBe(0);
    expect((await setAutostart(false, bad.deps)).ok).toBe(true);      // nothing to remove is fine
  });

  it('macOS: a LaunchAgent that starts the same command with the user\'s PATH; off removes it', async () => {
    const f = fake('darwin');
    f.deps.command = { exe: '/usr/local/bin/node', args: ['--import', 'tsx', '/Users/a/blob/src/main.ts', 'a&b<c>'], cwd: '/Users/a/blob' };
    const plist = join('H', 'Library', 'LaunchAgents', 'com.blob.start.plist');
    expect((await setAutostart(true, f.deps)).ok).toBe(true);
    const text = f.files.get(plist)!;
    expect(text).toBe(macPlist(f.deps.command, f.deps.path));
    expect(text).toMatch(/<key>Label<\/key><string>com\.blob\.start<\/string>/);
    expect(text).toMatch(/<array>\n    <string>\/usr\/local\/bin\/node<\/string>\n    <string>--import<\/string>\n    <string>tsx<\/string>\n    <string>\/Users\/a\/blob\/src\/main\.ts<\/string>\n    <string>a&amp;b&lt;c&gt;<\/string>\n  <\/array>/);
    expect(text).toMatch(/<key>WorkingDirectory<\/key><string>\/Users\/a\/blob<\/string>/);
    expect(text).toMatch(/<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
    expect(text).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(f.ran).toEqual([]);
    await setAutostart(false, f.deps);
    expect(f.files.size).toBe(0);
  });

  it('says so where it is not built, and when the system refuses', async () => {
    expect(await setAutostart(true, fake('linux').deps)).toEqual({ ok: false, text: 'Starting at sign-in is not built for this system yet.' });
    const f = fake('darwin');
    f.deps.write = () => { throw new Error('read-only'); };
    expect(await setAutostart(true, f.deps)).toEqual({ ok: false, text: 'Could not change it: read-only' });
  });

  it('quotes the script for cmd', () => {
    expect(windowsScript({ exe: 'node', args: ['a b', '100%'], cwd: 'C:\\x y' })).toBe('@echo off\r\ncd /d "C:\\x y"\r\n"node" "a b" "100%%"\r\n');
  });
});
