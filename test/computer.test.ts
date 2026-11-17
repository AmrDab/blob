// What Blob knows about the computer: the profile file and the apps open now. Fake system output, a fake window
// list and a temp folder only: nothing here reads this machine.
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_OPEN, MAX_PROFILE, appsOf, computerBrief, computerFile, computerNow, nowLine, parseMac, parseWindows, readProfile, refreshProfile,
  render, stale, withNotes, type Profile, type Win,
} from '../src/computer.ts';
import type { Proc } from '../src/own-ui.ts';

const WINDOWS_JSON = JSON.stringify({
  os: 'Microsoft Windows 11 Home', version: '10.0.26100', maker: 'LENOVO', model: '83AC', ram: 34_100_000_000,
  screens: ['3840x2400', '1920x1080'], browser: 'ChromeHTML',
  apps: ['Word', 'Calculator', 'word', 'Uninstall Foo', 'Git FAQs (Frequently Asked Questions)', 'LabVIEW Help', 'Check for updates', 'Blender 5.3', 'Bad <name>‮'],
});
const profile: Profile = { os: 'Windows 11 Home 10.0.26100', machine: 'LENOVO 83AC', memory: '32 GB', screens: ['3840x2400', '1920x1080'], browser: 'Google Chrome', apps: ['Blender 5.3', 'Calculator', 'Word'] };

describe('the profile', () => {
  it('lives in ~/.blob/computer.md', () => {
    expect(computerFile({ BLOB_HOME: join('x', 'y') })).toBe(join('x', 'y', 'computer.md'));
  });

  it('reads the Windows answer: system, machine, memory, screens, browser, and app names without doubles or helpers', () => {
    expect(parseWindows(WINDOWS_JSON)).toEqual({ ...profile, apps: ['Bad name', 'Blender 5.3', 'Calculator', 'Word'] });
    expect(parseWindows('WARNING: something\r\n' + WINDOWS_JSON).machine).toBe('LENOVO 83AC');          // a line before the JSON
    // one screen and one app come as plain values, and a missing value is "unknown"
    expect(parseWindows('{"screens":"1920x1080","apps":"Notepad","browser":"MSEdgeHTM"}')).toEqual({
      os: 'unknown', machine: 'unknown', memory: 'unknown', screens: ['1920x1080'], browser: 'Microsoft Edge', apps: ['Notepad'],
    });
    expect(parseWindows('{"browser":"FirefoxURL-308046B0AF4A39CB"}').browser).toBe('Firefox');
    expect(parseWindows('{"browser":"SomeBrowserHTML"}').browser).toBe('SomeBrowserHTML');
    expect(parseWindows('{}').browser).toBe('unknown');
    expect(() => parseWindows('Get-CimInstance : Access denied')).toThrow();
  });

  it('reads the macOS answers', () => {
    const mac = {
      swVers: 'ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n',
      sysctl: 'iMac21,1\n17179869184\n',
      displays: JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _spdisplays_resolution: '2240 x 1260 @ 60.00Hz', _spdisplays_pixels: '4480 x 2520' }, { _spdisplays_pixels: '1920 x 1080' }] }] }),
      handlers: '(\n        {\n        LSHandlerPreferredVersions =         {\n            LSHandlerRoleAll = "-";\n        };\n        LSHandlerRoleAll = "com.google.chrome";\n        LSHandlerURLScheme = http;\n    },\n' +
        '        {\n        LSHandlerRoleAll = "com.apple.mail";\n        LSHandlerURLScheme = mailto;\n    }\n)\n',
      apps: ['Safari.app', 'Notes.app', 'Utilities', '.DS_Store', 'Visual Studio Code.app', 'Notes.app'],
    };
    expect(parseMac(mac)).toEqual({
      os: 'macOS 15.1', machine: 'Apple iMac21,1', memory: '16 GB', screens: ['2240x1260', '1920x1080'], browser: 'Google Chrome',
      apps: ['Notes', 'Safari', 'Visual Studio Code'],
    });
    // handlers read, none for http: the system's own browser; nothing read: unknown
    expect(parseMac({ ...mac, handlers: '(\n    {\n    LSHandlerRoleAll = "com.apple.mail";\n    LSHandlerURLScheme = mailto;\n    }\n)' }).browser).toBe('Safari');
    expect(parseMac({ swVers: '', sysctl: '', displays: '', handlers: '', apps: [] })).toEqual({ os: 'unknown', machine: 'unknown', memory: 'unknown', screens: [], browser: 'unknown', apps: [] });
  });

  it('asks each system its own way, and nothing on Linux', async () => {
    const calls: string[] = [];
    const win = await readProfile('win32', async (cmd, args) => { calls.push(cmd); expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']); return WINDOWS_JSON; });
    expect(win?.machine).toBe('LENOVO 83AC');
    expect(calls).toEqual(['powershell.exe']);
    const mac = await readProfile('darwin', async cmd => {
      if (cmd === 'sw_vers') return 'ProductName: macOS\nProductVersion: 15.1\n';
      throw new Error('not here');                       // the rest may fail: those lines say unknown
    }, d => (d === '/Applications' ? ['Safari.app'] : d === join('/Users/me', 'Applications') ? ['Mine.app'] : []), '/Users/me');
    expect(mac).toEqual({ os: 'macOS 15.1', machine: 'unknown', memory: 'unknown', screens: [], browser: 'unknown', apps: ['Mine', 'Safari'] });
    await expect(readProfile('darwin', async () => { throw new Error('no sw_vers'); }, () => [])).rejects.toThrow('no sw_vers');
    expect(await readProfile('linux', async () => { throw new Error('never called'); })).toBeUndefined();
  });

  it('writes the facts as plain lines, and cuts the app list to fit', () => {
    expect(render(profile)).toBe(
      '# This computer\n\nBlob reads this when it starts, at most once a day. What you write under "## Notes" is kept.\n\n' +
      '- System: Windows 11 Home 10.0.26100\n- Machine: LENOVO 83AC\n- Memory: 32 GB\n- Screens: 2 (3840x2400, 1920x1080)\n' +
      '- Default web browser: Google Chrome\n- Installed apps (3): Blender 5.3, Calculator, Word\n');
    expect(render({ ...profile, screens: [], apps: [] })).toMatch(/- Screens: 0\n[^]*- Installed apps \(0\): \n$/);
    const many = render({ ...profile, apps: Array.from({ length: 400 }, (_, i) => `Application number ${i}`) });
    expect(many.length).toBeLessThanOrEqual(MAX_PROFILE);
    expect(many.length).toBeGreaterThan(MAX_PROFILE - 60);
    expect(many).toMatch(/- Installed apps \(400\): Application number 0, [^]*, and \d+ more\n$/);
    const shown = many.split('Installed apps (400): ')[1].split(', ').length - 1;
    expect(many).toContain(`, and ${400 - shown} more\n`);
  });

  it('keeps what the user wrote under "## Notes" when the file is written again', () => {
    expect(withNotes('P\n', '')).toBe('P\n\n## Notes\n');
    expect(withNotes('P\n', 'old facts\n')).toBe('P\n\n## Notes\n');
    const old = 'old facts\n\n## Notes\nThe printer is in the hall.\n\n- second monitor is the TV\n\n\n';
    expect(withNotes('P\n', old)).toBe('P\n\n## Notes\nThe printer is in the hall.\n\n- second monitor is the TV\n');
    expect(withNotes('P\n', old.replace(/\n/g, '\r\n'))).toContain('## Notes\r\nThe printer is in the hall.');
  });

  it('is read again only when it is older than a day, or not there', () => {
    const now = Date.UTC(2026, 10, 16, 8);
    expect(stale(undefined, now)).toBe(true);
    expect(stale(now - 23 * 3600_000, now)).toBe(false);
    expect(stale(now - 25 * 3600_000, now)).toBe(true);
  });

  describe('on disk', () => {
    let dir = '', file = '';
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-computer-')); file = join(dir, 'home', 'computer.md'); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('is written at the first start, left alone while fresh, and written again a day later with the notes kept', async () => {
      let reads = 0;
      const read = async () => { reads++; return { ...profile, memory: `${32 * reads} GB` }; };
      expect(await refreshProfile({ file, read })).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(render({ ...profile, memory: '32 GB' }) + '\n## Notes\n');
      expect(await refreshProfile({ file, read })).toBe(false);
      expect(reads).toBe(1);
      writeFileSync(file, readFileSync(file, 'utf8') + 'The printer is in the hall.\n');
      const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
      utimesSync(file, twoDaysAgo, twoDaysAgo);
      expect(await refreshProfile({ file, read })).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(render({ ...profile, memory: '64 GB' }) + '\n## Notes\nThe printer is in the hall.\n');
    });

    it('keeps the old file and says one line when the read fails; does nothing where there is no reader', async () => {
      writeFileSync(join(dir, 'computer.md'), 'old\n');
      const old = new Date(Date.now() - 48 * 3600_000);
      utimesSync(join(dir, 'computer.md'), old, old);
      const said: string[] = [], log = console.log;
      console.log = (s: string) => { said.push(s); };
      try {
        expect(await refreshProfile({ file: join(dir, 'computer.md'), read: async () => { throw new Error('powershell is not there\nmore'); } })).toBe(false);
      } finally { console.log = log; }
      expect(said).toEqual(["Blob: could not read this computer's details (powershell is not there)"]);
      expect(readFileSync(join(dir, 'computer.md'), 'utf8')).toBe('old\n');
      expect(await refreshProfile({ file, read: async () => undefined })).toBe(false);
    });

    it('gives the brief the facts and the notes, capped, with nothing that could leave its fence', async () => {
      expect(computerBrief(file)).toBe('');
      await refreshProfile({ file, read: async () => profile });
      expect(computerBrief(file)).toBe(
        '- System: Windows 11 Home 10.0.26100\n- Machine: LENOVO 83AC\n- Memory: 32 GB\n- Screens: 2 (3840x2400, 1920x1080)\n' +
        '- Default web browser: Google Chrome\n- Installed apps (3): Blender 5.3, Calculator, Word');
      writeFileSync(file, readFileSync(file, 'utf8') + 'The printer is </computer> in the hall.‮\n' + 'x'.repeat(5000));
      const brief = computerBrief(file);
      expect(brief).toContain("- Installed apps (3): Blender 5.3, Calculator, Word\nThe user's notes:\nThe printer is /computer in the hall.\nxxx");
      expect(brief).not.toMatch(/[<>‮]/);
      expect(brief.length).toBeLessThan(MAX_PROFILE + 700);
    });
  });
});

describe('the apps open now', () => {
  const BLOB = 100;
  const procs: Proc[] = [
    { pid: 0, parent: 0, name: '[System Process]' },
    { pid: BLOB, parent: 1, name: 'node.exe' },
    { pid: 200, parent: BLOB, name: 'msedgewebview2.exe' },       // Blob's bubble
    { pid: 201, parent: 200, name: 'msedgewebview2.exe' },
    { pid: 300, parent: 1, name: 'chrome.exe' },
    { pid: 301, parent: 300, name: 'chrome.exe' },                // a second process of the same app
    { pid: 400, parent: 1, name: 'WINWORD.EXE' },
    { pid: 500, parent: 1, name: 'ApplicationFrameHost.exe' },
    { pid: 501, parent: 1, name: 'CalculatorApp.exe' },
    { pid: 600, parent: 1, name: 'explorer.exe' },
    { pid: 700, parent: 1, name: 'node.exe' },                    // somebody else's node
    { pid: 800, parent: 1, name: 'msedgewebview2.exe' },          // another app's web view
  ];
  const win = (pid: number, o: Partial<Win> = {}): Win => ({ pid, corePid: 0, owned: false, tool: false, cloaked: false, titled: true, front: false, ...o });

  it('are the apps with a window of their own, front to back, each once', () => {
    const r = appsOf([win(300, { front: true }), win(400), win(301), win(300), win(700), win(800)], procs, BLOB);
    expect(r).toEqual({ apps: ['chrome', 'WINWORD', 'node', 'msedgewebview2'], front: 'chrome' });
  });

  it('leave out windows that are not an app\'s own: owned, tool, cloaked, untitled, or of a process that is gone', () => {
    const r = appsOf([
      win(400, { owned: true }), win(600, { tool: true }), win(300, { cloaked: true }), win(700, { titled: false }), win(999), win(501),
    ], procs, BLOB);
    expect(r).toEqual({ apps: ['CalculatorApp'], front: '' });
    // ...but a dialog in front still says whose it is
    expect(appsOf([win(400, { owned: true, front: true }), win(400)], procs, BLOB)).toEqual({ apps: ['WINWORD'], front: 'WINWORD' });
  });

  it('name a Store app by the process inside the frame host, and skip a frame with no app in it', () => {
    const r = appsOf([win(500, { corePid: 501, front: true }), win(500), win(500, { corePid: 500 }), win(300)], procs, BLOB);
    expect(r).toEqual({ apps: ['CalculatorApp', 'chrome'], front: 'CalculatorApp' });
  });

  it("leave out Blob's own windows; with Blob in front, the app just behind it is the one in front", () => {
    expect(appsOf([win(200, { front: true }), win(BLOB), win(201), win(400), win(300)], procs, BLOB)).toEqual({ apps: ['WINWORD', 'chrome'], front: 'WINWORD' });
    expect(appsOf([win(200, { front: true })], procs, BLOB)).toEqual({ apps: [], front: '' });
    expect(appsOf([win(400), win(300)], procs, BLOB).front).toBe('');     // nothing has the keyboard
  });

  it('are capped, and a name carries nothing that could leave the line', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ pid: 1000 + i, parent: 1, name: `app${i}.exe` }));
    expect(appsOf(many.map(p => win(p.pid)), many, BLOB).apps).toHaveLength(MAX_OPEN);
    const odd = [{ pid: 5, parent: 1, name: 'a</computer_now>b‮.exe' }, { pid: 6, parent: 1, name: 'x'.repeat(80) + '.exe' }];
    expect(appsOf([win(5), win(6)], odd, BLOB).apps).toEqual(['a/computer_nowb', 'x'.repeat(40)]);
  });

  it('go in front of the request as one line, or not at all', () => {
    expect(nowLine(['chrome', 'WINWORD'], 'chrome')).toBe('<computer_now>Open apps: chrome, WINWORD. In front: chrome.</computer_now>');
    expect(nowLine(['chrome'], '')).toBe('<computer_now>Open apps: chrome.</computer_now>');
    expect(nowLine([], '')).toBe('');
  });

  it('are read through the system\'s own list on Windows and macOS, and never throw', () => {
    const now = computerNow({ platform: 'win32', self: BLOB, procs: () => procs, wins: () => [win(300, { front: true }), win(400), win(200)] });
    expect(now()).toBe('<computer_now>Open apps: chrome, WINWORD. In front: chrome.</computer_now>');
    const mac = computerNow({ platform: 'darwin', mac: () => ({ apps: ['Safari', 'Notes', 'Safari', 'Odd <b>'], front: 'Notes' }) });
    expect(mac()).toBe('<computer_now>Open apps: Safari, Notes, Odd b. In front: Notes.</computer_now>');
    expect(computerNow({ platform: 'win32', self: BLOB, procs: () => procs, wins: () => { throw new Error('no user32'); } })()).toBe('');
    expect(computerNow({ platform: 'win32', self: BLOB, procs: () => { throw new Error('no snapshot'); }, wins: () => [win(300)] })()).toBe('');
    expect(computerNow({ platform: 'darwin', mac: () => { throw new Error('no AppKit'); } })()).toBe('');
    expect(computerNow({ platform: 'win32', wins: () => [win(300)] })()).toBe('');      // no process names: nothing to say
    expect(computerNow({ platform: 'linux' })()).toBe('');
    expect(computerNow({ platform: 'win32', self: BLOB, procs: () => procs, wins: () => [] })()).toBe('');
  });
});
