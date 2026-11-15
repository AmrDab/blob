// Start Blob when the user signs in (the startAtLogin setting), so reminders and scheduled tasks work.
//   Windows: a "Blob" value under HKCU\…\Run that starts ~/.blob/start.cmd with no window.
//   macOS:   ~/Library/LaunchAgents/com.blob.start.plist (read by launchd at the next sign-in).
// Both start Blob the way this one was started. Everything that touches the system is passed in, so tests use fakes.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { blobHome } from './settings.ts';

/** How this Blob was started: the program, its arguments and the folder it runs in. */
export interface StartCommand { exe: string; args: string[]; cwd: string }
export const startCommand = (p: { execPath: string; execArgv: string[]; argv: string[]; cwd(): string } = process): StartCommand =>
  ({ exe: p.execPath, args: [...p.execArgv, ...p.argv.slice(1)], cwd: p.cwd() });

export interface AutostartDeps {
  platform: string;
  home: string;                // the user's home folder
  blobHome: string;            // ~/.blob
  command: StartCommand;
  path: string;                // PATH, for the LaunchAgent (launchd starts with a bare one)
  run(command: string, args: string[]): Promise<boolean>;
  write(file: string, text: string): void;
  remove(file: string): void;
}

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_NAME = 'Blob';
export const AGENT = 'com.blob.start';
export const supported = (platform: string = process.platform) => platform === 'win32' || platform === 'darwin';

/** ~/.blob/start.cmd: go to the folder, start Blob. (`%` is doubled: in a .cmd it starts a variable.) */
export function windowsScript(c: StartCommand): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return `@echo off\r\ncd /d ${q(c.cwd)}\r\n${[c.exe, ...c.args].map(q).join(' ')}\r\n`;
}

/** The Run value: PowerShell starts the script hidden and ends, so no console window stays open. */
export function windowsRunValue(script: string): string {
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '${script.replace(/'/g, "''")}'"`;
}

export function macPlist(c: StartCommand, path: string): string {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${[c.exe, ...c.args].map(a => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${x(c.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${x(path)}</string></dict>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

/** Turns it on or off. `text` says what happened, in words for the user. */
export async function setAutostart(on: boolean, d: AutostartDeps): Promise<{ ok: boolean; text: string }> {
  try {
    if (d.platform === 'win32') {
      const script = join(d.blobHome, 'start.cmd');
      if (on) {
        d.write(script, windowsScript(d.command));
        if (!(await d.run('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', windowsRunValue(script), '/f']))) {
          d.remove(script);
          return { ok: false, text: 'Windows did not take the start-up entry.' };
        }
      } else {
        await d.run('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);   // fails when there is none: that is fine
        d.remove(script);
      }
    } else if (d.platform === 'darwin') {
      const plist = join(d.home, 'Library', 'LaunchAgents', `${AGENT}.plist`);
      if (on) d.write(plist, macPlist(d.command, d.path)); else d.remove(plist);
    } else return { ok: false, text: 'Starting at sign-in is not built for this system yet.' };
  } catch (e) { return { ok: false, text: `Could not change it: ${(e as Error).message}` }; }
  return { ok: true, text: on ? 'Blob will start when you sign in.' : 'Blob will not start when you sign in.' };
}

/** The real system. */
export function systemAutostart(): AutostartDeps {
  return {
    platform: process.platform, home: homedir(), blobHome: blobHome(), command: startCommand(), path: process.env.PATH ?? '',
    run: (command, args) => new Promise(res => execFile(command, args, { windowsHide: true, timeout: 20_000 }, err => res(!err))),
    write: (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); },
    remove: file => rmSync(file, { force: true }),
  };
}
