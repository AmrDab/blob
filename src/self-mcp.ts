// Blob's self server (stdio MCP, named "blob"): how the model learns what Blob is, changes Blob's own settings, and
// keeps its memory, reminders and schedules. A change asks the user first on the bubble, with words written here
// (never the model's), and happens only on Yes. Two things need no Yes, because the user asked for them and they
// stay on this computer: remembering a fact and setting a reminder.
// Claude Code starts it from the --mcp-config Blob writes, like the files server.
import { ASK_TIMEOUT_MS, MAX_DETAIL, askUser } from './ask.ts';
import type { ToolResult } from './files-mcp.ts';
import { frequentTasks, habitsFile } from './habits.ts';
import { SECRET, facts, forget, matching, memoryBrief, memoryFile, remember } from './memory.ts';
import { persona } from './persona.ts';
import { MAX_TEXT, addEntry, describe, loadSchedule, nextDue, parseWhen, removeEntry, scheduleFile, stamp } from './schedule.ts';
import { CHANGEABLE, DEFAULTS, MODELS, SettingsStore, WHAT, parseValue, type Key, type Settings } from './settings.ts';
import { activityFile, forgetActivity, topActivity } from './watch.ts';

/** What only the host can do. The host answers with a line for the model. */
export type HostAction = 'save_shortcut' | 'pair' | 'unpair';
export type Host = (action: HostAction, body?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

export interface SelfDeps {
  settings: { get(): Settings; set<K extends Key>(key: K, value: Settings[K]): void };
  /** `detail`: text shown under the question as it is (a task's words, the facts to forget). */
  ask: (question: string, detail?: string) => Promise<boolean>;
  host: Host;
  /** Whether a phone relay is set up (BLOB_RELAY). Without one, pairing is not offered. */
  relay: boolean;
  activityFile: string;
  habitsFile: string;
  memoryFile: string;
  scheduleFile: string;
  now?: () => number;
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
      ? 'Start watching to learn your habits? I note the app, window title and website in front. No screenshots. The notes stay on this computer; I ask before my AI sees which apps and sites you use most.'
      : 'Stop watching?';
  }
  if (key === 'autoShortcuts') return value ? 'Make shortcuts for things you do often?' : 'Stop making shortcuts by myself?';
  if (key === 'startAtLogin') return value ? 'Start Blob when you sign in?' : 'Stop starting Blob when you sign in?';
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
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS + 10_000),   // the host may ask the user first
    });
    if (!res.ok) return down;
    const r = await res.json() as { ok?: unknown; text?: unknown };
    return { ok: r.ok === true, text: typeof r.text === 'string' ? r.text : '' };
  } catch { return down; }
};

export function selfTools(d: SelfDeps) {
  const now = () => (d.now ?? Date.now)();
  const viaHost = async (action: HostAction, body?: Record<string, unknown>): Promise<ToolResult> => {
    const r = await d.host(action, body);
    return r.ok ? ok(r.text || 'Done.') : failed('HOST', r.text || 'Blob did not do it');
  };
  return {
    about(): ToolResult {
      const s = d.settings.get();
      const lines = (Object.keys(DEFAULTS) as Key[]).map(k => `- ${k} = ${String(s[k])}: ${WHAT[k]}`);
      return { text: `${persona(s, { memory: memoryBrief(d.memoryFile) })}\n\nSettings (the user can change ${CHANGEABLE.join(', ')}):\n${lines.join('\n')}`, isError: false };
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

    /**
     * The tasks the user asked Blob for come back as they are. The apps and sites noted while watching are the
     * user's own doings: nothing of them with watching off, and with it on only after a Yes, asked every time.
     */
    async habits(): Promise<ToolResult> {
      const list = (x: string[]) => (x.length ? x.join(', ') : 'nothing noted yet');
      const tasks = `Tasks asked for more than once: ${list(frequentTasks(d.habitsFile))}`;
      if (!d.settings.get().watching) return { text: `Watching is off: no apps or sites to tell.\n${tasks}`, isError: false };
      if (!(await d.ask("Share what you use most with Blob's AI?"))) {
        return { text: `Watching is on, but the user did not share the apps and sites this time. Do not ask again for this request.\n${tasks}`, isError: false };
      }
      const { apps, sites } = topActivity(d.activityFile);
      return { text: `Watching is on. Last 14 days, most often in front:\nApps: ${list(apps)}\nSites: ${list(sites)}\n${tasks}`, isError: false };
    },

    async forget_watching(): Promise<ToolResult> {
      if (!(await d.ask('Forget everything I noted while watching? It can\'t be brought back.'))) return NO();
      try { forgetActivity(d.activityFile); } catch (e) { return failed('CANT_DELETE', (e as Error).message); }
      return ok(`Forgot it.${d.settings.get().watching ? ' Watching is still on.' : ''}`);
    },

    /** The host asks the user first, with the request's own words and the steps: never a name from the model. */
    save_last_as_shortcut(): Promise<ToolResult> { return viaHost('save_shortcut'); },

    /** A paired phone can ask Blob for anything, so the user says Yes before the QR shows; then they scan it. */
    async pair_phone(): Promise<ToolResult> {
      if (!d.relay) return failed('NOT_SET_UP', "phone pairing isn't set up yet on this computer. Tell the user so, plainly");
      if (!(await d.ask('Pair a phone with Blob?'))) return NO();
      return viaHost('pair');
    },

    async unpair_phone(): Promise<ToolResult> {
      if (!d.settings.get().phonePaired) return ok('No phone is paired.');
      if (!(await d.ask('Unpair your phone?'))) return NO();
      return viaHost('unpair');
    },

    // ── memory (memory.ts) ──
    /** Asked first, with the fact shown: whatever is saved goes into every later request, so a page that tricked the
     *  AI must not be able to plant it. */
    async remember(a: { fact?: unknown }): Promise<ToolResult> {
      const fact = typeof a.fact === 'string' ? a.fact.trim() : '';
      if (fact && facts(d.memoryFile).some(f => f.toLowerCase() === fact.toLowerCase())) return ok('That is remembered already.');
      if (fact && !SECRET.test(fact) && !(await d.ask('Remember this?', fact))) return NO();   // a secret is refused below, unasked
      let r;
      try { r = remember(d.memoryFile, a.fact); } catch (e) { return failed('CANT_SAVE', (e as Error).message); }
      if (r === 'empty') return failed('NO_FACT', 'pass the fact to remember, one short sentence');
      if (r === 'secret') return refused('SECRET', 'Blob does not keep passwords, codes or keys; tell the user so');
      if (r === 'full') return failed('FULL', 'the memory file is full; ask the user what to forget');
      return ok(r === 'known' ? 'That is remembered already.' : 'Remembered.');
    },

    recall(): ToolResult {
      const all = facts(d.memoryFile);
      return { text: all.length ? `${all.map(f => `- ${f}`).join('\n')}\n(file: ${d.memoryFile})` : `Nothing is remembered yet. (file: ${d.memoryFile})`, isError: false };
    },

    async forget(a: { text?: unknown }): Promise<ToolResult> {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!text) return failed('NO_TEXT', 'pass some words of the fact to forget');
      const hits = matching(d.memoryFile, text);
      if (!hits.length) return ok('Nothing remembered matches that.');
      const list = hits.map(f => `- ${f}`).join('\n');
      if (list.length > MAX_DETAIL) return failed('TOO_MANY', `${hits.length} facts match; pass more exact words`);
      if (!(await d.ask(hits.length === 1 ? 'Forget this?' : `Forget these ${hits.length}?`, list))) return NO();
      try { forget(d.memoryFile, hits); } catch (e) { return failed('CANT_SAVE', (e as Error).message); }
      return ok(`Forgot ${hits.length === 1 ? 'it' : `${hits.length} facts`}.`);
    },

    // ── reminders and scheduled tasks (schedule.ts) ──
    /** A reminder only shows its text, so it needs no question. A task runs by itself later: the user says Yes to its words and its time. */
    async schedule_add(a: { kind?: unknown; text?: unknown; when?: unknown }): Promise<ToolResult> {
      if (a.kind !== 'remind' && a.kind !== 'task') return failed('BAD_KIND', 'kind is "remind" or "task"');
      const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return failed('NO_TEXT', a.kind === 'task' ? 'pass the request to run' : 'pass what to remind the user of');
      if (text.length > MAX_TEXT) return failed('TOO_LONG', `the text is at most ${MAX_TEXT} characters`);
      const when = parseWhen(a.when);
      if (typeof when === 'string') return failed('BAD_WHEN', `${when}; it is ${stamp(now())} now`);
      if (a.kind === 'task' && !(await d.ask(`Run this by itself, ${describe(when)}?`, text))) return NO();
      let e;
      try { e = addEntry(d.scheduleFile, a.kind, text, when, now()); } catch (err) { return failed('CANT_SAVE', (err as Error).message); }
      if (typeof e === 'string') return failed('CANT_ADD', e);
      const open = d.settings.get().startAtLogin ? '' : ' It fires only while Blob is open, and Blob does not start at sign-in now.';
      return ok(`${a.kind === 'task' ? 'Task' : 'Reminder'} ${e.id} is set: ${describe(when)}.${open}`);
    },

    schedule_list(): ToolResult {
      const all = loadSchedule(d.scheduleFile);
      if (!all.length) return { text: 'Nothing is scheduled.', isError: false };
      const line = (e: typeof all[number]) => {
        const next = nextDue(e, now());
        return `${e.id} · ${e.kind} · ${describe(e.when)}${next === null ? '' : ` · next ${stamp(next)}`} · ${e.text}`;
      };
      return { text: all.map(line).join('\n'), isError: false };
    },

    async schedule_remove(a: { id?: unknown }): Promise<ToolResult> {
      const id = String(a.id ?? '').trim();
      const e = loadSchedule(d.scheduleFile).find(x => x.id === id);
      if (!e) return failed('NOT_FOUND', 'no entry has that id; schedule_list shows them');
      if (!(await d.ask(`Remove this ${e.kind === 'task' ? 'task' : 'reminder'}, ${describe(e.when)}?`, e.text))) return NO();
      try { removeEntry(d.scheduleFile, id); } catch (err) { return failed('CANT_SAVE', (err as Error).message); }
      return ok('Removed.');
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
    ask: (q, detail) => askUser(q, { detail }),
    host: hostCall,
    relay: !!process.env.BLOB_RELAY,
    activityFile: activityFile(),
    habitsFile: habitsFile(),
    memoryFile: memoryFile(),
    scheduleFile: scheduleFile(),
  });
  const server = new McpServer({ name: 'blob', version: '0.1.0' });
  const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });
  const read = { readOnlyHint: true };
  server.registerTool('about', {
    description: 'What Blob can do, its settings now, and what each one does.', inputSchema: {}, annotations: read,
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
    description: 'A short summary of what Blob has learned on this computer: tasks asked for more than once and, ' +
      'when watching is on and the user says Yes to sharing it this time, the apps and sites most often in front. ' +
      'Use it when the user asks about it or when it helps their request.',
    inputSchema: {}, annotations: read,
  }, async () => reply(await tools.habits()));
  server.registerTool('forget_watching', {
    description: 'Delete everything Blob noted while watching. The user is asked first. It does not turn watching off.',
    inputSchema: {}, annotations: { destructiveHint: true },
  }, async () => reply(await tools.forget_watching()));
  server.registerTool('save_last_as_shortcut', {
    description: 'Save the last finished task as a shortcut on the bubble ("save that as a shortcut"). The user is asked first.',
    inputSchema: {},
  }, async () => reply(await tools.save_last_as_shortcut()));
  server.registerTool('pair_phone', {
    description: 'Show the QR code that pairs the user\'s phone with Blob. The user is asked first.', inputSchema: {},
  }, async () => reply(await tools.pair_phone()));
  server.registerTool('unpair_phone', {
    description: 'Unpair the phone. The user is asked first.', inputSchema: {},
  }, async () => reply(await tools.unpair_phone()));
  server.registerTool('remember', {
    description: 'Save one short fact in Blob\'s memory file on this computer: something the user asked to be ' +
      'remembered, or a lasting preference. Never a password, code or key. The user is asked first.',
    inputSchema: { fact: z.string().describe('One short sentence, e.g. "Uses Outlook for mail."') },
  }, async a => reply(await tools.remember(a)));
  server.registerTool('recall', {
    description: 'Everything in Blob\'s memory file, and where the file is.', inputSchema: {}, annotations: read,
  }, async () => reply(tools.recall()));
  server.registerTool('forget', {
    description: 'Remove the remembered facts that contain these words. The user is shown them and asked first.',
    inputSchema: { text: z.string().describe('Words from the fact to forget.') }, annotations: { destructiveHint: true },
  }, async a => reply(await tools.forget(a)));
  server.registerTool('schedule_add', {
    description: 'Set a reminder (kind "remind": the text is shown at that time, no question) or a scheduled task ' +
      '(kind "task": the text is run as a request at that time; the user is asked Yes first). Local time.',
    inputSchema: {
      kind: z.enum(['remind', 'task']),
      text: z.string().describe('remind: what to show. task: the request to run, as the user would say it.'),
      when: z.object({
        repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'every']),
        at: z.string().optional().describe('once: "YYYY-MM-DD HH:MM"'),
        time: z.string().optional().describe('daily, weekdays, weekly: "HH:MM", 24-hour'),
        weekday: z.string().optional().describe('weekly: sun, mon, tue, wed, thu, fri or sat'),
        minutes: z.number().optional().describe('every: how many minutes apart'),
      }),
    },
  }, async a => reply(await tools.schedule_add(a)));
  server.registerTool('schedule_list', {
    description: 'The reminders and scheduled tasks: id, kind, when, the next time, and the text.', inputSchema: {}, annotations: read,
  }, async () => reply(tools.schedule_list()));
  server.registerTool('schedule_remove', {
    description: 'Remove a reminder or scheduled task by its id. The user is asked first.',
    inputSchema: { id: z.string() }, annotations: { destructiveHint: true },
  }, async a => reply(await tools.schedule_remove(a)));
  await server.connect(new StdioServerTransport());
}
