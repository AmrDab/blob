// How the user opens Blob: an entry the system shows, which Blob writes itself at every start (only what changed).
//   macOS:   ~/Applications/Blob.app (Spotlight, Launchpad, Finder). Its Info.plist names Blob and says why it asks for
//            the microphone. Its program, blob-launch (macos/blob-launch.swift, the same for every user), starts the
//            app's own copy of Node (Contents/MacOS/Blob) as its child and stays its parent: macOS charges Node's
//            permissions to Blob.app, the one identity the user switched on. Node inside the app: macOS shows the
//            process as Blob and its web view finds the app's microphone line. Started any other way, Blob opens
//            itself through the app (main.ts). The start command is outside the app, in ~/.blob/launch.sh, so the app
//            and its signature stay as they are when Blob updates (update.ts) and macOS keeps the permissions it gave.
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
  read(file: string): string | undefined;
  write(file: string, text: string, mode?: number): void;
  /** A copy that is a new file: a program running from the old one carries on. */
  copy(from: string, to: string): void;
  /** The two files have the same bytes (false when either is missing). */
  same(a: string, b: string): boolean;
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

/** LSUIElement: no Dock icon from the first moment (mac.ts makes Blob an accessory app too). No version: an update leaves the app alone. */
export function macInfoPlist(): string {
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
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>${xml(MIC_REASON)}</string>
</dict>
</plist>
`;
}

/** Blob.app's own copy of Node: the program the app's process runs. */
export const macAppNode = (home: string) => join(macAppPath(home), 'Contents', 'MacOS', 'Blob');

/** Contents/MacOS/blob-launch, the app's program, as built once (scripts/mac-launcher.sh): it runs ~/.blob/launch.sh. */
export const macLauncher = (assets: string) => join(assets, 'mac', 'blob-launch');

/**
 * ~/.blob/launch.sh, written at each start: what blob-launch runs (as its child). `exec`: the app's copy of Node takes
 * the shell's place, so Node is blob-launch's child. When the copy no longer runs (an upgrade removed a library it needs), Node itself does, and that Blob copies
 * it again. BLOB_NODE: the Node it was copied from, for that next copy.
 */
export function macStart(c: StartCommand, path: string, log: string, own: string): string {
  return `# Blob's start command, written by Blob (launcher.ts) at each start.
cd ${sh(c.cwd)} || exit 1
export PATH=${sh(path)}
export BLOB_APP=1 BLOB_NODE=${sh(c.exe)}
node=${sh(own)}
"$node" -e 0 2>/dev/null || node="$BLOB_NODE"
mkdir -p ${sh(dirname(log))}
exec "$node" ${c.args.map(sh).join(' ')} >> ${sh(log)} 2>&1
`;
}

export async function macInstall(d: LauncherDeps): Promise<void> {
  const app = macAppPath(d.home), contents = join(app, 'Contents'), node = macAppNode(d.home);
  const plist = join(contents, 'Info.plist'), launch = join(contents, 'MacOS', 'blob-launch');
  const icon = join(contents, 'Resources', 'blob.icns'), libDir = join(contents, 'lib'), script = join(d.blobHome, 'launch.sh');
  const info = macInfoPlist(), launcher = macLauncher(d.assets), start = macStart(d.command, d.path, join(d.blobHome, 'logs', 'blob-app.log'), node);
  if (d.read(script) !== start) d.write(script, start);                  // outside the app: nothing to sign
  // Node is copied once, and again only when the copy no longer runs (not at every Node upgrade): a new copy is a new
  // program to macOS, which then asks again for every permission the user gave Blob.
  const real = d.real(d.command.exe), lib = join(dirname(real), '..', 'lib');
  const nodeNew = real !== node && !(d.exists(node) && d.runs(node));
  // with Homebrew's libnode, which Node finds next to itself through @loader_path/../lib
  const libs = nodeNew ? d.list(lib).filter(f => /^libnode\..*dylib$/.test(f)).map(f => join(lib, f)) : [];
  // Rewritten only when it changed: a new signature is a new app to macOS, which would ask for the microphone again.
  if (!nodeNew && d.read(plist) === info && d.same(launcher, launch) && d.exists(icon)) return;
  d.write(plist, info);
  d.copy(launcher, launch);                                            // with its mode: it is a program
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

/**
 * The shortcut's own fields; it starts ~/.blob/launch.cmd hidden, as the sign-in entry does. `id`: the app id Blob's
 * process takes too (os/win.ts), which is how the taskbar knows Blob's window is this shortcut's app and not Node's.
 */
export function winShortcut(script: string, assets: string): { target: string; args: string; icon: string; id: string } {
  const run = windowsRunValue(script);
  const exe = 'powershell.exe';
  return { target: exe, args: run.slice(exe.length + 1), icon: join(assets, 'blob.ico'), id: APP_ID };
}

// WScript.Shell can't write a shortcut's app id (System.AppUserModel.ID): that goes through the file's property store,
// which PowerShell reaches only from C#.
const LNK_ID = 'using System;using System.Runtime.InteropServices;'
  + '[StructLayout(LayoutKind.Sequential)]public struct BlobKey{public Guid fmtid;public uint pid;}'
  + '[StructLayout(LayoutKind.Sequential)]public struct BlobValue{public ushort vt;public IntPtr text;public IntPtr unused;}'
  + '[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IBlobStore{'
  + 'void GetCount(out uint n);void GetAt(uint i,out BlobKey k);void GetValue(ref BlobKey k,out BlobValue v);void SetValue(ref BlobKey k,ref BlobValue v);void Commit();}'
  + 'public static class BlobLnk{'
  + '[DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=false)]static extern void SHGetPropertyStoreFromParsingName(string path,IntPtr bind,int flags,ref Guid iid,out IBlobStore store);'
  // GPS_READWRITE; PKEY_AppUserModel_ID; VT_LPWSTR
  + 'public static void SetId(string lnk,string id){Guid iid=typeof(IBlobStore).GUID;IBlobStore s;SHGetPropertyStoreFromParsingName(lnk,IntPtr.Zero,2,ref iid,out s);'
  + 'BlobKey k=new BlobKey{fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),pid=5};BlobValue v=new BlobValue{vt=31,text=Marshal.StringToCoTaskMemUni(id)};'
  + 's.SetValue(ref k,ref v);s.Commit();Marshal.ReleaseComObject(s);}}';

/** WScript.Shell makes .lnk files; the values come in through the environment, so nothing needs quoting. */
const LNK = '$ErrorActionPreference="Stop";'
  + '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BLOB_LNK);$s.TargetPath=$env:BLOB_LNK_TARGET;'
  + '$s.Arguments=$env:BLOB_LNK_ARGS;$s.IconLocation=$env:BLOB_LNK_ICON;$s.WorkingDirectory=$env:BLOB_LNK_DIR;'
  + '$s.Description="Blob";$s.WindowStyle=7;$s.Save();'
  + 'Add-Type -TypeDefinition $env:BLOB_LNK_CS;[BlobLnk]::SetId($env:BLOB_LNK,$env:BLOB_LNK_ID)';

export async function winInstall(d: LauncherDeps, appData: string): Promise<void> {
  const script = join(d.blobHome, 'launch.cmd'), lnk = winShortcutPath(appData);
  const text = windowsScript(d.command);
  const s = winShortcut(script, d.assets), stamp = join(d.blobHome, 'launcher.json');
  const want = JSON.stringify({ lnk, ...s, text });
  if (d.read(stamp) === want && d.exists(lnk)) return;
  d.write(script, text);
  const ok = await d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LNK], {
    BLOB_LNK: lnk, BLOB_LNK_TARGET: s.target, BLOB_LNK_ARGS: s.args, BLOB_LNK_ICON: s.icon, BLOB_LNK_DIR: d.command.cwd,
    BLOB_LNK_ID: s.id, BLOB_LNK_CS: LNK_ID,
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

export function systemLauncher(blobHome: string, command: StartCommand): LauncherDeps {
  return {
    home: homedir(), blobHome, command, path: cleanPath(process.env.PATH ?? ''), assets: ASSETS,
    read: file => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
    write: (file, text, mode) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); },
    copy: (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      rmSync(to, { force: true });
      copyFileSync(from, to, constants.COPYFILE_FICLONE);                // a clone where the disk can: no second 100 MB
    },
    same: (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } },
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
