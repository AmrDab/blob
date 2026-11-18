// Blob updates itself, with no reinstall. It asks npm for the newest `theblob` (at start and once a day; nothing is
// sent but that request), offers it on a Yes card, installs it into a folder of its own (~/.blob/app/<version>: no
// admin rights, no terminal) and starts it once this one has quit. The folder of the version before stays, for a
// rollback by hand; older ones go.
// Only the installed npm package does this (scripts/pack.mjs names it `theblob`): a source checkout updates with git.
// Everything that touches the system is passed in, so tests use fakes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { os } from './os/index.ts';
import { shellEnv } from './safe.ts';

export const PACKAGE = 'theblob';
export const LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;
const INSTALL_MS = 10 * 60_000;

export interface UpdateDeps {
  blobHome: string;
  /** This Blob's own package.json: named `theblob` it is the installed package, anything else a source checkout. */
  pkg: { name: string; version: string };
  /** The real Node: on macOS the one Blob.app's copy came from (BLOB_NODE), not the copy. */
  node: string;
  /** BLOB_UPDATE_SOURCE, for a test only: "<version>=<path to a .tgz>". */
  source?: string;
  /** GET, as JSON; throws when it can't. */
  getJson(url: string): Promise<unknown>;
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  exists(file: string): boolean;
  /** The file a link leads to. */
  real(file: string): string;
  /** A folder's file names; none when there is no such folder. */
  list(dir: string): string[];
  mkdir(dir: string): void;
  removeDir(dir: string): void;
  /** Where npm's npm-cli.js is, for a Node at this path (os.npmCli). */
  npmCli(node: string): string;
  /** Runs a program to its end; false when it failed. */
  run(exe: string, args: string[]): Promise<boolean>;
  /** Starts a program that carries on when this one has quit, with these variables added. */
  start(exe: string, args: string[], env: Record<string, string>): void;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** `a` is a later version than `b`. Only a plain x.y.z counts: anything else is never newer. */
export function newer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Running from the installed npm package, not from a source checkout. */
export const installed = (d: Pick<UpdateDeps, 'pkg'>) => d.pkg.name === PACKAGE;

/** BLOB_UPDATE_SOURCE: a local package to update to, in place of npm's. */
export function testSource(source?: string): { version: string; tgz: string } | undefined {
  const m = source?.match(/^(\d+\.\d+\.\d+)=(.+\.tgz)$/);
  return m ? { version: m[1], tgz: m[2] } : undefined;
}

/** The newest version there is; undefined when it can't be read. */
export async function latest(d: UpdateDeps): Promise<string | undefined> {
  const t = testSource(d.source);
  if (t) return t.version;
  try {
    const v = (await d.getJson(LATEST) as { version?: unknown } | null)?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : undefined;
  } catch { return undefined; }
}

const stateFile = (d: UpdateDeps) => join(d.blobHome, 'update.json');

/** The version the user said No to. */
export function skipped(d: UpdateDeps): string {
  try { return String((JSON.parse(d.read(stateFile(d)) ?? '{}') as { skipped?: unknown }).skipped ?? ''); } catch { return ''; }
}

/** No: that version is never offered again. */
export function skip(d: UpdateDeps, version: string): void {
  try { d.write(stateFile(d), JSON.stringify({ skipped: version }) + '\n'); } catch { /* it is offered once more */ }
}

/** The version to offer: newer than this one, and not one the user said No to. Never in a source checkout. */
export async function toOffer(d: UpdateDeps): Promise<string | undefined> {
  if (!installed(d)) return undefined;
  const v = await latest(d);
  return v && newer(v, d.pkg.version) && v !== skipped(d) ? v : undefined;
}

export const question = (version: string) => `Blob ${version} is out. Update now?`;

const versionDir = (d: UpdateDeps, version: string) => join(d.blobHome, 'app', version);
/** What starts an installed version. */
export const cliOf = (d: UpdateDeps, version: string) => join(versionDir(d, version), 'node_modules', PACKAGE, 'cli.js');

/** npm, run with Node itself (Node does not start npm.cmd without a shell). Beside the real Node, or beside the link to it (Homebrew). */
const npmOf = (d: UpdateDeps) => [d.real(d.node), d.node].map(d.npmCli).find(d.exists);

/**
 * Installs a version into its own folder and checks that it loads (`--check`: no window). Gives its cli.js; throws
 * why not, for the log. A failure leaves nothing behind. Then only this version's folder and the new one stay.
 */
export async function install(d: UpdateDeps, version: string): Promise<string> {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version`);
  const npm = npmOf(d);
  if (!npm) throw new Error('npm was not found beside Node');
  const dir = versionDir(d, version), cli = cliOf(d, version), t = testSource(d.source);
  const what = t?.version === version ? t.tgz : `${PACKAGE}@${version}`;
  d.mkdir(dir);
  const got = await d.run(d.node, [npm, 'install', what, '--prefix', dir, '--omit=dev', '--no-audit', '--no-fund']) && d.exists(cli);
  if (!got || !(await d.run(d.node, [cli, '--check']))) {
    d.removeDir(dir);
    throw new Error(got ? 'the new version did not load' : 'npm install failed');
  }
  for (const v of d.list(join(d.blobHome, 'app'))) {
    if (VERSION.test(v) && v !== version && v !== d.pkg.version) d.removeDir(versionDir(d, v));
  }
  return cli;
}

/** Starts the new version, which waits for this one to quit: the caller quits now. BLOB_UPDATED: the version it took over from. */
export const switchTo = (d: UpdateDeps, cli: string): void => d.start(d.node, [cli], { BLOB_UPDATED: d.pkg.version });

// ── the real system ─────────────────────────────────────────────────────────

export function systemUpdate(blobHome: string, pkg: UpdateDeps['pkg'], env: NodeJS.ProcessEnv = process.env): UpdateDeps {
  return {
    blobHome, pkg, node: env.BLOB_NODE || process.execPath, source: env.BLOB_UPDATE_SOURCE,
    getJson: async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    read: file => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
    write: (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); },
    exists: existsSync,
    real: file => { try { return realpathSync(file); } catch { return file; } },
    list: dir => { try { return readdirSync(dir); } catch { return []; } },
    mkdir: dir => { mkdirSync(dir, { recursive: true }); },
    removeDir: dir => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* it stays: a few MB */ } },
    npmCli: os.npmCli,
    // npm and the new version's check get none of Blob's own variables
    run: (exe, args) => new Promise(res => spawn(exe, args, { windowsHide: true, stdio: 'ignore', timeout: INSTALL_MS, env: shellEnv(env) })
      .on('error', () => res(false)).on('close', code => res(code === 0))),
    // Without BLOB_APP: on macOS the new version writes its own start and opens itself as Blob.app (main.ts).
    start: (exe, args, add) => {
      const { BLOB_APP: _app, ...rest } = env;
      spawn(exe, args, { detached: os.spawnGroup, stdio: 'ignore', windowsHide: true, env: { ...rest, ...add } }).unref();
    },
  };
}
