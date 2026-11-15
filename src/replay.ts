// Replays a shortcut: Pronto itself is the MCP client (clawdcursor, and the files server when a step needs it),
// calling the saved steps in order with no model, and stopping at the first one that doesn't confirm.
import { outcomeOf, callLabel, cleanEnv, clawdcursorCommand, type ServerCommand } from './brain.ts';
import type { Step } from './shortcuts.ts';

export type Caller = (step: Step) => Promise<{ text: string; isError: boolean }>;
export interface StepResult { tool: string; action?: string; outcome: string; line: string }
export type ReplayEnd = { ok: true } | { ok: false; at: number; line: string };

/** "ok" is a read that has no outcome line (it can't confirm, and it didn't fail). Anything else stops the replay. */
const GOOD = new Set(['confirmed', 'ok']);

export async function replay(steps: Step[], call: Caller, on: {
  start?: (i: number, step: Step) => void;
  result?: (i: number, r: StepResult) => void;
} = {}): Promise<ReplayEnd> {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    on.start?.(i, s);
    let r: { outcome: string; line: string };
    try {
      const res = await call(s);
      r = outcomeOf(res.text, res.isError);
    } catch (e) {
      r = { outcome: 'failed', line: `[failed · CALL_FAILED · hint: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)}]` };
    }
    on.result?.(i, { ...callLabel(s.server, s.tool, s.args), ...r });
    if (!GOOD.has(r.outcome)) return { ok: false, at: i, line: r.line };
  }
  return { ok: true };
}

/** MCP clients started on first use, one per server, closed together. */
export function mcpCaller(files: ServerCommand): { call: Caller; close: () => Promise<void> } {
  const clients = new Map<Step['server'], Promise<import('@modelcontextprotocol/sdk/client/index.js').Client>>();
  const connect = async (server: Step['server']) => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const cmd: ServerCommand = server === 'clawdcursor' ? clawdcursorCommand() : files;
    const env = Object.fromEntries(Object.entries(cleanEnv()).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const client = new Client({ name: 'pronto', version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: cmd.command, args: cmd.args, env: { ...env, ...cmd.env }, stderr: 'ignore' }));
    return client;
  };
  return {
    async call(step) {
      let c = clients.get(step.server);
      if (!c) { c = connect(step.server); clients.set(step.server, c); }
      // A trash or overwrite waits up to 60 s for the user's answer: allow more than the SDK's 60 s default.
      const res = await (await c).callTool({ name: step.tool, arguments: step.args }, undefined, { timeout: 120_000 });
      const content = Array.isArray(res.content) ? res.content : [];
      const text = content.map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
      return { text, isError: res.isError === true };
    },
    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(all.map(p => p.then(c => c.close()).catch(() => {})));
    },
  };
}
