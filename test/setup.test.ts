import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAC_PANES, fix, macNeeds, parseAuthStatus, parseMacStatus, runChecks, type Runner } from '../src/setup.ts';

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
    expect(parseMacStatus('✗ Accessibility: Not granted\n⚠ Screen Recording: Could not check')).toEqual({ accessibility: false, screenRecording: false });
  });
});

// A fake computer: which programs are there, and what `clawdcursor status` says. Nothing real is run or installed.
describe('one-tap setup, with a fake runner', () => {
  let home = '';
  let ran: string[] = [];
  let pc = { claude: true, signedIn: true, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
  const run: Runner = async (command, args) => {
    const line = [command, ...args].join(' ').replace(/^cmd \/c /, '');
    ran.push(line);
    if (line === 'claude --version') return { ok: pc.claude, out: '' };
    if (line === 'claude auth status --json') return { ok: true, out: JSON.stringify({ loggedIn: pc.signedIn }) };
    if (line === 'npm i -g clawdcursor') { pc.clawdcursor = true; return { ok: true, out: '' }; }
    if (!line.startsWith('clawdcursor ') || !pc.clawdcursor) return { ok: false, out: '' };
    if (line === 'clawdcursor consent --accept') {      // clawdcursor writes its own consent file
      mkdirSync(join(home, '.clawdcursor'), { recursive: true });
      writeFileSync(join(home, '.clawdcursor', 'consent'), '{}');
    }
    return { ok: true, out: line === 'clawdcursor status' ? pc.mac : '' };
  };
  const failing = async (platform: string) => (await runChecks(platform, run, home)).filter(c => !c.ok).map(c => c.id);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'blob-setup-'));
    ran = [];
    pc = { claude: true, signedIn: true, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
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

  it('keeps Claude Code as commands to copy: no tap, and nothing is run for them', async () => {
    pc.claude = false;
    const checks = await runChecks('win32', run, home);
    expect(checks[0]).toMatchObject({ id: 'claude', ok: false, fix: 'irm https://claude.ai/install.ps1 | iex' });
    expect(checks[0].tap).toBeUndefined();
    expect(checks.some(c => c.id === 'signin')).toBe(false);          // sign-in comes after the install
    expect(await fix('claude', run, 'win32')).toBe(false);
    pc.claude = true; pc.signedIn = false;
    expect((await runChecks('darwin', run, home)).find(c => c.id === 'signin')).toMatchObject({ ok: false, fix: 'claude auth login' });
    expect(ran.join('\n')).not.toMatch(/install\.(ps1|sh)|auth login/);
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
    expect(MAC_PANES.accessibility).toMatch(/^x-apple\.systempreferences:.*Privacy_Accessibility$/);
    expect(MAC_PANES.screenRecording).toMatch(/^x-apple\.systempreferences:.*Privacy_ScreenCapture$/);
  });
});
