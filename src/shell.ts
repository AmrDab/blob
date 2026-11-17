// Blob's shell tool (`run`, on the files server): PowerShell on Windows, the login shell elsewhere. A command that
// only looks runs at once. Anything else is shown to the user word for word on a Yes/No card first. When the
// classifier is not sure, it asks.
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { ToolResult } from './files-mcp.ts';

export type Verdict = 'read' | 'ask';

/** The card shows the whole command, never a cut one: a longer command is refused, not shortened. */
export const MAX_COMMAND = 500;
export const MAX_LINES = 8;
const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_S = 60, MAX_TIMEOUT_S = 600;

// Commands that only look. Windows names are lower case (PowerShell does not care about case).
const WIN_READ = new Set([
  'get-childitem', 'ls', 'dir', 'gci', 'get-content', 'cat', 'type', 'gc', 'select-string', 'sls', 'findstr',
  'get-process', 'ps', 'gps', 'tasklist', 'get-command', 'gcm', 'where', 'where.exe', 'test-path', 'resolve-path', 'get-item', 'gi',
  'get-itemproperty', 'gp', 'get-location', 'pwd', 'gl', 'get-date', 'get-service', 'get-filehash', 'get-volume',
  'get-psdrive', 'select-object', 'select', 'sort-object', 'sort', 'measure-object', 'measure', 'where-object',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'write-output', 'echo', 'whoami', 'hostname',
]);
const UNIX_READ = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'wc', 'pwd', 'whoami', 'id', 'uname', 'uptime', 'which', 'df', 'du', 'ps',
  'stat', 'echo', 'date', 'hostname', 'sw_vers', 'mdfind',
]);
/** These change something when they get an argument (`hostname x`, `date -s`): read-only with none. */
const NO_ARGS = new Set(['hostname', 'date']);
/** Programs whose listed sub-commands only look. (Not git: a repo's own .git/config can make even `git status` run
 *  a program, e.g. core.fsmonitor, so every git command but `--version` asks.) */
const SUBS: Record<string, string[]> = {
  winget: ['list', 'search', 'show'],
  brew: ['list', 'search', 'info'],
};
/** The exact flags each program documents for printing its version, and nothing else. (No `npx`, which runs a
 *  package of that name, and no bare word like `version`, which some programs read as a command.) */
const VERSION_FLAGS: Record<string, string[]> = {
  node: ['--version', '-v'], npm: ['--version', '-v'], pnpm: ['--version'], yarn: ['--version'], bun: ['--version'],
  deno: ['--version'], python: ['--version', '-V'], python3: ['--version', '-V'], py: ['--version'], pip: ['--version', '-V'],
  git: ['--version'], gh: ['--version'], winget: ['--version', '-v'], brew: ['--version'], code: ['--version'],
  claude: ['--version'], clawdcursor: ['--version'], dotnet: ['--version'], java: ['-version', '--version'],
  cargo: ['--version'], rustc: ['--version'], ruby: ['--version'], docker: ['--version'], tsc: ['--version'],
  ffmpeg: ['-version'], pwsh: ['--version'],
};
/** A network or device path (\\server\share, //server, \\?\, a URL) anywhere in an argument: reading one can send the
 *  user's Windows sign-in to that server, so it is never "only looking". */
const REMOTE = /[\\/]{2}|::/;   // any two separators of either kind (\\, //, \/, /\), or a provider path (FileSystem::)

// Anything that chains, redirects, substitutes or groups, quoted or not; and curly quotes, which PowerShell reads as quotes.
const WIN_UNSAFE = /[;&<>(){}`$\r\n\u2018-\u201f]/;
const UNIX_UNSAFE = /[;&<>(){}`$\r\n\\\u2018-\u201f]/;     // and the backslash, which can hide a quote from this file
/** Characters that do not show, or that change the order text is shown in. */
/** Characters that don't show on screen (controls, zero-width, bidi): text with them is never shown on a Yes card. */
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u00a0\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** Splits on unquoted `|` into commands, and each command on unquoted spaces. Null: a quote never closes. */
function pipeline(command: string): { text: string; quoted: boolean }[][] | null {
  const out: { text: string; quoted: boolean }[][] = [[]];
  let token: { text: string; quoted: boolean } | null = null;
  let quote = '';
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = ''; else token!.text += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      token ??= { text: '', quoted: true };
      token.quoted = true;
    } else if (ch === '|' || ch === ' ' || ch === '\t') {
      if (token) { out[out.length - 1].push(token); token = null; }
      if (ch === '|') out.push([]);
    } else {
      token ??= { text: '', quoted: false };
      token.text += ch;
    }
  }
  if (quote) return null;
  if (token) out[out.length - 1].push(token);
  return out;
}

/** 'read' only when every command of the pipeline is known to only look. Everything else is 'ask'. */
export function classify(command: string, platform: string = process.platform): Verdict {
  const win = platform === 'win32';
  // A plain environment variable or the home folder as a value is fine; any other `$` is not.
  const plain = win ? command.replace(/\$env:\w+/gi, 'X').replace(/\$HOME\b/gi, 'X') : command.replace(/\$HOME\b/g, 'X');
  if ((win ? WIN_UNSAFE : UNIX_UNSAFE).test(plain) || HIDDEN.test(plain)) return 'ask';
  const parts = pipeline(plain);
  if (!parts) return 'ask';
  for (const tokens of parts) {
    if (!tokens.length || tokens[0].quoted) return 'ask';     // `a || b`, a trailing pipe, a quoted command name
    const name = win ? tokens[0].text.toLowerCase() : tokens[0].text;
    const args = tokens.slice(1).map(t => t.text);
    if (args.length === 1 && VERSION_FLAGS[name]?.includes(args[0])) continue;
    if (args.some(a => REMOTE.test(a))) return 'ask';
    if (SUBS[name]) {
      // the sub-command comes first (no `git -c …`), and nothing writes its output to a file
      if (!SUBS[name].includes(args[0]) || args.some(a => /^(-o|--output)/.test(a))) return 'ask';
      continue;
    }
    if (!(win ? WIN_READ : UNIX_READ).has(name)) return 'ask';
    if (NO_ARGS.has(name) && args.length) return 'ask';
  }
  return 'read';
}

// ── running ──────────────────────────────────────────────────────────────────

export interface ExecResult { code: number | null; out: string; timedOut: boolean }
export type Exec = (command: string, timeoutMs: number) => Promise<ExecResult>;

export interface ShellDeps {
  /** The Yes/No card: Blob's question, and the command under it exactly as it will run. */
  ask: (question: string, detail: string) => Promise<boolean>;
  exec: Exec;
  platform?: string;
}

const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });

function capped(out: string): string {
  const t = out.trim();
  if (t.length <= MAX_OUTPUT) return t;
  return `${t.slice(0, MAX_OUTPUT - 1500)}\n… ${t.length - MAX_OUTPUT} characters left out …\n${t.slice(-1500)}`;
}

/** What every command passes before it is shown or run (run, and a saved script): null when it is fit. */
export function unfit(command: string): ToolResult | null {
  if (!command) return failed('NO_COMMAND', 'pass the command to run');
  if (command.length > MAX_COMMAND || command.split('\n').length > MAX_LINES) {
    return failed('TOO_LONG', `a command is at most ${MAX_COMMAND} characters and ${MAX_LINES} lines, so the user can read all of it; do it in smaller steps`);
  }
  if (HIDDEN.test(command)) return refused('HIDDEN_CHARACTERS', 'the command has characters that do not show on screen; write it in plain text');
  return null;
}

export const saidNo = (): ToolResult =>
  refused('USER_SAID_NO', 'the user did not allow this command (or did not answer); do not run it another way, tell them it was not run');

export async function runTool(a: { command?: unknown; timeout_s?: unknown }, d: ShellDeps): Promise<ToolResult> {
  const command = typeof a.command === 'string' ? a.command.trim() : '';
  const bad = unfit(command);
  if (bad) return bad;
  const asked = classify(command, d.platform) === 'ask';
  if (asked && !(await d.ask('Run this command?', command))) return saidNo();
  const r = await execTool(command, asked, d, a.timeout_s);
  // A change that worked: said here, where the model is, so the next time can be one script_run (a saved script
  // runs through execTool, so it is not told to save itself again).
  return r.text.endsWith('\n[confirmed]') ? { ...r, text: r.text.replace(/\[confirmed\]$/, SAVE_HINT) } : r;
}
const SAVE_HINT = '[confirmed · next: if the user may ask for this again, save this command with script_save before you answer]';

/** Runs a command that passed its checks and its question. `changes`: it is not a look, so a good end is confirmed. */
export async function execTool(command: string, changes: boolean, d: ShellDeps, timeout_s?: unknown): Promise<ToolResult> {
  const secs = Number(timeout_s);
  const timeoutMs = 1000 * (Number.isFinite(secs) && secs > 0 ? Math.min(secs, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S);
  let r: ExecResult;
  try { r = await d.exec(command, timeoutMs); } catch (e) { return failed('CANT_RUN', (e as Error).message); }
  const out = capped(r.out) || '(no output)';
  if (r.timedOut) return { text: `${out}\n[failed · TIMEOUT · hint: stopped after ${timeoutMs / 1000} s; pass a longer timeout_s if it needs one]`, isError: true };
  if (r.code !== 0) return { text: `${out}\n[failed · EXIT_${r.code} · hint: the command ended with an error; its output is above]`, isError: true };
  // A look has no outcome line (like list_dir); a change the user allowed is confirmed.
  return { text: changes ? `${out}\n[confirmed]` : out, isError: false };
}

/** The command's environment: none of Blob's own tokens, no API keys. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|BLOB_)/i.test(k) || /^CLAUDECODE$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** How the command is started: PowerShell (output as UTF-8, no progress bars), or the user's login shell. */
export function shellArgv(command: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform === 'win32') {
    const quiet = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ";
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', quiet + command]];
  }
  return [env.SHELL || '/bin/sh', ['-lc', command]];
}

/** macOS/Linux: the commands running now. Each is in its own process group, so a signal to Blob's group misses it. */
export const live = new Set<number>();

/** Stops every running command, whole group. */
export function killLive(kill: (pid: number, signal: string) => void = (pid, s) => { process.kill(pid, s); }): void {
  for (const pid of live) try { kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  live.clear();
}

// Stop (or quit) ends this process with a signal, and the timeout below dies with it: take the commands along.
let hooked = false;
function hookExit(): void {
  if (hooked || process.platform === 'win32') return;
  hooked = true;
  try {
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(s, () => { killLive(); process.exit(143); });
    process.stdin.once('end', () => killLive());    // the parent went away without a signal to this group
  } catch (e) { console.error(`Blob: could not watch for Stop: ${(e as Error).message}`); }
}

/** Runs it in the home folder, stdout and stderr together, and stops the whole tree at the timeout (or when Blob is stopped). */
export const systemExec: Exec = (command, timeoutMs) => new Promise((res, rej) => {
  const [exe, args] = shellArgv(command);
  const p = spawn(exe, args, {
    cwd: homedir(), env: shellEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  if (process.platform !== 'win32' && p.pid) { live.add(p.pid); hookExit(); }
  let out = '', timedOut = false;
  const take = (d: Buffer) => { if (out.length < 200_000) out += d.toString('utf8'); };
  p.stdout.on('data', take);
  p.stderr.on('data', take);
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }, timeoutMs);
  p.on('error', e => { clearTimeout(timer); live.delete(p.pid!); rej(e); });
  p.on('close', code => { clearTimeout(timer); live.delete(p.pid!); res({ code, out, timedOut }); });
});
