// What macOS and Linux share.
import { execFile } from 'node:child_process';
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
  claudeInstall: 'curl -fsSL https://claude.ai/install.sh | bash',
  trashName: 'Trash',
} satisfies Partial<Os>;
