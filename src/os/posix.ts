// What macOS and Linux share.
import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import type { Exec, Os } from './types.ts';

const shell: Os['shell'] = {
  label: 'shell',
  name: 'the login shell',
  scriptExt: '.sh',
  looks: 'ls, cat, grep, ps, which, --version',
  dialect: 'posix',
  argv: (command, env) => [env.SHELL || '/bin/sh', ['-lc', command]],
};

/** Runs a program to its end. */
export const run: Exec = (cmd, args) => new Promise<void>((res, rej) =>
  execFile(cmd, args, { windowsHide: true, timeout: 60_000 }, (err, _out, stderr) => (err ? rej(new Error(stderr.trim() || err.message)) : res())));

export const posix = {
  shell,
  spawnGroup: true,
  killTree(pid, signal) {
    try { process.kill(-pid, signal); } catch { /* already gone */ }
  },
  cli: parts => ({ command: parts[0], args: parts.slice(1) }),
  // Its installer puts it in ~/.local/bin (an older one in ~/.claude/local) and does not add that folder to PATH,
  // so when PATH has no `claude` Blob looks there itself.
  findClaude(env, home, exists) {
    try {
      if ((env.PATH ?? '').split(delimiter).some(d => d && exists(join(d, 'claude')))) return 'claude';
      for (const p of [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude')]) if (exists(p)) return p;
    } catch (e) { console.log(`Blob: could not look for Claude Code: ${(e as Error).message}`); }
    return 'claude';                                  // not found: starting it fails, and the first-run check says so
  },
  findCodex: () => ({ command: 'codex', args: [] }),
  claudeInstall: 'curl -fsSL https://claude.ai/install.sh | bash',
  trashName: 'Trash',
} satisfies Partial<Os>;
