// Windows.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, parse } from 'node:path';
import { windowsAutostart } from '../autostart.ts';
import { winCursor } from '../clickthrough.ts';
import { windowsApps, windowsProfile } from '../computer.ts';
import { Bridge } from '../desk.ts';
import { winKeeper } from '../focus.ts';
import { winInstall } from '../launcher.ts';
import { winOverlay, winProtect } from '../overlay.ts';
import { processLister } from '../own-ui.ts';
import { windowsFront } from '../watch.ts';
import type { Os } from './types.ts';

// koffi is loaded when a function first needs it, never when this file is: the MCP servers bundle this file too.
const koffi = () => createRequire(import.meta.url)('koffi');

let shDelete: ((path: string) => { result: number; aborted: boolean }) | undefined;

/** SHFileOperation with undo (the Recycle Bin); a file that can't be recycled asks first instead of vanishing. */
function trash(path: string): void {
  if (!shDelete) {
    const k = koffi();
    if (process.arch === 'ia32') throw new Error('32-bit Windows is not supported');
    k.struct('BLOB_SHFILEOPSTRUCTW', {
      hwnd: 'intptr_t', wFunc: 'uint32_t', pFrom: 'const char16_t *', pTo: 'const char16_t *',
      fFlags: 'uint16_t', fAnyOperationsAborted: 'int32_t', hNameMappings: 'void *', lpszProgressTitle: 'const char16_t *',
    });
    const fn = k.load('shell32.dll').func('int __stdcall SHFileOperationW(_Inout_ BLOB_SHFILEOPSTRUCTW *op)');
    // FO_DELETE; FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    shDelete = p => {
      const op = { hwnd: 0, wFunc: 3, pFrom: p + '\0', pTo: null, fFlags: 0x40 | 0x10 | 0x4 | 0x400 | 0x4000, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null };
      const result = fn(op);
      return { result, aborted: !!op.fAnyOperationsAborted };
    };
  }
  const r = shDelete(path);
  if (r.aborted) throw new Error('cancelled');
  if (r.result !== 0) throw new Error(`Windows error ${r.result}`);
  if (existsSync(path)) throw new Error('it is still there');
}

let shOpen: ((...a: unknown[]) => unknown) | undefined;

/** ShellExecute: the usual app, with no shell in between. */
function open(target: string): void {
  shOpen ??= koffi().load('shell32.dll')
    .func('intptr_t __stdcall ShellExecuteW(intptr_t hwnd, const char16_t *verb, const char16_t *file, const char16_t *params, const char16_t *dir, int show)');
  const r = shOpen!(0, null, target, null, null, 1);   // SW_SHOWNORMAL; above 32 is success
  if (Number(r) <= 32) throw new Error(`Windows error ${r}`);
}

let driveType: ((root: string) => number) | undefined;

/** On this computer when its drive is not a network one (a mapped Z:). */
function isLocal(path: string): boolean {
  driveType ??= koffi().load('kernel32.dll').func('uint32_t __stdcall GetDriveTypeW(const char16_t *root)');
  return driveType!(parse(path).root) !== 4;   // DRIVE_REMOTE
}

/** npm installs Codex as codex.cmd, which only cmd can start: Blob runs the script that shim names with this same Node. */
const findCodex: Os['findCodex'] = (env, fs) => {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const exe = join(dir, 'codex.exe'), cmd = join(dir, 'codex.cmd');
    if (fs.exists(exe)) return { command: exe, args: [] };
    if (!fs.exists(cmd)) continue;
    let js: string | undefined;
    try { js = fs.read(cmd).match(/"%dp0%\\([^"]+\.js)"/)?.[1]; } catch { /* unreadable: not this one */ }
    if (js) return { command: process.execPath, args: [join(dirname(cmd), js)] };
  }
  return { command: 'codex', args: [] };            // not found: starting it fails, and the first-run check says so
};

export const win: Os = {
  id: 'win32',
  name: 'Windows',
  shell: {
    label: 'PowerShell',
    name: 'PowerShell',
    scriptExt: '.ps1',
    looks: 'Get-ChildItem, Get-Content, Select-String, Get-Process, Get-Command, Test-Path, winget list, winget search, --version',
    dialect: 'powershell',
    // output as UTF-8, no progress bars
    argv: command => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; " + command]],
  },
  spawnGroup: false,
  killTree(pid) { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); },
  cli: parts => ({ command: 'cmd', args: ['/c', ...parts] }),   // npm's .cmd shims, which only cmd can start
  findClaude: () => 'claude',                                   // its installer sets PATH
  findCodex,
  claudeInstall: 'irm https://claude.ai/install.ps1 | iex',
  trashName: 'Recycle Bin',
  settingsScheme: 'ms-settings:',
  trash: async path => trash(path),
  open: async target => open(target),
  isLocal,
  readProfile: windowsProfile,
  openApps: (self, procs) => procs && windowsApps(self, procs),   // a window is named by its program
  processes: processLister,
  frontWindow: windowsFront,
  launcher: { install: d => winInstall(d, process.env.APPDATA || join(d.home, 'AppData', 'Roaming')) },   // the Start menu
  autostart: { apply: windowsAutostart },
  desk: { bridge: o => new Bridge(o) },             // UI Automation, through desk-bridge.ps1
  cursor: winCursor,
  focusKeeper: winKeeper,
  hideFromCapture: winProtect,
  overlay: winOverlay,
  // WebView2's extra browser flags: grant the page's microphone request without a prompt
  webviewEnv: {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream',
  },
  dockGap: 56,
  topInset: 0,
  quitHint: 'close the bubble from the taskbar',
  micSettings: ['cmd', ['/c', 'start', '', 'ms-settings:privacy-microphone']],
  sendKey: 'Ctrl+Enter',
};
