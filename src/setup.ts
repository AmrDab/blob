// The first-run check: what Blob needs before it can work. What Blob can fix itself is one tap (install clawdcursor,
// give it its OK, ask macOS for its permissions); Claude Code's install and sign-in need the user's own login, so
// they stay a command to copy. The microphone is checked by the page, the first time Speak is used.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, clawdcursorCommand } from './brain.ts';

/** `tap`: the button that fixes it in one tap (fix()). Without one, `fix` is a command to copy. `text`: what the card says. */
export interface Check { id: string; ok: boolean; label: string; fix: string; tap?: string; text?: string }

/** Runs a command and gives its output. Tests pass a fake one. */
export type Runner = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string }>;

const shell: Runner = (command, args, timeoutMs = 20_000) => new Promise(res =>
  execFile(command, args, { env: cleanEnv(), windowsHide: true, timeout: timeoutMs }, (err, stdout) => res({ ok: !err, out: String(stdout) })));

/** What clawdcursor's own consent screen says, in short. Agree runs `clawdcursor consent --accept`. */
export const CONSENT_TEXT =
  'clawdcursor is how Blob uses this computer for you: it can click, type, read the screen and the clipboard, and ' +
  'open apps. Use it only on a computer that is yours. You can stop it at any time from the pill at the top of the screen.';

const MAC_TEXT =
  'Blob needs two permissions: Accessibility and Screen Recording. Tap Allow, then switch Blob on in the list that ' +
  'opens (it can be listed as the app you started Blob from). I look again every 2 seconds, so there is nothing to ' +
  'press here. Screen Recording may only count after you quit Blob and open it again.';

/** The System Settings panes for the two permissions. */
export const MAC_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

/** `claude auth status --json` → signed in? (It may exit non-zero when signed out; only the JSON counts.) */
export function parseAuthStatus(stdout: string): boolean {
  try { return JSON.parse(stdout).loggedIn === true; } catch { return false; }
}

/** `clawdcursor status` on macOS prints "✓ Accessibility: Granted" and "✓ Screen Recording: Granted". */
export function parseMacStatus(text: string): { accessibility: boolean; screenRecording: boolean } {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    accessibility: /Accessibility:\s*Granted/.test(plain),
    screenRecording: /Screen Recording:\s*Granted/.test(plain),
  };
}

/** clawdcursor itself (the same program the Brain starts, not its MCP mode) with these arguments. */
function clawd(args: string[]): [string, string[]] {
  const cc = clawdcursorCommand();
  return [cc.command, [...cc.args.filter(a => a !== 'mcp' && a !== '--compact'), ...args]];
}

/** macOS: which permission is still missing, and the pane to switch it on in (Accessibility first). */
export async function macNeeds(run: Runner = shell): Promise<{ ok: boolean; pane?: string }> {
  const m = parseMacStatus((await run(...clawd(['status']))).out);
  if (!m.accessibility) return { ok: false, pane: MAC_PANES.accessibility };
  if (!m.screenRecording) return { ok: false, pane: MAC_PANES.screenRecording };
  return { ok: true };
}

export async function runChecks(platform: string = process.platform, run: Runner = shell, home: string = homedir()): Promise<Check[]> {
  const checks: Check[] = [];
  // `claude` is started the same way the Brain starts it, so this says whether Blob can start it.
  const claude = await run('claude', ['--version']);
  checks.push({
    id: 'claude', ok: claude.ok, label: 'Install Claude Code',
    fix: platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    text: 'Blob thinks with your own Claude Code. Copy this, run it in a terminal, then come back.',
  });
  if (claude.ok) {
    checks.push({
      id: 'signin', ok: parseAuthStatus((await run('claude', ['auth', 'status', '--json'])).out), label: 'Sign in to Claude Code',
      fix: 'claude auth login', text: 'Copy this, run it in a terminal and sign in, then come back.',
    });
  }
  const installed = (await run(...clawd(['--version']))).ok;
  checks.push({
    id: 'clawdcursor', ok: installed, label: 'Install clawdcursor', fix: 'npm i -g clawdcursor', tap: 'Install',
    text: 'clawdcursor is the hands Blob uses on this computer. Installing takes about a minute.',
  });
  if (!installed) return checks;                    // its OK and its permissions come after it is there
  checks.push({
    id: 'consent', ok: existsSync(join(home, '.clawdcursor', 'consent')),
    label: 'Give clawdcursor its OK', fix: 'clawdcursor consent --accept', tap: 'Agree', text: CONSENT_TEXT,
  });
  if (platform === 'darwin') {
    checks.push({ id: 'mac', ok: (await macNeeds(run)).ok, label: 'Allow Blob to use your Mac', fix: 'clawdcursor grant', tap: 'Allow', text: MAC_TEXT });
  }
  return checks;
}

/**
 * The one-tap fix of a check. True when the command worked; the caller checks again either way.
 *   clawdcursor: `npm i -g clawdcursor`
 *   consent:     `clawdcursor consent --accept` (clawdcursor writes its own consent file; Blob never does)
 *   mac:         `clawdcursor grant` (macOS asks for Accessibility and Screen Recording)
 */
export async function fix(id: string, run: Runner = shell, platform: string = process.platform): Promise<boolean> {
  if (id === 'clawdcursor') {
    // npm is a .cmd shim on Windows, which only cmd can start.
    const npm = ['i', '-g', 'clawdcursor'];
    return (platform === 'win32' ? await run('cmd', ['/c', 'npm', ...npm], 300_000) : await run('npm', npm, 300_000)).ok;
  }
  if (id === 'consent') return (await run(...clawd(['consent', '--accept']))).ok;
  if (id === 'mac' && platform === 'darwin') return (await run(...clawd(['grant']), 40_000)).ok;
  return false;
}

/** macOS: opens a System Settings pane. */
export function openPane(url: string, run: Runner = shell): void {
  void run('open', [url]);
}
