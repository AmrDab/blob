// Agent Reach (github.com/Panniantong/Agent-Reach, MIT), installed the first time it is needed (on the self server):
// a read-only command-line tool for the sites the web tools can't read (Reddit, YouTube transcripts, X, LinkedIn).
// Blob asks on a Yes card that shows the commands, then runs them itself: the user never opens a terminal, and
// nothing here signs in anywhere. Always from the project's GitHub release: the PyPI package of that name is
// another project.
import { basename, dirname } from 'node:path';
import type { ToolResult } from './files-mcp.ts';
import { HIDDEN } from './safe.ts';
import type { Exec } from './shell.ts';

export const REACH_ZIP = 'https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip';
const CHECK_MS = 30_000, INSTALL_MS = 600_000;

export interface ReachDeps {
  /** `detail`: the commands, shown as they will run. */
  ask: (question: string, detail?: string) => Promise<boolean>;
  exec: Exec;
  /** The command that installs uv, the installer Agent Reach needs (os.uvInstall). */
  uvInstall: string;
}

export const REACH_QUESTION = 'Install a free add-on so Blob can read Reddit, YouTube transcripts, X and similar sites? It only reads, and never signs in.';
const USE = 'With the files tool run: agent-reach read <url>, or agent-reach <site> search "words" (agent-reach channels lists ' +
  'the sites and what each can do). Each prints one JSON object: {ok, result} or {ok: false, error: {code, hint}}.';

export function reachTools(d: ReachDeps) {
  const works = async (command: string) => {
    try { const r = await d.exec(command, CHECK_MS); return r.code === 0 && !r.timedOut; } catch { return false; }
  };

  /**
   * Its setup links its usage note into the skills folder of every other AI tool it finds here (~/.claude/skills,
   * ~/.cursor/skills …). Blob takes those out again, with Agent Reach's own command, which also tells it to leave
   * that folder alone from then on. Its own copy (~/.agents/skills) stays. Returns the folders it could not clear.
   */
  async function unlink(): Promise<string[]> {
    let placed: string[];
    try {
      // `agent-reach skill` prints {ok, result: {links, copies}}: each is <skills folder>/agent-reach
      const out = (await d.exec('agent-reach skill', CHECK_MS)).out;
      const r = (JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { result: { links: unknown; copies: unknown } }).result;
      placed = [r.links, r.copies].flatMap(x => (Array.isArray(x) ? x : [])).filter(p => typeof p === 'string');
    } catch { return ['the skills folders of other AI tools (they could not be listed)']; }
    const left: string[] = [];
    for (const p of placed) {
      const dir = dirname(p);
      // the folder goes into a command in double quotes: one that could say more than a path is not run
      const fit = basename(p) === 'agent-reach' && !/["$`\r\n]/.test(p) && !HIDDEN.test(p);
      if (!fit || !(await works(`agent-reach skill unlink "${dir}"`))) left.push(dir);
    }
    return left;
  }

  return {
    async reach_install(): Promise<ToolResult> {
      if (await works('agent-reach version')) return { text: `It is installed already. ${USE}`, isError: false };
      const steps = [...(await works('uv --version') ? [] : [d.uvInstall]), `uv tool install ${REACH_ZIP}`, 'agent-reach setup'];
      if (!(await d.ask(REACH_QUESTION, steps.join('\n')))) {
        return { text: '[refused · USER_SAID_NO · hint: the user said No (or did not answer); nothing was installed. Do not ask again for this request, and do not install it another way]', isError: true };
      }
      for (const step of steps) {
        let why = '';
        try {
          const r = await d.exec(step, INSTALL_MS);
          if (r.timedOut) why = 'it took too long';
          else if (r.code !== 0) why = r.out.trim().slice(-300) || `it ended with error ${r.code}`;
        } catch (e) { why = (e as Error).message; }
        if (why) return { text: `[failed · INSTALL · hint: "${step}" did not work: ${why}. Tell the user it could not be installed; do not send them to a terminal]`, isError: true };
      }
      const left = await unlink();
      const note = left.length ? ` It is installed, but its usage note is still in: ${left.join(', ')}.` : '';
      return { text: `Installed. ${USE}${note}\n[confirmed]`, isError: false };
    },
  };
}
