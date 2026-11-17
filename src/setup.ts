// The first-run check: what Blob needs before it can work. What Blob can fix itself is one tap (install clawdcursor,
// give it its OK, ask macOS for its permissions); the install and sign-in of Claude Code or Codex need the user's
// own login, so they stay commands to copy. The microphone is checked by the page, the first time Speak is used.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCommand, cleanEnv, clawdcursorCommand, codexCommand, type ServerCommand } from './brain.ts';
import { os, osFor } from './os/index.ts';
import { BRAINS, type BrainName } from './settings.ts';

/**
 * `tap`: the button that fixes it in one tap (fix()). Without one, `fix` is a command to copy, and `alt` a second
 * one (the other brain's). `text`: what the card says. `ready` (on the 'brain' check): the brains installed and signed in.
 */
export interface Check { id: string; ok: boolean; label: string; fix: string; alt?: string; tap?: string; text?: string; ready?: BrainName[] }

/** Runs a command and gives its output (`err`: what it wrote to stderr, kept apart from `out`). Tests pass a fake one. */
export type Runner = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string; err?: string }>;

const shell: Runner = (command, args, timeoutMs = 20_000) => new Promise(res =>
  execFile(command, args, { env: cleanEnv(), windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout), err: String(stderr) })));

/** What clawdcursor's own consent screen says, in short. Agree runs `clawdcursor consent --accept`. */
export const CONSENT_TEXT =
  'Blob uses this computer for you: it can click, type, read the screen and the clipboard, and ' +
  'open apps. Use it only on a computer that is yours. You can stop it at any time from the pill at the top of the screen.';

const MAC_TEXT =
  'Blob needs two permissions: Accessibility and Screen Recording. Tap Allow, then switch Blob on in the list that ' +
  'opens (it can be listed as the app you started Blob from, or as "node" when Blob started by itself at sign-in). I look again every 2 seconds, so there is nothing to ' +
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

/**
 * `clawdcursor status` on macOS prints "✓ Accessibility: Granted" and "✓ Screen Recording: Granted". Screen Recording
 * can also be "Could not check": the screen is still read then, so only "Not granted" (or no line at all) is missing.
 */
export function parseMacStatus(text: string): { accessibility: boolean; screenRecording: boolean } {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    accessibility: /Accessibility:\s*Granted/.test(plain),
    screenRecording: /Screen Recording:/.test(plain) && !/Screen Recording:\s*Not granted/.test(plain),
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

/** The brain to use: the one the user picked when it is ready, else the one that is. */
export function pickBrain(wanted: BrainName, ready: readonly BrainName[]): BrainName {
  return ready.includes(wanted) || !ready.length ? wanted : ready[0];
}

/**
 * Which brains are installed, and which of those are signed in. Each is started the same way the Brain starts it,
 * so this says whether Blob can start it. `codex login status` exits 0 only when signed in.
 */
export async function brains(platform: string = os.id, run: Runner = shell, codex: ServerCommand = codexCommand(platform), claude: string = claudeCommand(platform)): Promise<{ has: Record<BrainName, boolean>; ready: BrainName[] }> {
  const cx = (args: string[]) => run(codex.command, [...codex.args, ...args]);
  const has = { claude: (await run(claude, ['--version'])).ok, codex: (await cx(['--version'])).ok };
  const signedIn = {
    claude: has.claude && parseAuthStatus((await run(claude, ['auth', 'status', '--json'])).out),
    codex: has.codex && (await cx(['login', 'status'])).ok,
  };
  return { has, ready: BRAINS.filter(b => signedIn[b]) };
}

export async function runChecks(platform: string = os.id, run: Runner = shell, home: string = homedir(), codex: ServerCommand = codexCommand(platform), claude: string = claudeCommand(platform)): Promise<Check[]> {
  const checks: Check[] = [];
  const { has, ready } = await brains(platform, run, codex, claude);
  // Blob needs one of the two. With none installed both installs are offered; with one installed, its sign-in.
  checks.push({
    id: 'brain', ok: has.claude || has.codex, label: 'Install Claude Code or Codex', ready,
    fix: osFor(platform).claudeInstall,
    alt: 'npm i -g @openai/codex',
    text: 'Blob thinks with your own Claude Code or Codex. Copy one of these, run it in a terminal, then come back.',
  });
  if (has.claude || has.codex) {
    const both = has.claude && has.codex;
    const cl = /\s/.test(claude) ? `"${claude}"` : claude;   // its full path when it is not on PATH, so the copied command works
    checks.push({
      id: 'signin', ok: ready.length > 0, label: both ? 'Sign in to Claude Code or Codex' : has.claude ? 'Sign in to Claude Code' : 'Sign in to Codex',
      fix: has.claude ? `${cl} auth login` : 'codex login', ...(both && { alt: 'codex login' }),
      text: `Copy ${both ? 'one of these' : 'this'}, run it in a terminal and sign in, then come back.`,
    });
  }
  const installed = (await run(...clawd(['--version']))).ok;
  checks.push({
    id: 'clawdcursor', ok: installed, label: 'Finish setting up Blob', fix: 'npm i -g clawdcursor', tap: 'Install',
    text: 'Blob needs one more part to use this computer. Installing takes about a minute.',
  });
  if (!installed) return checks;                    // its OK and its permissions come after it is there
  checks.push({
    id: 'consent', ok: existsSync(join(home, '.clawdcursor', 'consent')),
    label: 'Let Blob use this computer', fix: 'clawdcursor consent --accept', tap: 'Agree', text: CONSENT_TEXT,
  });
  if (platform === 'darwin') {
    checks.push({ id: 'mac', ok: (await macNeeds(run)).ok, label: 'Allow Blob to use your Mac', fix: 'clawdcursor grant', tap: 'Allow', text: MAC_TEXT });
  }
  return checks;
}

/** Why the last fix() failed, in words for the user, when Blob knows ('' when it does not). */
export let fixNote = '';

/**
 * The one-tap fix of a check. True when the command worked; the caller checks again either way.
 *   clawdcursor: `npm i -g clawdcursor`
 *   consent:     `clawdcursor consent --accept` (clawdcursor writes its own consent file; Blob never does)
 *   mac:         `clawdcursor grant` (macOS asks for Accessibility and Screen Recording)
 */
export async function fix(id: string, run: Runner = shell, platform: string = os.id): Promise<boolean> {
  fixNote = '';
  if (id === 'clawdcursor') {
    const sys = osFor(platform), npm = sys.cli(['npm', 'i', '-g', 'clawdcursor']);   // npm is a .cmd shim on Windows, which only cmd can start
    const r = await run(npm.command, npm.args, 300_000);
    // Node from the nodejs.org installer keeps its global folder owned by root: a plain install cannot write there.
    if (!r.ok && sys.shell.dialect === 'posix' && /EACCES/.test(r.err ?? '')) {
      fixNote = 'Your Node needs your password to install this. Use Node from Homebrew or nvm, or run the install with sudo in Terminal, then tap Install.';
      console.log('Blob: npm has no write access to its global folder (EACCES). In a terminal, run: sudo npm i -g clawdcursor (or use Node from Homebrew or nvm).');
    }
    return r.ok;
  }
  if (id === 'consent') return (await run(...clawd(['consent', '--accept']))).ok;
  if (id === 'mac' && platform === 'darwin') return (await run(...clawd(['grant']), 40_000)).ok;
  return false;
}

/** macOS: opens a System Settings pane. */
export function openPane(url: string, run: Runner = shell): void {
  void run('open', [url]);
}
