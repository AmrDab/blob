// Agent Reach on first need: nothing is installed without a Yes to a card that shows the commands. A fake shell.
import { describe, expect, it } from 'vitest';
import { MAX_DETAIL } from '../src/ask.ts';
import { outcomeOf } from '../src/brain.ts';
import { osFor } from '../src/os/index.ts';
import { REACH_QUESTION, REACH_ZIP, reachTools } from '../src/reach.ts';
import type { ExecResult } from '../src/shell.ts';

const INSTALL = `uv tool install ${REACH_ZIP}`;
const done: ExecResult = { code: 0, out: '{"ok": true}', timedOut: false };
const missing: ExecResult = { code: 1, out: 'not found', timedOut: false };

function setup(o: { have?: string[]; yes?: boolean; fail?: Record<string, ExecResult | Error> } = {}) {
  const ran: string[] = [], asked: [string, string | undefined][] = [];
  const t = reachTools({
    uvInstall: 'install-uv',
    ask: async (q, detail) => { asked.push([q, detail]); return o.yes ?? false; },
    exec: async command => {
      ran.push(command);
      const f = o.fail?.[command];
      if (f instanceof Error) throw f;
      if (f) return f;
      if (command === 'agent-reach version') return o.have?.includes('agent-reach') ? done : missing;
      if (command === 'uv --version') return o.have?.includes('uv') ? done : missing;
      return done;
    },
  });
  return { t, ran, asked };
}
const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;

describe('reach_install', () => {
  it('says so when it is installed already, and asks nothing', async () => {
    const { t, ran, asked } = setup({ have: ['agent-reach'] });
    const r = await t.reach_install();
    expect(r).toMatchObject({ isError: false });
    expect(r.text).toMatch(/^It is installed already\. With the files tool run: agent-reach read <url>/);
    expect(ran).toEqual(['agent-reach version']);
    expect(asked).toEqual([]);
  });

  it('asks in plain words with the exact commands under it, and installs nothing on No', async () => {
    const { t, ran, asked } = setup();
    const r = await t.reach_install();
    expect(r.text).toMatch(/^\[refused · USER_SAID_NO · [^]*nothing was installed/);
    expect(asked).toEqual([[REACH_QUESTION, `install-uv\n${INSTALL}\nagent-reach setup\n\nIt also adds its usage note to the skills folders of the AI tools on this computer.`]]);
    expect(REACH_QUESTION).toMatch(/free add-on[^]*Reddit, YouTube transcripts, X[^]*only reads[^]*never signs in/);
    expect(REACH_QUESTION).not.toMatch(/clawdcursor|agent-reach|uv\b|terminal/i);
    expect(ran).toEqual(['agent-reach version', 'uv --version']);              // two looks, no install
  });

  it('on Yes installs uv when it is missing, then the tool from its GitHub release, then sets it up', async () => {
    const { t, ran } = setup({ yes: true });
    const r = await t.reach_install();
    expect(outcome(r)).toBe('confirmed');
    expect(r.text).toMatch(/^Installed\. With the files tool run: agent-reach read <url>, or agent-reach <site> search/);
    expect(ran).toEqual(['agent-reach version', 'uv --version', 'install-uv', INSTALL, 'agent-reach setup']);
    expect(INSTALL).toContain('https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip');   // never PyPI
    expect(ran.join(' ')).not.toMatch(/login|pip |pipx/);
  });

  it('skips uv when it is there, on the card and in the run', async () => {
    const { t, ran, asked } = setup({ yes: true, have: ['uv'] });
    expect(outcome(await t.reach_install())).toBe('confirmed');
    expect(asked[0][1]).toMatch(new RegExp(`^uv tool install \\S+\nagent-reach setup\n`));
    expect(ran).toEqual(['agent-reach version', 'uv --version', INSTALL, 'agent-reach setup']);
  });

  it('stops at the step that failed and says why, with no terminal for the user', async () => {
    const bad = setup({ yes: true, fail: { [INSTALL]: { code: 2, out: 'x'.repeat(500) + ' no network', timedOut: false } } });
    const r = await bad.t.reach_install();
    expect(r.text).toMatch(/^\[failed · INSTALL · hint: "uv tool install [^"]+" did not work: x+ no network\. [^]*do not send them to a terminal\]$/);
    expect(r.text.length).toBeLessThan(600);
    expect(bad.ran).not.toContain('agent-reach setup');
    const slow = setup({ yes: true, fail: { 'install-uv': { code: null, out: '', timedOut: true } } });
    expect((await slow.t.reach_install()).text).toMatch(/"install-uv" did not work: it took too long/);
    const thrown = setup({ yes: true, have: ['uv'], fail: { 'agent-reach setup': new Error('spawn failed') } });
    expect((await thrown.t.reach_install()).text).toMatch(/"agent-reach setup" did not work: spawn failed/);
    // a shell that can't start at all counts as not installed
    const none = setup({ fail: { 'agent-reach version': new Error('no shell'), 'uv --version': new Error('no shell') } });
    expect(outcome(await none.t.reach_install())).toBe('refused');
  });

  it("each system's card, with its own uv installer, fits under the detail limit", async () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const asked: (string | undefined)[] = [];
      await reachTools({ uvInstall: osFor(platform).uvInstall, ask: async (_q, d) => { asked.push(d); return false; }, exec: async () => missing }).reach_install();
      expect(asked[0]!.length, platform).toBeLessThanOrEqual(MAX_DETAIL);
      expect(asked[0], platform).toContain(platform === 'win32' ? 'irm https://astral.sh/uv/install.ps1 | iex' : 'curl -LsSf https://astral.sh/uv/install.sh | sh');
    }
  });
});
