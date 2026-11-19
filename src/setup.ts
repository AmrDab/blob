// The first-run check: what Blob needs before it can work. Each fix is one tap, never a command to copy: Blob runs
// the installers and the sign-in itself, hidden, and the user only signs in, in the browser window the sign-in
// opens. The microphone is checked by the page, the first time Speak is used.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCommand, cleanEnv, clawdcursorCommand, codexCommand, type ServerCommand } from './brain.ts';
import { os, osFor, type Os } from './os/index.ts';
import { BRAINS, type BrainName } from './settings.ts';

/**
 * `tap`: the button that fixes it in one tap (fix()). Without one, `fix` is a command to copy, and `alt` a second
 * one (the other brain's); with one they are what the tap runs, for the log. `text`: what the card says. `ready` (on the 'brain' check): the brains installed and signed in.
 */
export interface Check { id: string; ok: boolean; label: string; fix: string; alt?: string; tap?: string; text?: string; ready?: BrainName[] }

/** Runs a command and gives its output (`err`: what it wrote to stderr, kept apart from `out`). Tests pass a fake one. */
export type Runner = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string; err?: string }>;

// stdin is closed at once: nothing Blob starts here has anyone to type to it (a sign-in then waits for the browser only).
const shell: Runner = (command, args, timeoutMs = 20_000) => new Promise(res =>
  execFile(command, args, { env: cleanEnv(), windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout), err: String(stderr) })).stdin?.end());

/** What clawdcursor's own consent screen says, in short. Agree runs `clawdcursor consent --accept`. */
export const CONSENT_TEXT =
  'Blob uses this computer for you: it can click, type, read the screen and the clipboard, and ' +
  'open apps. Use it only on a computer that is yours. You can stop it at any time from the pill at the top of the screen.';

const MAC_TEXT =
  'Blob needs two permissions: Accessibility and Screen Recording. Tap Allow, then switch Blob on in the list that ' +
  'opens (it can be listed as the app you started Blob from, or as "node" when Blob started by itself at sign-in). I look again every 2 seconds, so there is nothing to ' +
  'press here. Screen Recording may only count after you quit Blob and open it again.';

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

/** macOS: which permission is still missing, and the pane to switch it on in (Accessibility first). `panes`: os.permissionPanes. */
export async function macNeeds(panes: NonNullable<Os['permissionPanes']>, run: Runner = shell): Promise<{ ok: boolean; pane?: string }> {
  const m = parseMacStatus((await run(...clawd(['status']))).out);
  if (!m.accessibility) return { ok: false, pane: panes.accessibility };
  if (!m.screenRecording) return { ok: false, pane: panes.screenRecording };
  return { ok: true };
}

/**
 * The brains a run found signed out (brain.ts: needsSignIn). `claude auth status` can still say signed in then, so
 * the run's word stands until a sign-in from the card works. Kept only while Blob runs: the next run tells again.
 */
const lost = new Set<BrainName>();
export function signedOut(brain: BrainName, out = true): void {
  if (out) lost.add(brain); else lost.delete(brain);
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
    claude: has.claude && !lost.has('claude') && parseAuthStatus((await run(claude, ['auth', 'status', '--json'])).out),
    codex: has.codex && !lost.has('codex') && (await cx(['login', 'status'])).ok,
  };
  return { has, ready: BRAINS.filter(b => signedIn[b]) };
}

export async function runChecks(platform: string = os.id, run: Runner = shell, home: string = homedir(), codex: ServerCommand = codexCommand(platform), claude: string = claudeCommand(platform)): Promise<Check[]> {
  const checks: Check[] = [];
  const { has, ready } = await brains(platform, run, codex, claude);
  // Blob needs one of the two. With none installed Blob installs Claude Code; with one installed, its sign-in.
  checks.push({
    id: 'brain', ok: has.claude || has.codex, label: 'Install Claude Code', ready,
    fix: osFor(platform).claudeInstall,
    alt: 'npm i -g @openai/codex',
    tap: 'Install',
    text: 'Blob thinks with your own Claude Code (or Codex, when you have it). Installing Claude Code takes about a minute; then you sign in.',
  });
  if (has.claude || has.codex) {
    const both = has.claude && has.codex;
    const cl = /\s/.test(claude) ? `"${claude}"` : claude;   // its full path when it is not on PATH
    checks.push({
      id: 'signin', ok: ready.length > 0, label: both ? 'Sign in to Claude Code or Codex' : has.claude ? 'Sign in to Claude Code' : 'Sign in to Codex',
      fix: has.claude ? `${cl} auth login` : 'codex login', ...(both && { alt: 'codex login' }),
      tap: 'Sign in',
      text: `Sign in with your ${both ? '' : has.claude ? 'Claude ' : 'ChatGPT '}account in the browser window that opens. Blob carries on by itself.`,
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
  const panes = osFor(platform).permissionPanes;
  if (panes) {
    checks.push({ id: 'mac', ok: (await macNeeds(panes, run)).ok, label: 'Allow Blob to use your Mac', fix: 'clawdcursor grant', tap: 'Allow', text: MAC_TEXT });
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
 *   brain:       Claude Code's own installer (os.claudeInstall), in the system's shell
 *   signin:      `claude auth login --claudeai` or `codex login`, for the brain the user picked (`want`) when it is
 *                installed, else the other. The CLI opens the browser at the sign-in page and ends once the user is
 *                through (Blob ends it after 5 minutes). Its exit is the answer: `auth status` is not asked.
 */
export async function fix(id: string, run: Runner = shell, platform: string = os.id, want: BrainName = 'claude',
  codex: ServerCommand = codexCommand(platform), claude: string = claudeCommand(platform)): Promise<boolean> {
  fixNote = '';
  if (id === 'brain') {
    const sys = osFor(platform);
    return (await run(...sys.shell.argv(sys.claudeInstall, {}), 300_000)).ok;
  }
  if (id === 'signin') {
    const { has } = await brains(platform, run, codex, claude);
    const b = has[want] ? want : BRAINS.find(x => has[x]);
    if (!b) return false;
    const ok = (await (b === 'codex' ? run(codex.command, [...codex.args, 'login'], 300_000) : run(claude, ['auth', 'login', '--claudeai'], 300_000))).ok;
    if (ok) lost.delete(b);                          // it signed in and saved it: the next run is the proof
    return ok;
  }
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
  if (id === 'mac' && osFor(platform).permissionPanes) return (await run(...clawd(['grant']), 40_000)).ok;
  return false;
}
