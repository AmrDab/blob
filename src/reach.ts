// Agent Reach (github.com/Panniantong/Agent-Reach, MIT), installed the first time it is needed (on the self server):
// a read-only command-line tool for the sites the web tools can't read (Reddit, YouTube transcripts, X, LinkedIn).
// Blob asks on a Yes card that shows the commands, then runs them itself: the user never opens a terminal, and
// nothing here signs in anywhere. Always from the project's GitHub release: the PyPI package of that name is
// another project.
import type { ToolResult } from './files-mcp.ts';
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
  return {
    async reach_install(): Promise<ToolResult> {
      if (await works('agent-reach version')) return { text: `It is installed already. ${USE}`, isError: false };
      const steps = [...(await works('uv --version') ? [] : [d.uvInstall]), `uv tool install ${REACH_ZIP}`, 'agent-reach setup'];
      // setup also puts its usage note where the AI tools on this computer read skills: said on the card
      const detail = `${steps.join('\n')}\n\nIt also adds its usage note to the skills folders of the AI tools on this computer.`;
      if (!(await d.ask(REACH_QUESTION, detail))) {
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
      return { text: `Installed. ${USE}\n[confirmed]`, isError: false };
    },
  };
}
