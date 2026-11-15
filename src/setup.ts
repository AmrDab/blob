// The first-run check: what Blob needs before it can work, each with the one command that fixes it.
// The microphone is checked by the page, the first time Speak is used.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, clawdcursorCommand } from './brain.ts';

export interface Check { id: string; ok: boolean; label: string; fix: string }

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

const run = (command: string, args: string[]) => new Promise<{ ok: boolean; out: string }>(res =>
  execFile(command, args, { env: cleanEnv(), windowsHide: true, timeout: 20_000 }, (err, stdout) => res({ ok: !err, out: String(stdout) })));

export async function runChecks(platform: string = process.platform): Promise<Check[]> {
  const checks: Check[] = [];
  // `claude` is started the same way the Brain starts it, so this says whether Blob can start it.
  const claude = await run('claude', ['--version']);
  checks.push({
    id: 'claude', ok: claude.ok, label: 'Install Claude Code',
    fix: platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
  });
  if (claude.ok) {
    checks.push({ id: 'signin', ok: parseAuthStatus((await run('claude', ['auth', 'status', '--json'])).out), label: 'Sign in to Claude Code', fix: 'claude auth login' });
  }
  const cc = clawdcursorCommand();
  const base = { ...cc, args: cc.args.filter(a => a !== 'mcp' && a !== '--compact') };   // the same program, not its MCP mode
  const clawd = await run(base.command, [...base.args, '--version']);
  checks.push({ id: 'clawdcursor', ok: clawd.ok, label: 'Install clawdcursor', fix: 'npm i -g clawdcursor' });
  checks.push({
    id: 'consent', ok: existsSync(join(homedir(), '.clawdcursor', 'consent')),
    label: "Give clawdcursor its one-time OK", fix: 'clawdcursor consent',
  });
  if (platform === 'darwin' && clawd.ok) {
    const m = parseMacStatus((await run(base.command, [...base.args, 'status'])).out);
    checks.push({ id: 'mac', ok: m.accessibility && m.screenRecording, label: 'Allow Accessibility and Screen Recording', fix: 'clawdcursor grant' });
  }
  return checks;
}
