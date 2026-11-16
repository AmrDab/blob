import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as setup from '../src/setup.ts';
import { MAC_PANES, fix, macNeeds, parseAuthStatus, parseMacStatus, pickBrain, runChecks, type Runner } from '../src/setup.ts';

describe('first-run check', () => {
  it('reads `claude auth status --json`', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(parseAuthStatus('{"loggedIn":false}')).toBe(false);
    expect(parseAuthStatus('Not logged in')).toBe(false);
    expect(parseAuthStatus('')).toBe(false);
  });

  it('reads the macOS permissions from `clawdcursor status`', () => {
    const both = '\x1b[32m✓\x1b[39m Consent: Granted\n\x1b[32m✓\x1b[39m Accessibility: Granted\n\x1b[32m✓\x1b[39m Screen Recording: Granted \n';
    expect(parseMacStatus(both)).toEqual({ accessibility: true, screenRecording: true });
    // "Could not check" is not "Not granted": the screen is still read, so it does not hold setup up
    expect(parseMacStatus('✗ Accessibility: Not granted\n⚠ Screen Recording: Could not check (optional)')).toEqual({ accessibility: false, screenRecording: true });
    expect(parseMacStatus('✓ Accessibility: Granted\n⚠ Screen Recording: Not granted (optional)')).toEqual({ accessibility: true, screenRecording: false });
    expect(parseMacStatus('✓ Accessibility: Granted\n')).toEqual({ accessibility: true, screenRecording: false });   // no line: status failed
  });
});

// A fake computer: which programs are there, and what `clawdcursor status` says. Nothing real is run or installed.
describe('one-tap setup, with a fake runner', () => {
  let home = '';
  let ran: string[] = [];
  let pc = { claude: true, signedIn: true, codex: false, codexSignedIn: false, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
  const codex = { command: 'codex', args: [] };      // not looked up on this computer
  const run: Runner = async (command, args) => {
    const line = [command, ...args].join(' ').replace(/^cmd \/c /, '');
    ran.push(line);
    if (line === 'claude --version') return { ok: pc.claude, out: '' };
    if (line === 'claude auth status --json') return { ok: true, out: JSON.stringify({ loggedIn: pc.signedIn }) };
    if (line === 'codex --version') return { ok: pc.codex, out: '' };
    if (line === 'codex login status') return { ok: pc.codexSignedIn, out: '' };   // exit 0 = signed in
    if (line === 'npm i -g clawdcursor') { pc.clawdcursor = true; return { ok: true, out: '' }; }
    if (!line.startsWith('clawdcursor ') || !pc.clawdcursor) return { ok: false, out: '' };
    if (line === 'clawdcursor consent --accept') {      // clawdcursor writes its own consent file
      mkdirSync(join(home, '.clawdcursor'), { recursive: true });
      writeFileSync(join(home, '.clawdcursor', 'consent'), '{}');
    }
    return { ok: true, out: line === 'clawdcursor status' ? pc.mac : '' };
  };
  const failing = async (platform: string) => (await runChecks(platform, run, home, codex, 'claude')).filter(c => !c.ok).map(c => c.id);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'blob-setup-'));
    ran = [];
    pc = { claude: true, signedIn: true, codex: false, codexSignedIn: false, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installs clawdcursor, then gets its OK, each with one command, and checks again after', async () => {
    expect(await failing('win32')).toEqual(['clawdcursor']);          // its OK is not asked for before it is there
    expect(await fix('clawdcursor', run, 'win32')).toBe(true);
    expect(ran).toContain('npm i -g clawdcursor');
    expect(await failing('win32')).toEqual(['consent']);
    expect(await fix('consent', run, 'win32')).toBe(true);
    expect(ran).toContain('clawdcursor consent --accept');
    expect(await failing('win32')).toEqual([]);
  });

  it('keeps the brain as commands to copy, both of them: no tap, and nothing is run for them', async () => {
    pc.claude = false;
    const checks = await runChecks('win32', run, home, codex, 'claude');
    expect(checks[0]).toMatchObject({ id: 'brain', ok: false, label: 'Install Claude Code or Codex', fix: 'irm https://claude.ai/install.ps1 | iex', alt: 'npm i -g @openai/codex', ready: [] });
    expect(checks[0].tap).toBeUndefined();
    expect(checks.some(c => c.id === 'signin')).toBe(false);          // sign-in comes after the install
    expect(await fix('brain', run, 'win32')).toBe(false);
    pc.claude = true; pc.signedIn = false;
    const signin = (await runChecks('darwin', run, home, codex, 'claude')).find(c => c.id === 'signin');
    expect(signin).toMatchObject({ ok: false, label: 'Sign in to Claude Code', fix: 'claude auth login' });
    expect(signin?.alt).toBeUndefined();                              // Codex is not installed: only Claude Code's sign-in
    expect(ran.join('\n')).not.toMatch(/install\.(ps1|sh)|auth login|npm i -g @openai|codex login$/);
  });

  it('needs one brain, either one: finds which are installed and signed in', async () => {
    const brain = async () => (await runChecks('win32', run, home, codex, 'claude')).filter(c => c.id === 'brain' || c.id === 'signin');
    expect(await brain()).toMatchObject([{ ok: true, ready: ['claude'] }, { ok: true }]);                       // Claude Code only
    pc = { ...pc, claude: false, codex: true, codexSignedIn: true };
    expect(await brain()).toMatchObject([{ ok: true, ready: ['codex'] }, { ok: true }]);                        // Codex only: enough
    pc.codexSignedIn = false;
    expect(await brain()).toMatchObject([{ ok: true, ready: [] }, { ok: false, label: 'Sign in to Codex', fix: 'codex login' }]);
    pc = { ...pc, claude: true, signedIn: false };
    expect(await brain()).toMatchObject([{ ok: true, ready: [] }, { ok: false, label: 'Sign in to Claude Code or Codex', fix: 'claude auth login', alt: 'codex login' }]);
    pc.codexSignedIn = true;
    expect(await brain()).toMatchObject([{ ok: true, ready: ['codex'] }, { ok: true }]);                        // one signed in is enough
    pc.signedIn = true;
    expect(await brain()).toMatchObject([{ ok: true, ready: ['claude', 'codex'] }, { ok: true }]);
    // Codex is started the way the Brain starts it: here through Node, with the script npm's shim names
    ran = [];
    await runChecks('win32', run, home, { command: 'node.exe', args: ['codex.js'] }, 'claude');
    expect(ran).toEqual(expect.arrayContaining(['node.exe codex.js --version']));
  });

  it('uses the brain the user picked when it is ready, else the one that is', () => {
    expect(pickBrain('claude', ['claude', 'codex'])).toBe('claude');
    expect(pickBrain('codex', ['claude', 'codex'])).toBe('codex');
    expect(pickBrain('claude', ['codex'])).toBe('codex');             // only Codex is ready: Blob uses it
    expect(pickBrain('codex', ['claude'])).toBe('claude');
    expect(pickBrain('codex', [])).toBe('codex');                     // none ready (or not checked yet): the setting stands
  });

  it('macOS: starts Claude Code by its full path when it is not on PATH, and the sign-in command names it too', async () => {
    const at = '/Users/a/.local/bin/claude';
    const there: Runner = async (command, args) => {
      ran.push([command, ...args].join(' '));
      return command === at ? { ok: true, out: '{"loggedIn":false}' } : { ok: false, out: '' };
    };
    const checks = await runChecks('darwin', there, home, codex, at);
    expect(checks[0]).toMatchObject({ id: 'brain', ok: true });
    expect(checks[1]).toMatchObject({ id: 'signin', ok: false, fix: `${at} auth login` });
    expect(ran).toEqual(expect.arrayContaining([`${at} --version`, `${at} auth status --json`]));
    const spaced = (await runChecks('darwin', async c => ({ ok: c.endsWith('claude'), out: '' }), home, codex, '/Users/a b/.local/bin/claude'))[1];
    expect(spaced.fix).toBe('"/Users/a b/.local/bin/claude" auth login');
  });

  it('macOS: says why when npm may not write to its global folder (EACCES), and only then', async () => {
    const denied: Runner = async () => ({ ok: false, out: '', err: 'npm error code EACCES\nnpm error syscall mkdir' });
    expect(await fix('clawdcursor', denied, 'darwin')).toBe(false);
    expect(setup.fixNote).toMatch(/sudo/);
    expect(setup.fixNote).not.toMatch(/clawdcursor/i);
    expect(await fix('clawdcursor', denied, 'win32')).toBe(false);
    expect(setup.fixNote).toBe('');
    expect(await fix('clawdcursor', async () => ({ ok: false, out: '', err: 'npm error network' }), 'darwin')).toBe(false);
    expect(setup.fixNote).toBe('');
  });

  it('says a failed install failed', async () => {
    const broken: Runner = async () => ({ ok: false, out: '' });
    expect(await fix('clawdcursor', broken, 'linux')).toBe(false);
    expect(await fix('nothing', run, 'linux')).toBe(false);
  });

  it('macOS: asks for the permissions with `clawdcursor grant`, and opens Accessibility first, then Screen Recording', async () => {
    pc.clawdcursor = true;
    expect(await failing('darwin')).toEqual(['consent', 'mac']);
    expect(await failing('win32')).toEqual(['consent']);              // only a Mac asks
    expect(await fix('mac', run, 'darwin')).toBe(true);
    expect(ran).toContain('clawdcursor grant');
    expect(await fix('mac', run, 'win32')).toBe(false);
    expect(await macNeeds(run)).toEqual({ ok: false, pane: MAC_PANES.accessibility });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Not granted';
    expect(await macNeeds(run)).toEqual({ ok: false, pane: MAC_PANES.screenRecording });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Granted';
    expect(await macNeeds(run)).toEqual({ ok: true });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Could not check (optional)';
    expect(await macNeeds(run)).toEqual({ ok: true });                // the card clears
    expect(MAC_PANES.accessibility).toMatch(/^x-apple\.systempreferences:.*Privacy_Accessibility$/);
    expect(MAC_PANES.screenRecording).toMatch(/^x-apple\.systempreferences:.*Privacy_ScreenCapture$/);
  });
});
