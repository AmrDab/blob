// How the user opens Blob: an entry the system shows, which Blob writes itself at every start (only what changed).
//   macOS:   ~/Applications/Blob.app (Spotlight, Launchpad, Finder). Its Info.plist names Blob and says why it asks for
//            the microphone. Its launcher runs the app's own copy of Node (Contents/MacOS/Blob): a program inside the
//            app, so macOS shows the process as Blob and its web view finds the app's microphone line. Started any
//            other way, Blob opens itself through the app (main.ts).
//   Windows: "Blob" in the Start menu.
//   Linux:   "Blob" in the app menu.
// Each runs this same start command (autostart.ts). The icons in assets/ were made once from site/favicon.svg.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type StartCommand, cleanPath, macAppPath, windowsRunValue, windowsScript } from './autostart.ts';

export const ASSETS = resolve(import.meta.dirname, '..', 'assets');
export const APP_ID = 'com.blob.app';
/** Said by macOS when Blob first asks for the microphone. */
export const MIC_REASON = 'Blob listens while you hold Speak, to hear what you ask.';

export interface LauncherDeps {
  home: string;
  blobHome: string;
  command: StartCommand;
  path: string;                // PATH, for a start with a bare one (Finder, launchd)
  assets: string;
  version: string;
  read(file: string): string | undefined;
  write(file: string, text: string, mode?: number): void;
  /** A copy that is a new file: a program running from the old one carries on. */
  copy(from: string, to: string): void;
  remove(file: string): void;
  exists(file: string): boolean;
  /** The file a link leads to. */
  real(file: string): string;
  /** A folder's file names; none when there is no such folder. */
  list(dir: string): string[];
  /** The program starts and ends well (`node -e 0`). */
  runs(exe: string): boolean;
  run(command: string, args: string[], env?: Record<string, string>): Promise<boolean>;
}

/** Quoted for sh: inside single quotes nothing is special but the quote itself. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── macOS ───────────────────────────────────────────────────────────────────

/** LSUIElement: no Dock icon from the first moment (mac.ts makes Blob an accessory app too). */
export function macInfoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Blob</string>
  <key>CFBundleDisplayName</key><string>Blob</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleExecutable</key><string>blob-launch</string>
  <key>CFBundleIconFile</key><string>blob</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>${xml(MIC_REASON)}</string>
</dict>
</plist>
`;
}

/** Blob.app's own copy of Node: the program the app's process runs. */
export const macAppNode = (home: string) => join(macAppPath(home), 'Contents', 'MacOS', 'Blob');

/**
 * Contents/MacOS/blob-launch, the app's start. `exec`: the app's copy of Node takes this process's place. When the copy
 * no longer runs (an upgrade removed a library it needs), Node itself does, and that Blob copies it again.
 * BLOB_NODE: the Node it was copied from, for that next copy.
 */
export function macLauncher(c: StartCommand, path: string, log: string, own: string): string {
  return `#!/bin/sh
# Blob's launcher, written by Blob (launcher.ts).
cd ${sh(c.cwd)} || exit 1
export PATH=${sh(path)}
export BLOB_APP=1 BLOB_NODE=${sh(c.exe)}
node=${sh(own)}
"$node" -e 0 2>/dev/null || node="$BLOB_NODE"
exec "$node" ${c.args.map(sh).join(' ')} >> ${sh(log)} 2>&1
`;
}

export async function macInstall(d: LauncherDeps): Promise<void> {
  const app = macAppPath(d.home), contents = join(app, 'Contents'), node = macAppNode(d.home);
  const plist = join(contents, 'Info.plist'), launch = join(contents, 'MacOS', 'blob-launch');
  const icon = join(contents, 'Resources', 'blob.icns'), libDir = join(contents, 'lib');
  const info = macInfoPlist(d.version), launcher = macLauncher(d.command, d.path, join(d.blobHome, 'logs', 'blob-app.log'), node);
  // Node is copied once, and again only when the copy no longer runs (not at every Node upgrade): a new copy is a new
  // program to macOS, which then asks again for every permission the user gave Blob.
  const real = d.real(d.command.exe), lib = join(dirname(real), '..', 'lib');
  const nodeNew = real !== node && !(d.exists(node) && d.runs(node));
  // with Homebrew's libnode, which Node finds next to itself through @loader_path/../lib
  const libs = nodeNew ? d.list(lib).filter(f => /^libnode\..*dylib$/.test(f)).map(f => join(lib, f)) : [];
  // Rewritten only when it changed: a new signature is a new app to macOS, which would ask for the microphone again.
  if (!nodeNew && d.read(plist) === info && d.read(launch) === launcher && d.exists(icon)) return;
  d.write(plist, info);
  d.write(launch, launcher, 0o755);
  d.copy(join(d.assets, 'blob.icns'), icon);
  if (nodeNew) {
    for (const f of d.list(libDir)) d.remove(join(libDir, f));          // an older libnode
    for (const f of libs) {
      d.copy(f, join(libDir, basename(f)));
      await d.run('codesign', ['--force', '--sign', '-', join(libDir, basename(f))]);
    }
    d.copy(real, node);
    await d.run('codesign', ['--force', '--sign', '-', '--identifier', APP_ID, node]);
  }
  await d.run('codesign', ['--force', '--sign', '-', app]);   // ad hoc: a signature macOS can tie the permission to
}

/** The variables to hand on when Blob opens itself through the app: its own and clawdcursor's. */
export const handedOn = (env: NodeJS.ProcessEnv) =>
  Object.entries(env).filter(([k, v]) => /^(BLOB|CLAWD)_/.test(k) && k !== 'BLOB_APP' && v !== undefined).map(([k, v]) => `${k}=${v}`);

/** `open` arguments that start Blob.app with these variables. */
export const macOpenArgs = (home: string, env: NodeJS.ProcessEnv) =>
  ['-a', macAppPath(home), ...handedOn(env).flatMap(v => ['--env', v])];

// ── Windows ─────────────────────────────────────────────────────────────────

export const winShortcutPath = (appData: string) => join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Blob.lnk');

/** The shortcut's own fields; it starts ~/.blob/launch.cmd hidden, as the sign-in entry does. */
export function winShortcut(script: string, assets: string): { target: string; args: string; icon: string } {
  const run = windowsRunValue(script);
  const exe = 'powershell.exe';
  return { target: exe, args: run.slice(exe.length + 1), icon: join(assets, 'blob.ico') };
}

/** WScript.Shell makes .lnk files; the values come in through the environment, so nothing needs quoting. */
const LNK = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BLOB_LNK);$s.TargetPath=$env:BLOB_LNK_TARGET;'
  + '$s.Arguments=$env:BLOB_LNK_ARGS;$s.IconLocation=$env:BLOB_LNK_ICON;$s.WorkingDirectory=$env:BLOB_LNK_DIR;'
  + '$s.Description="Blob";$s.WindowStyle=7;$s.Save()';

export async function winInstall(d: LauncherDeps, appData: string): Promise<void> {
  const script = join(d.blobHome, 'launch.cmd'), lnk = winShortcutPath(appData);
  const text = windowsScript(d.command);
  const s = winShortcut(script, d.assets), stamp = join(d.blobHome, 'launcher.json');
  const want = JSON.stringify({ lnk, ...s, text });
  if (d.read(stamp) === want && d.exists(lnk)) return;
  d.write(script, text);
  const ok = await d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LNK], {
    BLOB_LNK: lnk, BLOB_LNK_TARGET: s.target, BLOB_LNK_ARGS: s.args, BLOB_LNK_ICON: s.icon, BLOB_LNK_DIR: d.command.cwd,
  });
  if (ok) d.write(stamp, want);
}

// ── Linux ───────────────────────────────────────────────────────────────────

export const linuxLauncherScript = (c: StartCommand, path: string) => `#!/bin/sh
# Blob's launcher, written by Blob (launcher.ts).
cd ${sh(c.cwd)} || exit 1
export PATH=${sh(path)}
exec ${[c.exe, ...c.args].map(sh).join(' ')}
`;

/** A desktop entry: Exec in double quotes, with ", `, $ and \ escaped as the spec asks. */
export function linuxDesktopEntry(script: string, icon: string): string {
  const q = (s: string) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
  return `[Desktop Entry]
Type=Application
Name=Blob
Comment=Your desktop assistant
Exec=${q(script)}
Icon=${icon}
Terminal=false
Categories=Utility;
`;
}

export async function linuxInstall(d: LauncherDeps): Promise<void> {
  const script = join(d.blobHome, 'launch.sh'), entry = join(d.home, '.local', 'share', 'applications', 'blob.desktop');
  const text = linuxLauncherScript(d.command, d.path), desk = linuxDesktopEntry(script, join(d.assets, 'blob.png'));
  if (d.read(script) !== text) d.write(script, text, 0o755);
  if (d.read(entry) !== desk) d.write(entry, desk);
}

// ── the real system ─────────────────────────────────────────────────────────

export function systemLauncher(blobHome: string, command: StartCommand, version: string): LauncherDeps {
  return {
    home: homedir(), blobHome, command, path: cleanPath(process.env.PATH ?? ''), assets: ASSETS, version,
    read: file => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
    write: (file, text, mode) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); },
    copy: (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      rmSync(to, { force: true });
      copyFileSync(from, to, constants.COPYFILE_FICLONE);                // a clone where the disk can: no second 100 MB
    },
    remove: file => rmSync(file, { force: true }),
    exists: existsSync,
    real: realpathSync,
    list: dir => { try { return readdirSync(dir); } catch { return []; } },
    runs: exe => spawnSync(exe, ['-e', '0'], { stdio: 'ignore', timeout: 20_000 }).status === 0,
    run: (cmd, args, env) => new Promise(res => execFile(cmd, args, { windowsHide: true, timeout: 20_000, env: { ...process.env, ...env } }, err => res(!err))),
  };
}

/** macOS: open Blob.app with this process's variables. False when `open` failed (then this process carries on). */
export const macOpen = (home: string, env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise(res => execFile('open', macOpenArgs(home, env), { timeout: 20_000 }, err => res(!err)));

/** macOS: open Blob.app once this process is gone (a Blob still running would take the start as "show yourself"). */
export function macOpenLater(home: string, env: NodeJS.ProcessEnv): void {
  const line = `sleep 1; exec open ${macOpenArgs(home, env).map(sh).join(' ')}`;
  spawn('/bin/sh', ['-c', line], { detached: true, stdio: 'ignore' }).unref();
}
