// Starting at sign-in, with a fake system: nothing here touches the registry, the Startup folder or LaunchAgents.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_KEY, cleanPath, macPlist, setAutostart, stableNode, startCommand, windowsRunValue, windowsScript, type AutostartDeps } from '../src/autostart.ts';
import { osFor } from '../src/os/index.ts';

function fake(platform: string, regOk = true) {
  const ran: string[][] = [], files = new Map<string, string>();
  const deps: AutostartDeps = {
    home: join('H'), blobHome: join('H', '.blob'), path: '/opt/homebrew/bin:/usr/bin',
    command: { exe: 'C:\\Program Files\\nodejs\\node.exe', args: ['--import', 'file:///C:/Users/A%20B/tsx/loader.mjs', 'C:\\blob\\src\\main.ts'], cwd: 'C:\\blob' },
    run: async (c, a) => { ran.push([c, ...a]); return regOk; },
    write: (f, t) => { files.set(f, t); },
    remove: f => { files.delete(f); },
  };
  return { deps, ran, files, apply: osFor(platform).autostart?.apply };
}

describe('start at sign-in', () => {
  it('takes the start command from how this Blob was started', () => {
    expect(startCommand({ execPath: '/n/node', execArgv: ['--import', 'tsx'], argv: ['/n/node', '/b/src/main.ts'], cwd: () => '/b' }))
      .toEqual({ exe: '/n/node', args: ['--import', 'tsx', '/b/src/main.ts'], cwd: '/b' });
    expect(['win32', 'darwin', 'linux'].map(p => !!osFor(p).autostart)).toEqual([true, true, false]);
  });

  it('Windows: writes ~/.blob/start.cmd and one Run value that starts it hidden', async () => {
    const f = fake('win32');
    const script = join('H', '.blob', 'start.cmd');
    expect(await setAutostart(true, f.deps, f.apply)).toEqual({ ok: true, text: 'Blob will start when you sign in.' });
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
    await setAutostart(true, f.deps, f.apply);
    expect(await setAutostart(false, f.deps, f.apply)).toEqual({ ok: true, text: 'Blob will not start when you sign in.' });
    expect(f.ran[1]).toEqual(['reg', 'delete', RUN_KEY, '/v', 'Blob', '/f']);
    expect(f.files.size).toBe(0);
    const bad = fake('win32', false);
    expect((await setAutostart(true, bad.deps, bad.apply)).ok).toBe(false);
    expect(bad.files.size).toBe(0);
    expect((await setAutostart(false, bad.deps, bad.apply)).ok).toBe(true);      // nothing to remove is fine
  });

  it('macOS: a LaunchAgent that opens Blob.app with the user\'s PATH; off removes it', async () => {
    const f = fake('darwin');
    f.deps.command = { exe: '/usr/local/bin/node', args: ['--import', 'tsx', '/Users/a/blob/src/main.ts'], cwd: '/Users/a/blob' };
    const plist = join('H', 'Library', 'LaunchAgents', 'com.blob.start.plist');
    expect((await setAutostart(true, f.deps, f.apply)).ok).toBe(true);
    const text = f.files.get(plist)!;
    expect(text).toBe(macPlist({ exe: '/usr/bin/open', args: ['-a', join('H', 'Applications', 'Blob.app')], cwd: '/Users/a/blob' }, f.deps.path));
    expect(text).toMatch(/<key>Label<\/key><string>com\.blob\.start<\/string>/);
    expect(text).toContain(`<array>\n    <string>/usr/bin/open</string>\n    <string>-a</string>\n    <string>${join('H', 'Applications', 'Blob.app')}</string>\n  </array>`);
    expect(text).toMatch(/<key>WorkingDirectory<\/key><string>\/Users\/a\/blob<\/string>/);
    expect(macPlist({ exe: '/x', args: ['a&b<c>'], cwd: '/' }, '')).toContain('<string>a&amp;b&lt;c&gt;</string>');   // XML-escaped
    expect(text).toMatch(/<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
    expect(text).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(text).toMatch(/<key>ProcessType<\/key><string>Interactive<\/string>/);   // not throttled as a background job
    expect(f.ran).toEqual([]);
    await setAutostart(false, f.deps, f.apply);
    expect(f.files.size).toBe(0);
  });

  it('macOS: starts Node by a path that outlives an upgrade (the link on PATH, not the versioned file)', () => {
    const cellar = '/opt/homebrew/Cellar/node/24.1.0/bin/node', link = join('/opt/homebrew/bin', 'node');
    const real = (p: string) => { if (p === link) return cellar; if (p === join('/usr/bin', 'node')) return '/usr/bin/node'; throw new Error('ENOENT'); };
    expect(stableNode(cellar, '/nowhere:/usr/bin::/opt/homebrew/bin', real)).toBe(link);
    expect(stableNode(cellar, '/nowhere:/usr/bin', real)).toBe(cellar);              // no link to it (nvm): as it was started
    expect(stableNode(cellar, '', real)).toBe(cellar);
  });

  it('says so where it is not built, and when the system refuses', async () => {
    expect(await setAutostart(true, fake('linux').deps, fake('linux').apply)).toEqual({ ok: false, text: 'Starting at sign-in is not built for this system yet.' });
    const f = fake('darwin');
    f.deps.write = () => { throw new Error('read-only'); };
    expect(await setAutostart(true, f.deps, f.apply)).toEqual({ ok: false, text: 'Could not change it: read-only' });
  });

  it("drops what npm start put on PATH, for this run only", () => {
    expect(cleanPath('/Users/a/blob/node_modules/.bin:/Users/node_modules/.bin:/x/npm/node-gyp-bin:/opt/homebrew/bin::/usr/bin'))
      .toBe('/opt/homebrew/bin:/usr/bin');
    expect(cleanPath('C:\\blob\\node_modules\\.bin;C:\\Windows;C:\\Program Files\\nodejs')).toBe('C:\\Windows;C:\\Program Files\\nodejs');
  });

  it('quotes the script for cmd', () => {
    expect(windowsScript({ exe: 'node', args: ['a b', '100%'], cwd: 'C:\\x y' })).toBe('@echo off\r\ncd /d "C:\\x y"\r\n"node" "a b" "100%%"\r\n');
  });
});
