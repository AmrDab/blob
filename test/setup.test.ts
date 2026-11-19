import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osFor } from '../src/os/index.ts';
import * as setup from '../src/setup.ts';
import { PROBE_ARGS, fix, macNeeds, parseAuthStatus, parseMacStatus, pickBrain, probe, runChecks, signedOut, type Runner } from '../src/setup.ts';

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
  let pc = { claude: true, signedIn: true, codex: false, codexSignedIn: false, browser: true, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
  const codex = { command: 'codex', args: [] };      // not looked up on this computer
  const run: Runner = async (command, args) => {
    const line = [command, ...args].join(' ').replace(/^cmd \/c /, '');
    ran.push(line);
    if (line === 'claude --version') return { ok: pc.claude, out: '' };
    if (line === 'claude auth status --json') return { ok: true, out: JSON.stringify({ loggedIn: pc.signedIn }) };
    if (line === 'codex --version') return { ok: pc.codex, out: '' };
    if (line === 'codex login status') return { ok: pc.codexSignedIn, out: '' };   // exit 0 = signed in
    if (/install\.(ps1|sh)/.test(line)) { pc.claude = true; return { ok: true, out: '' }; }
    if (line === 'claude auth login --claudeai') { pc.signedIn = pc.browser; return { ok: pc.browser, out: '' }; }   // ends when the user is through in the browser
    if (line === 'codex login') { pc.codexSignedIn = pc.browser; return { ok: pc.browser, out: '' }; }
    if (line === 'npm i -g clawdcursor') { pc.clawdcursor = true; return { ok: true, out: '' }; }
    if (line === 'npm i -g @openai/codex') { pc.codex = true; return { ok: true, out: '' }; }
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
    pc = { claude: true, signedIn: true, codex: false, codexSignedIn: false, browser: true, clawdcursor: false, mac: 'Accessibility: Not granted\nScreen Recording: Not granted' };
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); signedOut('claude'); signedOut('claude', false); });   // no probe passed, nobody signed out

  it('installs clawdcursor, then gets its OK, each with one command, and checks again after', async () => {
    expect(await failing('win32')).toEqual(['clawdcursor']);          // its OK is not asked for before it is there
    expect(await fix('clawdcursor', run, 'win32')).toBe(true);
    expect(ran).toContain('npm i -g clawdcursor');
    expect(await failing('win32')).toEqual(['consent']);
    expect(await fix('consent', run, 'win32')).toBe(true);
    expect(ran).toContain('clawdcursor consent --accept');
    expect(await failing('win32')).toEqual([]);
  });

  it('asks which AI the user has, and one tap on Claude installs Claude Code and goes straight on to its sign-in', async () => {
    pc = { ...pc, claude: false, signedIn: false };
    const checks = await runChecks('win32', run, home, codex, 'claude');
    expect(checks[0]).toMatchObject({ id: 'brain', ok: false, label: 'Which AI do you have?', tap: 'Claude', tap2: 'ChatGPT', ready: [] });
    expect(checks[0].text).not.toMatch(/terminal|copy/i);
    expect(checks[0].text).toMatch(/uses your subscription, once/);  // the test request is said before the tap
    expect(checks.some(c => c.id === 'signin')).toBe(false);          // sign-in comes with the install
    expect(ran.join('\n')).not.toMatch(/install\.(ps1|sh)|auth login|codex login$/);   // looking runs nothing
    ran = [];
    expect(await fix('brain', run, 'win32', 'claude', codex, 'claude')).toBe(true);
    const did = ran.filter(l => /install|login$|--claudeai/.test(l));
    expect(did[0]).toMatch(/^powershell\.exe -NoProfile -NonInteractive -Command .*irm https:\/\/claude\.ai\/install\.ps1 \| iex$/);
    expect(did.slice(1)).toEqual(['claude auth login --claudeai']);   // no second tap
    expect((await runChecks('win32', run, home, codex, 'claude')).slice(0, 2)).toMatchObject([{ id: 'brain', ok: true, ready: ['claude'] }, { id: 'signin', ok: true }]);
    pc.claude = false; ran = [];
    await fix('brain', run, 'darwin', 'claude', codex, 'claude');
    expect(ran).toContain('/bin/sh -lc curl -fsSL https://claude.ai/install.sh | bash');
    // an install that failed starts no sign-in
    const tried: string[] = [];
    expect(await fix('brain', async (c, a) => { tried.push([c, ...a].join(' ')); return { ok: false, out: '' }; }, 'linux', 'claude', codex, 'claude')).toBe(false);
    expect(tried.join('\n')).not.toMatch(/login/);
  });

  it('one tap on ChatGPT installs Codex with npm and goes straight on to its sign-in', async () => {
    pc = { ...pc, claude: false, signedIn: false };
    expect(await fix('brain', run, 'win32', 'codex', codex, 'claude')).toBe(true);
    expect(ran.filter(l => /install|npm|login$|--claudeai/.test(l))).toEqual(['npm i -g @openai/codex', 'codex login']);
    expect((await runChecks('win32', run, home, codex, 'claude')).slice(0, 2)).toMatchObject([{ id: 'brain', ok: true, ready: ['codex'] }, { id: 'signin', ok: true }]);
    // the sign-in was not finished: the install stands, and the Sign in card is what is left
    pc = { ...pc, codex: false, codexSignedIn: false, browser: false };
    expect(await fix('brain', run, 'darwin', 'codex', codex, 'claude')).toBe(false);
    expect((await runChecks('darwin', run, home, codex, 'claude')).slice(0, 2)).toMatchObject([{ id: 'brain', ok: true }, { id: 'signin', ok: false, label: 'Sign in to Codex' }]);
    // there already (asked for later, with "use Codex"): only the sign-in runs
    pc.browser = true; ran = [];
    expect(await fix('brain', run, 'darwin', 'codex', codex, 'claude')).toBe(true);
    expect(ran).not.toContain('npm i -g @openai/codex');
    expect(ran.at(-1)).toBe('codex login');
    // macOS: npm may not write to its global folder
    expect(await fix('brain', async () => ({ ok: false, out: '', err: 'npm error code EACCES' }), 'darwin', 'codex', codex, 'claude')).toBe(false);
    expect(setup.fixNote).toMatch(/sudo/);
  });

  it('tries the sign-in out with one real request, once, and believes it over `auth status`', async () => {
    const probes: { line: string; ms?: number; cwd?: string }[] = [];
    let says = { ok: true, out: '{"type":"result","is_error":false,"result":"ok"}', err: '' };
    const real: Runner = async (c, a, ms, cwd) => {
      if (a[0] !== '-p') return run(c, a, ms);
      probes.push({ line: [c, ...a].join(' '), ms, cwd });
      return says;
    };
    expect(PROBE_ARGS).toEqual(['-p', 'Reply with the one word: ok', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json',
      '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands', '--no-chrome', '--tools', '']);
    // nothing to try: Claude Code is not signed in, or Codex is the brain in use
    expect(await probe('claude', [], '/work', real, 'claude')).toBe(false);
    expect(await probe('codex', ['claude', 'codex'], '/work', real, 'claude')).toBe(false);
    expect(probes).toEqual([]);
    // a failure that says nothing about the sign-in (no network, a limit) decides nothing, and is asked again
    says = { ok: false, out: '{"is_error":true,"result":"API Error: 529 overloaded"}', err: '' };
    expect(await probe('claude', ['claude'], '/work', real, 'claude')).toBe(false);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ ms: 60_000, cwd: '/work' });   // in Blob's work folder
    // signed out, each way Claude Code says it: the sign-in card comes up though `auth status` says signed in
    for (const out of ['{"is_error":true,"api_error_status":401,"result":"Failed to authenticate"}', '{"is_error":true,"result":"Not logged in · Please run /login"}', 'authentication_failed']) {
      says = { ok: false, out, err: '' };
      expect(await probe('claude', ['claude'], '/work', real, 'claude')).toBe(true);
      expect((await runChecks('win32', real, home, codex, 'claude')).slice(0, 2)).toMatchObject([{ ready: [] }, { id: 'signin', ok: false, tap: 'Sign in' }]);
      expect(await fix('signin', real, 'win32', 'claude', codex, 'claude')).toBe(true);
    }
    expect(probes).toHaveLength(4);
    // it passes: no second request, whoever asks
    says = { ok: true, out: '{"type":"result","is_error":false,"result":"ok"}', err: '' };
    expect(await probe('claude', ['claude'], '/work', real, 'claude')).toBe(false);
    expect(await probe('claude', ['claude'], '/work', real, 'claude')).toBe(false);
    expect(probes).toHaveLength(5);
    expect((await runChecks('win32', real, home, codex, 'claude'))[0]).toMatchObject({ ready: ['claude'] });
    // until a run ends signed out: the next sign-in is tried out again
    signedOut('claude');
    expect(await fix('signin', real, 'win32', 'claude', codex, 'claude')).toBe(true);
    expect(await probe('claude', ['claude'], '/work', real, 'claude')).toBe(false);
    expect(probes).toHaveLength(6);
  });

  it('signs in with one tap: Blob runs the sign-in itself and waits for the browser, up to 5 minutes', async () => {
    pc.signedIn = false;
    const signin = async () => (await runChecks('darwin', run, home, codex, 'claude')).find(c => c.id === 'signin');
    expect(await signin()).toMatchObject({ ok: false, label: 'Sign in to Claude Code', tap: 'Sign in',
      text: 'Sign in with your Claude account in the browser window that opens. Blob carries on by itself.' });
    expect((await signin())?.alt).toBeUndefined();                    // Codex is not installed: only Claude Code's sign-in
    const waits: (number | undefined)[] = [];
    const timed: Runner = (c, a, ms) => { waits.push(ms); return run(c, a, ms); };
    expect(await fix('signin', timed, 'darwin', 'claude', codex, 'claude')).toBe(true);
    expect(ran.at(-1)).toBe('claude auth login --claudeai');
    expect(waits.at(-1)).toBe(300_000);
    expect(await signin()).toMatchObject({ ok: true });
    // the browser was closed, or the 5 minutes ran out: the card stays
    pc.signedIn = false; pc.browser = false;
    expect(await fix('signin', run, 'darwin', 'claude', codex, 'claude')).toBe(false);
    expect(await signin()).toMatchObject({ ok: false });
  });

  it('signs in to the brain the user picked when it is installed, else to the one that is', async () => {
    pc = { ...pc, signedIn: false, codex: true };
    expect((await runChecks('win32', run, home, codex, 'claude')).find(c => c.id === 'signin')?.text).toBe('Sign in with your account in the browser window that opens. Blob carries on by itself.');
    expect(await fix('signin', run, 'win32', 'codex', codex, 'claude')).toBe(true);
    expect(ran.at(-1)).toBe('codex login');
    pc = { ...pc, codex: false, codexSignedIn: false };
    expect(await fix('signin', run, 'win32', 'codex', codex, 'claude')).toBe(true);
    expect(ran.at(-1)).toBe('claude auth login --claudeai');
    pc.claude = false;
    expect(await fix('signin', run, 'win32', 'claude', codex, 'claude')).toBe(false);   // nothing to sign in to
  });

  it('believes a run that ended signed out over `auth status`, until a sign-in from the card works', async () => {
    const checks = async () => (await runChecks('win32', run, home, codex, 'claude')).filter(c => c.id === 'brain' || c.id === 'signin');
    expect(await checks()).toMatchObject([{ ready: ['claude'] }, { ok: true }]);          // auth status: loggedIn true
    signedOut('claude');                                                                  // ...but the run said "Not logged in"
    expect(await checks()).toMatchObject([{ ok: true, ready: [] }, { ok: false, tap: 'Sign in' }]);
    pc.browser = false;
    expect(await fix('signin', run, 'win32', 'claude', codex, 'claude')).toBe(false);     // a sign-in that did not finish changes nothing
    expect(await checks()).toMatchObject([{ ready: [] }, { ok: false }]);
    pc = { ...pc, codex: true, codexSignedIn: true };
    expect(await checks()).toMatchObject([{ ready: ['codex'] }, { ok: true }]);           // the other brain is ready: Blob uses it
    pc = { ...pc, codex: false, browser: true };
    expect(await fix('signin', run, 'win32', 'claude', codex, 'claude')).toBe(true);
    expect(await checks()).toMatchObject([{ ready: ['claude'] }, { ok: true }]);
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
    const MAC_PANES = osFor('darwin').permissionPanes!;
    expect(['win32', 'linux'].map(p => osFor(p).permissionPanes)).toEqual([undefined, undefined]);
    expect(await failing('darwin')).toEqual(['consent', 'mac']);
    expect(await failing('win32')).toEqual(['consent']);              // only a Mac asks
    expect(await fix('mac', run, 'darwin')).toBe(true);
    expect(ran).toContain('clawdcursor grant');
    expect(await fix('mac', run, 'win32')).toBe(false);
    expect(await macNeeds(MAC_PANES, run)).toEqual({ ok: false, pane: MAC_PANES.accessibility });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Not granted';
    expect(await macNeeds(MAC_PANES, run)).toEqual({ ok: false, pane: MAC_PANES.screenRecording });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Granted';
    expect(await macNeeds(MAC_PANES, run)).toEqual({ ok: true });
    pc.mac = 'Accessibility: Granted\nScreen Recording: Could not check (optional)';
    expect(await macNeeds(MAC_PANES, run)).toEqual({ ok: true });                // the card clears
    expect(MAC_PANES.accessibility).toMatch(/^x-apple\.systempreferences:.*Privacy_Accessibility$/);
    expect(MAC_PANES.screenRecording).toMatch(/^x-apple\.systempreferences:.*Privacy_ScreenCapture$/);
  });
});
