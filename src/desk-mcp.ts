// Blob's desk server (stdio MCP, named "desk"): read, act and open, for working an open window in the background.
// It only passes each call on to Blob's main process, where the one bridge and the control ids live (desk.ts), so
// they are the same for every model of a request. Claude Code starts it from the --mcp-config Blob writes.
import type { ToolResult } from './files-mcp.ts';

const NOT_STARTED: ToolResult = { text: "[failed · BRIDGE · hint: Blob didn't start this server; use the screen tools]", isError: true };
const TOO_LONG: ToolResult = { text: '[unverified · hint: no answer in time; the steps may still be running: read the window before doing anything again]', isError: false };

/** One call, sent to Blob's local server (BLOB_DESK_URL, BLOB_DESK_TOKEN). Its text comes back as it is. */
export async function forward(tool: string, args: unknown, o: { url?: string; token?: string; fetch?: typeof fetch } = {}): Promise<ToolResult> {
  const url = o.url ?? process.env.BLOB_DESK_URL, token = o.token ?? process.env.BLOB_DESK_TOKEN;
  if (!url || !token) return NOT_STARTED;
  try {
    const res = await (o.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-desk-token': token },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(960_000),          // 10 steps, each up to 60 s on the user's Yes and 30 s in the bridge
    });
    if (!res.ok) return NOT_STARTED;
    const body = await res.json() as { text?: unknown; isError?: unknown };
    return { text: String(body.text ?? ''), isError: body.isError === true };
  } catch (e) { return (e as Error)?.name === 'TimeoutError' ? TOO_LONG : NOT_STARTED; }
}

export async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'blob-desk', version: '0.1.0' });
  const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });
  server.registerTool('read', {
    description: 'With no arguments, list the open windows; with window or app, show that window\'s controls, each with an id and what it can do; with element, give that control\'s whole text.',
    inputSchema: {
      window: z.string().optional().describe('A window id from the list, like w263412.'),
      app: z.string().optional().describe('Part of an app\'s name or a window\'s title.'),
      find: z.string().optional().describe('Only the controls whose name contains this.'),
      element: z.string().optional().describe('A control id, like e12: its whole text.'),
    },
    annotations: { readOnlyHint: true },
  }, async a => reply(await forward('read', a)));
  server.registerTool('act', {
    description: 'Press, set, toggle, select, expand or collapse controls by their ids, in order and without taking the screen, and say what changed; it stops at the first step that does not confirm.',
    inputSchema: {
      steps: z.array(z.object({
        element: z.string().describe('A control id from read, like e7.'),
        action: z.enum(['press', 'set', 'toggle', 'select', 'expand', 'collapse']),
        value: z.string().optional().describe('For set: the new text or number.'),
        consequential: z.boolean().optional().describe('True for a step that sends, deletes, pays, posts, installs or cannot be undone: the user is asked first.'),
      })).min(1).max(10),
    },
  }, async a => reply(await forward('act', a)));
  server.registerTool('open', {
    description: 'Start an app from the Start menu by its name, and give back its window.',
    inputSchema: { app: z.string().describe('The app\'s name, like Calculator.') },
  }, async a => reply(await forward('open', a)));
  await server.connect(new StdioServerTransport());
}
