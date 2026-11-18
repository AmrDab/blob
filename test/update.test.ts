// Blob updating itself (update.ts): the look at npm, which version is newer, the install into its own folder and the
// switch. Everything that touches the system is a fake here: no network, no npm, nothing started.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Questions } from '../src/ask.ts';
import { LATEST, cliOf, install, installed, latest, newer, question, skip, skipped, switchTo, testSource, toOffer, type UpdateDeps } from '../src/update.ts';

const HOME = join('H', '.blob'), NODE = join('N', 'bin', 'node'), NPM = join('N', 'npm-cli.js');
const dirOf = (v: string) => join(HOME, 'app', v);

function fake(o: Partial<UpdateDeps> = {}) {
  const files = new Map<string, string>([[NPM, 'npm']]), dirs = new Set<string>(), fetched: string[] = [];
  const ran: string[][] = [], started: { exe: string; args: string[]; env: Record<string, string> }[] = [];
  const state = { latest: '0.2.0' as unknown, npmOk: true, checkOk: true };
  const d: UpdateDeps = {
    blobHome: HOME, pkg: { name: 'theblob', version: '0.1.0' }, node: NODE,
    getJson: async url => { fetched.push(url); if (state.latest === undefined) throw new Error('offline'); return { name: 'theblob', version: state.latest }; },
    read: f => files.get(f),
    write: (f, t) => { files.set(f, t); },
    exists: f => files.has(f),
    real: f => f,
    list: dir => [...dirs].filter(x => join(x, '..') === dir).map(x => x.slice(dir.length + 1)),
    mkdir: dir => { dirs.add(dir); },
    removeDir: dir => { dirs.delete(dir); for (const f of files.keys()) if (f.startsWith(dir)) files.delete(f); },
    npmCli: () => NPM,
    run: async (exe, args) => {
      ran.push([exe, ...args]);
      if (args[1] !== 'install') return state.checkOk;                 // <cli> --check
      if (state.npmOk) files.set(join(args[args.indexOf('--prefix') + 1], 'node_modules', 'theblob', 'cli.js'), 'cli');
      return state.npmOk;
    },
    start: (exe, args, env) => { started.push({ exe, args, env }); },
    ...o,
  };
  return { d, files, dirs, fetched, ran, started, state };
}

describe('which version is newer', () => {
  it('compares the numbers, not the text', () => {
    expect(newer('0.2.0', '0.1.0')).toBe(true);
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('1.0.0', '0.99.99')).toBe(true);
    expect(newer('0.1.0', '0.1.0')).toBe(false);
    expect(newer('0.1.0', '0.2.0')).toBe(false);
  });

  it('anything that is not a plain x.y.z is never newer', () => {
    for (const v of ['', 'latest', '1.0', '0.2.0-beta.1', '../../x', '0.2.0 --global', 'v0.2.0']) expect(newer(v, '0.1.0'), v).toBe(false);
  });
});

describe('the look at npm', () => {
  it('asks only for the newest theblob, and offers it when it is newer', async () => {
    const f = fake();
    expect(LATEST).toBe('https://registry.npmjs.org/theblob/latest');
    expect(await toOffer(f.d)).toBe('0.2.0');
    expect(f.fetched).toEqual([LATEST]);
    f.state.latest = '0.1.0';
    expect(await toOffer(f.d)).toBeUndefined();
  });

  it('offers nothing when npm can\'t be reached or answers with something that is not a version', async () => {
    const f = fake();
    for (const bad of [undefined, 7, '0.2.0; rm -rf', '../x']) {
      f.state.latest = bad;
      expect(await latest(f.d)).toBeUndefined();
      expect(await toOffer(f.d)).toBeUndefined();
    }
  });

  it('is never made from a source checkout: only the installed package updates itself', async () => {
    const f = fake({ pkg: { name: 'blob', version: '0.1.0' } });
    expect(installed(f.d)).toBe(false);
    expect(await toOffer(f.d)).toBeUndefined();
    expect(f.fetched).toEqual([]);
    expect(installed(fake().d)).toBe(true);
  });

  it('a No is kept: that version is never offered again, the next one is', async () => {
    const f = fake();
    expect(skipped(f.d)).toBe('');
    skip(f.d, '0.2.0');
    expect(JSON.parse(f.files.get(join(HOME, 'update.json'))!)).toEqual({ skipped: '0.2.0' });
    expect(await toOffer(f.d)).toBeUndefined();
    f.state.latest = '0.2.1';
    expect(await toOffer(f.d)).toBe('0.2.1');
    f.files.set(join(HOME, 'update.json'), '{ not json');
    expect(skipped(f.d)).toBe('');
  });

  it('asks in Blob\'s name only', () => {
    expect(question('0.2.0')).toBe('Blob 0.2.0 is out. Update now?');
  });
});

describe('the install', () => {
  it('runs npm with Node itself into the version\'s own folder, checks that the new version loads, and gives its cli.js', async () => {
    const f = fake();
    const cli = await install(f.d, '0.2.0');
    expect(cli).toBe(join(dirOf('0.2.0'), 'node_modules', 'theblob', 'cli.js'));
    expect(cli).toBe(cliOf(f.d, '0.2.0'));
    expect(f.ran).toEqual([
      [NODE, NPM, 'install', 'theblob@0.2.0', '--prefix', dirOf('0.2.0'), '--omit=dev', '--no-audit', '--no-fund'],
      [NODE, cli, '--check'],
    ]);
    expect(f.started).toEqual([]);                                     // nothing is started by an install
  });

  it('finds npm beside the real Node, or beside the link to it', async () => {
    const real = join('Cellar', 'bin', 'node'), asked: string[] = [];
    const f = fake({ real: () => real, npmCli: node => { asked.push(node); return node === NODE ? NPM : join('nowhere', 'npm-cli.js'); } });
    await install(f.d, '0.2.0');
    expect(asked).toEqual([real, NODE]);
    expect(f.ran[0][1]).toBe(NPM);
    const none = fake({ npmCli: () => join('nowhere', 'npm-cli.js') });
    await expect(install(none.d, '0.2.0')).rejects.toThrow(/npm was not found/);
    expect(none.ran).toEqual([]);
  });

  it('a failed install, or a new version that does not load, leaves nothing behind', async () => {
    const f = fake();
    f.state.npmOk = false;
    await expect(install(f.d, '0.2.0')).rejects.toThrow(/npm install failed/);
    expect(f.dirs.size).toBe(0);
    f.state.npmOk = true;
    f.state.checkOk = false;
    await expect(install(f.d, '0.2.0')).rejects.toThrow(/did not load/);
    expect(f.dirs.size).toBe(0);
    expect(f.files.has(cliOf(f.d, '0.2.0'))).toBe(false);
  });

  it('refuses a version that is not a plain x.y.z before anything runs', async () => {
    const f = fake();
    await expect(install(f.d, '0.2.0 --global')).rejects.toThrow(/not a version/);
    await expect(install(f.d, '../x')).rejects.toThrow(/not a version/);
    expect(f.ran).toEqual([]);
  });

  it('keeps the folder of the version before (a rollback by hand) and removes older ones, and nothing that is not a version', async () => {
    const f = fake({ pkg: { name: 'theblob', version: '0.1.5' } });
    for (const v of ['0.1.0', '0.1.4', '0.1.5', 'notes']) f.dirs.add(dirOf(v));
    await install(f.d, '0.2.0');
    expect([...f.dirs].sort()).toEqual([dirOf('0.1.5'), dirOf('0.2.0'), dirOf('notes')].sort());
  });

  it('nothing older is removed when the install fails', async () => {
    const f = fake({ pkg: { name: 'theblob', version: '0.1.5' } });
    for (const v of ['0.1.0', '0.1.5']) f.dirs.add(dirOf(v));
    f.state.npmOk = false;
    await expect(install(f.d, '0.2.0')).rejects.toThrow();
    expect([...f.dirs].sort()).toEqual([dirOf('0.1.0'), dirOf('0.1.5')].sort());
  });
});

describe('the switch', () => {
  it('starts the new version\'s cli.js with the real Node, and tells it which version it took over from', () => {
    const f = fake();
    switchTo(f.d, cliOf(f.d, '0.2.0'));
    expect(f.started).toEqual([{ exe: NODE, args: [cliOf(f.d, '0.2.0')], env: { BLOB_UPDATED: '0.1.0' } }]);
  });
});

describe('BLOB_UPDATE_SOURCE (a test only)', () => {
  const tgz = join('T', 'theblob-0.1.1.tgz');

  it('is "<version>=<path to a .tgz>", and nothing else', () => {
    expect(testSource(`0.1.1=${tgz}`)).toEqual({ version: '0.1.1', tgz });
    for (const bad of [undefined, '', tgz, '0.1.1', `latest=${tgz}`, '0.1.1=https://example.com/x']) expect(testSource(bad), String(bad)).toBeUndefined();
  });

  it('stands in for npm: no request is made, and that file is what gets installed', async () => {
    const f = fake({ source: `0.1.1=${tgz}` });
    expect(await toOffer(f.d)).toBe('0.1.1');
    expect(f.fetched).toEqual([]);
    await install(f.d, '0.1.1');
    expect(f.ran[0].slice(2, 4)).toEqual(['install', tgz]);
  });

  it('is not there for a user: without it the package comes from npm by name', async () => {
    const f = fake();
    await install(f.d, '0.2.0');
    expect(f.ran[0][3]).toBe('theblob@0.2.0');
  });
});

describe('when the offer may show', () => {
  it('a question is waiting while one is open; an offer is not a question', async () => {
    const q = new Questions({ show: () => {}, hide: () => {} });
    expect(q.waiting).toBe(false);
    const offer = q.offer(question('0.2.0'), 1000);
    expect(q.waiting).toBe(false);
    const asked = q.ask('Run this?');
    expect(q.waiting).toBe(true);
    q.answer('2', true);
    q.answer('1', false);
    expect(await asked).toBe(true);
    expect(await offer).toBe(false);
    expect(q.waiting).toBe(false);
  });
});
