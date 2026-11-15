// Blob's self server (stdio MCP, named "blob"): how the model learns what Blob is and changes Blob's own settings.
// Every change asks the user first on the bubble, with words written here (never the model's), and happens only on Yes.
// Claude Code starts it from the --mcp-config Blob writes, like the files server.
import { askUser } from './ask.ts';
import type { ToolResult } from './files-mcp.ts';
import { frequentTasks, habitsFile } from './habits.ts';
import { persona } from './persona.ts';
import { CHANGEABLE, DEFAULTS, MODELS, SettingsStore, WHAT, parseValue, type Key, type Settings } from './settings.ts';
import { activityFile, forgetActivity, topActivity } from './watch.ts';

/** What only the host can do. The host answers with a line for the model. */
export type HostAction = 'save_shortcut' | 'pair' | 'unpair';
export type Host = (action: HostAction, body?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

export interface SelfDeps {
  settings: { get(): Settings; set<K extends Key>(key: K, value: Settings[K]): void };
  ask: (question: string) => Promise<boolean>;
  host: Host;
  activityFile: string;
  habitsFile: string;
}

const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });
const NO = () => refused('USER_SAID_NO', 'the user said No (or did not answer); nothing changed. Tell them so, and do not ask again');

/** The card's question for a change. */
export function question(key: typeof CHANGEABLE[number], value: Settings[Key]): string {
  if (key === 'model') return value === 'default' ? "Switch to Claude Code's default model?" : `Switch to ${String(value)[0].toUpperCase()}${String(value).slice(1)}?`;
  if (key === 'watching') {
    return value
      ? 'Start watching to learn your habits? I note the app, window title and website in front. No screenshots, and it stays on this computer.'
      : 'Stop watching?';
  }
  if (key === 'autoShortcuts') return value ? 'Make shortcuts for things you do often?' : 'Stop making shortcuts by myself?';
  return value ? 'Turn voice on?' : 'Turn voice off?';
}

/** Asks Blob's host over its local server (BLOB_SELF_URL, BLOB_SELF_TOKEN), as ask.ts does for questions. */
export const hostCall: Host = async (action, body = {}) => {
  const url = process.env.BLOB_SELF_URL, token = process.env.BLOB_SELF_TOKEN;
  const down = { ok: false, text: 'Blob could not be reached' };
  if (!url || !token) return down;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-self-token': token },
      body: JSON.stringify({ ...body, action }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return down;
    const r = await res.json() as { ok?: unknown; text?: unknown };
    return { ok: r.ok === true, text: typeof r.text === 'string' ? r.text : '' };
  } catch { return down; }
};

export function selfTools(d: SelfDeps) {
  const viaHost = async (action: HostAction, body?: Record<string, unknown>): Promise<ToolResult> => {
    const r = await d.host(action, body);
    return r.ok ? ok(r.text || 'Done.') : failed('HOST', r.text || 'Blob did not do it');
  };
  return {
    about(): ToolResult {
      const s = d.settings.get();
      const lines = (Object.keys(DEFAULTS) as Key[]).map(k => `- ${k} = ${String(s[k])}: ${WHAT[k]}`);
      return { text: `${persona(s)}\n\nSettings (the user can change ${CHANGEABLE.join(', ')}):\n${lines.join('\n')}`, isError: false };
    },

    get_settings(): ToolResult {
      return { text: JSON.stringify(d.settings.get()), isError: false };
    },

    async change_setting(a: { key?: unknown; value?: unknown }): Promise<ToolResult> {
      const key = String(a.key ?? '') as Key;
      if (!Object.hasOwn(DEFAULTS, key)) return failed('UNKNOWN_KEY', `the settings are ${CHANGEABLE.join(', ')}`);
      if (!(CHANGEABLE as readonly string[]).includes(key)) return refused('READ_ONLY', `${key} is a status, not something to change`);
      const value = parseValue(key, a.value);
      if (value === undefined) return failed('BAD_VALUE', key === 'model' ? `model is one of ${MODELS.join(', ')}` : `${key} is true or false`);
      if (d.settings.get()[key] === value) return ok(`${key} is already ${String(value)}. Nothing to change.`);
      if (!(await d.ask(question(key as typeof CHANGEABLE[number], value)))) return NO();
      try { d.settings.set(key, value); } catch (e) { return failed('CANT_SAVE', (e as Error).message); }
      return ok(`${key} is now ${String(value)}.${key === 'model' ? ' It applies from the next request, not this one.' : ''}`);
    },

    habits(): ToolResult {
      const s = d.settings.get();
      const { apps, sites } = topActivity(d.activityFile);
      const tasks = frequentTasks(d.habitsFile);
      const list = (x: string[]) => (x.length ? x.join(', ') : 'nothing noted yet');
      return {
        text: `Watching is ${s.watching ? 'on' : 'off'}. Last 14 days, most often in front:\n` +
          `Apps: ${list(apps)}\nSites: ${list(sites)}\nTasks asked for more than once: ${list(tasks)}`,
        isError: false,
      };
    },

    async forget_watching(): Promise<ToolResult> {
      if (!(await d.ask('Forget everything I noted while watching? It can\'t be brought back.'))) return NO();
      try { forgetActivity(d.activityFile); } catch (e) { return failed('CANT_DELETE', (e as Error).message); }
      return ok(`Forgot it.${d.settings.get().watching ? ' Watching is still on.' : ''}`);
    },

    save_last_as_shortcut(a: { name?: unknown }): Promise<ToolResult> {
      const name = typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '';
      return viaHost('save_shortcut', name ? { name } : {});
    },

    /** The QR is the question: nothing is paired until the user scans it. */
    pair_phone(): Promise<ToolResult> { return viaHost('pair'); },

    async unpair_phone(): Promise<ToolResult> {
      if (!d.settings.get().phonePaired) return ok('No phone is paired.');
      if (!(await d.ask('Unpair your phone?'))) return NO();
      return viaHost('unpair');
    },
  };
}

// ── the MCP server ───────────────────────────────────────────────────────────

export async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const store = new SettingsStore();
  const tools = selfTools({
    settings: { get: () => { store.reload(); return store.get(); }, set: (k, v) => store.set(k, v) },   // the host writes the file too
    ask: q => askUser(q),
    host: hostCall,
    activityFile: activityFile(),
    habitsFile: habitsFile(),
  });
  const server = new McpServer({ name: 'blob', version: '0.1.0' });
  const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });
  const read = { readOnlyHint: true };
  server.registerTool('about', {
    description: 'What Blob is, its settings now, and what each one does.', inputSchema: {}, annotations: read,
  }, async () => reply(tools.about()));
  server.registerTool('get_settings', {
    description: 'Blob\'s settings now, as JSON.', inputSchema: {}, annotations: read,
  }, async () => reply(tools.get_settings()));
  server.registerTool('change_setting', {
    description: `Change one of Blob's settings (${CHANGEABLE.join(', ')}) when the user asks for it. The user is ` +
      'always asked Yes or No first; it changes only on Yes. A model change applies from the next request.',
    inputSchema: {
      key: z.string().describe(CHANGEABLE.join(' | ')),
      value: z.union([z.string(), z.boolean()]).describe(`model: ${MODELS.join(' | ')}; the others: true or false`),
      reason: z.string().optional().describe('What the user asked for, in a few words.'),
    },
  }, async a => reply(await tools.change_setting(a)));
  server.registerTool('habits', {
    description: 'A short summary of what Blob has learned on this computer: the apps and sites most often in front, ' +
      'and tasks asked for more than once. Use it when the user asks about it or when it helps their request.',
    inputSchema: {}, annotations: read,
  }, async () => reply(tools.habits()));
  server.registerTool('forget_watching', {
    description: 'Delete everything Blob noted while watching. The user is asked first. It does not turn watching off.',
    inputSchema: {}, annotations: { destructiveHint: true },
  }, async () => reply(await tools.forget_watching()));
  server.registerTool('save_last_as_shortcut', {
    description: 'Save the last finished task as a shortcut on the bubble ("save that as a shortcut").',
    inputSchema: { name: z.string().optional().describe('A short name; left out, the request\'s own words are used.') },
  }, async a => reply(await tools.save_last_as_shortcut(a)));
  server.registerTool('pair_phone', {
    description: 'Show the QR code that pairs the user\'s phone with Blob.', inputSchema: {},
  }, async () => reply(await tools.pair_phone()));
  server.registerTool('unpair_phone', {
    description: 'Unpair the phone. The user is asked first.', inputSchema: {},
  }, async () => reply(await tools.unpair_phone()));
  await server.connect(new StdioServerTransport());
}
