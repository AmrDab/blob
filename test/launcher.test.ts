// The entry the user opens Blob from (launcher.ts): Blob.app on macOS, the Start menu on Windows, the app menu on Linux.
// Everything that touches the system is a fake here.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIC_REASON, handedOn, linuxDesktopEntry, linuxInstall, linuxLauncherScript, macAppNode, macInfoPlist, macInstall, macLauncher, macOpenArgs,
  winInstall, winShortcut, winShortcutPath, type LauncherDeps,
} from '../src/launcher.ts';

const COMMAND = { exe: '/opt/homebrew/bin/node', args: ['--import', 'file:///Users/a/blob/node_modules/tsx/loader.mjs', "/Users/a/it's/src/main.ts"], cwd: "/Users/a/it's" };

// Homebrew's Node: the link on PATH leads to the Cellar, with libnode in the Cellar's lib folder
const CELLAR = join('/opt/homebrew/Cellar/node/25.0.0', 'bin', 'node'), CELLAR_LIB = join('/opt/homebrew/Cellar/node/25.0.0', 'lib');

function fake(): LauncherDeps & { files: Map<string, string>; modes: Map<string, number>; ran: { cmd: string; args: string[]; env?: Record<string, string> }[]; broken: Set<string> } {
  const files = new Map<string, string>(), modes = new Map<string, number>(), broken = new Set<string>();
  const ran: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  return {
    files, modes, ran, broken,
    home: 'H', blobHome: join('H', '.blob'), command: COMMAND, path: '/opt/homebrew/bin:/usr/bin', assets: 'A', version: '0.1.0',
    read: f => files.get(f),
    write: (f, t, mode) => { files.set(f, t); if (mode) modes.set(f, mode); },
    copy: (from, to) => files.set(to, `copy of ${from}`),
    remove: f => files.delete(f),
    exists: f => files.has(f),
    real: f => (f === COMMAND.exe ? CELLAR : f),
    list: dir => (dir === join(CELLAR, '..', '..', 'lib') ? ['libnode.141.dylib', 'node_modules'] : [...files.keys()].filter(f => join(f, '..') === dir).map(f => f.slice(dir.length + 1))),
    runs: f => files.has(f) && !broken.has(f),
    run: async (cmd, args, env) => { ran.push({ cmd, args, env }); return true; },
  };
}

describe('Blob.app (macOS)', () => {
  const app = join('H', 'Applications', 'Blob.app');

  it('names Blob, has no Dock icon, and says why it asks for the microphone', () => {
    const p = macInfoPlist('1.2.3');
    expect(p).toContain('<key>CFBundleName</key><string>Blob</string>');
    expect(p).toContain('<key>CFBundleExecutable</key><string>blob-launch</string>');
    expect(p).toContain('<key>LSUIElement</key><true/>');
    expect(p).toContain(`<key>NSMicrophoneUsageDescription</key><string>${MIC_REASON}</string>`);
    expect(p).toContain('<key>CFBundleShortVersionString</key><string>1.2.3</string>');
    expect(MIC_REASON).not.toMatch(/clawdcursor|node|terminal/i);
  });

  it("its launcher runs the app's copy of Node with this same start, quoted for sh, and Node itself when the copy can't run", () => {
    const s = macLauncher(COMMAND, '/opt/homebrew/bin:/usr/bin', '/H/.blob/logs/blob-app.log', '/H/Applications/Blob.app/Contents/MacOS/Blob');
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain("cd '/Users/a/it'\\''s' || exit 1");
    expect(s).toContain("export PATH='/opt/homebrew/bin:/usr/bin'");
    expect(s).toContain("export BLOB_APP=1 BLOB_NODE='/opt/homebrew/bin/node'\n");
    expect(s).toContain("node='/H/Applications/Blob.app/Contents/MacOS/Blob'\n\"$node\" -e 0 2>/dev/null || node=\"$BLOB_NODE\"\n");
    expect(s).toContain("exec \"$node\" '--import' 'file:///Users/a/blob/node_modules/tsx/loader.mjs' '/Users/a/it'\\''s/src/main.ts' >> '/H/.blob/logs/blob-app.log' 2>&1");
  });

  it('is written once with its own Node (and libnode), signed ad hoc, and left alone while nothing changed (a new signature would ask for the microphone again)', async () => {
    const f = fake(), node = macAppNode('H'), lib = join(app, 'Contents', 'lib', 'libnode.141.dylib');
    expect(node).toBe(join(app, 'Contents', 'MacOS', 'Blob'));
    await macInstall(f);
    expect(f.files.get(join(app, 'Contents', 'Info.plist'))).toBe(macInfoPlist('0.1.0'));
    expect(f.files.get(join(app, 'Contents', 'MacOS', 'blob-launch'))).toContain('export BLOB_APP=1');
    expect(f.modes.get(join(app, 'Contents', 'MacOS', 'blob-launch'))).toBe(0o755);
    expect(f.files.get(join(app, 'Contents', 'Resources', 'blob.icns'))).toBe(`copy of ${join('A', 'blob.icns')}`);
    expect(f.files.get(node)).toBe(`copy of ${CELLAR}`);                     // the real file, not the link
    expect(f.files.get(lib)).toBe(`copy of ${join(CELLAR_LIB, 'libnode.141.dylib')}`);
    expect(f.ran.map(r => r.args)).toEqual([                                 // the parts first, then the app
      ['--force', '--sign', '-', lib],
      ['--force', '--sign', '-', '--identifier', 'com.blob.app', node],
      ['--force', '--sign', '-', app],
    ]);
    await macInstall(f);
    expect(f.ran).toHaveLength(3);
    f.version = '0.2.0';                           // an update: written and signed again, Node not copied again
    await macInstall(f);
    expect(f.ran.slice(3).map(r => r.args)).toEqual([['--force', '--sign', '-', app]]);
  });

  it('keeps its copy of Node through upgrades (a new copy would lose the permissions), and copies it again only when it no longer runs', async () => {
    const f = fake();
    await macInstall(f);
    f.files.set(join(app, 'Contents', 'lib', 'libnode.140.dylib'), 'old');
    await macInstall(f);
    expect(f.ran).toHaveLength(3);
    f.broken.add(macAppNode('H'));                // an upgrade removed a library the copy needs
    await macInstall(f);
    expect(f.ran).toHaveLength(6);
    expect(f.files.has(join(app, 'Contents', 'lib', 'libnode.140.dylib'))).toBe(false);
  });

  it("never copies the app's own Node onto itself", async () => {
    const f = fake();
    f.command = { ...COMMAND, exe: macAppNode('H') };
    await macInstall(f);
    expect(f.files.has(macAppNode('H'))).toBe(false);
    expect(f.ran.map(r => r.args)).toEqual([['--force', '--sign', '-', app]]);
  });

  it('opens with Blob\'s and clawdcursor\'s variables handed on, and nothing else', () => {
    const env = { BLOB_CLAWDCURSOR: 'node /x/cli.js mcp', CLAWD_X: '1', BLOB_APP: '1', HOME: '/H', PATH: '/bin' };
    expect(handedOn(env)).toEqual(['BLOB_CLAWDCURSOR=node /x/cli.js mcp', 'CLAWD_X=1']);
    expect(macOpenArgs('H', env)).toEqual(['-a', app, '--env', 'BLOB_CLAWDCURSOR=node /x/cli.js mcp', '--env', 'CLAWD_X=1']);
  });
});

describe('the Start menu (Windows)', () => {
  const appData = join('H', 'AppData', 'Roaming');
  const lnk = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Blob.lnk');

  it('a "Blob" shortcut that starts ~/.blob/launch.cmd hidden, with Blob\'s icon', () => {
    expect(winShortcutPath(appData)).toBe(lnk);
    const s = winShortcut('C:\\Users\\a\\.blob\\launch.cmd', 'C:\\blob\\assets');
    expect(s.target).toBe('powershell.exe');
    expect(s.args).toBe(`-NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'C:\\Users\\a\\.blob\\launch.cmd'"`);
    expect(s.icon).toBe(join('C:\\blob\\assets', 'blob.ico'));
  });

  it('is made once, its fields passed in the environment, and made again only when they change', async () => {
    const f = fake();
    await winInstall(f, appData);
    expect(f.files.get(join('H', '.blob', 'launch.cmd'))).toContain('cd /d');
    expect(f.ran).toHaveLength(1);
    expect(f.ran[0].cmd).toBe('powershell.exe');
    expect(f.ran[0].args.join(' ')).not.toContain('H');           // no path in the command line itself
    expect(f.ran[0].env).toMatchObject({ BLOB_LNK: lnk, BLOB_LNK_TARGET: 'powershell.exe', BLOB_LNK_ICON: join('A', 'blob.ico') });
    f.files.set(lnk, 'made');                                      // the shortcut now exists
    await winInstall(f, appData);
    expect(f.ran).toHaveLength(1);
    f.command = { ...COMMAND, cwd: '/elsewhere' };                 // Blob moved: the shortcut follows
    await winInstall(f, appData);
    expect(f.ran).toHaveLength(2);
  });

  it('a failed shortcut is tried again at the next start', async () => {
    const f = fake();
    f.run = async () => false;
    await winInstall(f, appData);
    expect(f.files.has(join('H', '.blob', 'launcher.json'))).toBe(false);
  });
});

describe('the app menu (Linux)', () => {
  it('a desktop entry that runs ~/.blob/launch.sh, quoted as the spec asks', () => {
    expect(linuxDesktopEntry('/home/a b/.blob/launch.sh', '/x/blob.png')).toContain('Exec="/home/a b/.blob/launch.sh"\n');
    expect(linuxDesktopEntry('/h/$x`y"z\\.sh', '/i.png')).toContain('Exec="/h/\\$x\\`y\\"z\\\\.sh"\n');
    const e = linuxDesktopEntry('/s', '/i.png');
    expect(e).toContain('Name=Blob\n');
    expect(e).toContain('Terminal=false\n');
    expect(e).toContain('Icon=/i.png\n');
  });

  it('writes the launcher (runnable) and the entry, and nothing when they are as they should be', async () => {
    const f = fake();
    await linuxInstall(f);
    const script = join('H', '.blob', 'launch.sh'), entry = join('H', '.local', 'share', 'applications', 'blob.desktop');
    expect(f.files.get(script)).toBe(linuxLauncherScript(COMMAND, f.path));
    expect(f.modes.get(script)).toBe(0o755);
    expect(f.files.get(entry)).toBe(linuxDesktopEntry(script, join('A', 'blob.png')));
    f.modes.clear();
    await linuxInstall(f);
    expect(f.modes.size).toBe(0);
  });
});
