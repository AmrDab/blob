// One run at a time of the user's own `claude -p` or `codex exec`, with clawdcursor, Blob's files and shell tools
// and its self tools.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BRAIN_NAME, type BrainName, type Model } from './settings.ts';

export type { Model };

export interface LogEntry {
  tool: string;       // "computer", "accessibility", ... (the mcp__clawdcursor__ prefix dropped)
  action?: string;    // the call's `action` argument, when it has one
  outcome: string;    // confirmed | unverified | refused | failed | ok | error
  line: string;       // clawdcursor's own outcome line, or the first line of the result
}

/** One finished tool call of a run, in order: what a shortcut is saved from. server '' = a Claude Code built-in. */
export interface Call {
  server: string;     // 'clawdcursor' | 'files' | 'blob' | '' ('codex': one of Codex's own MCP helpers)
  tool: string;       // the tool's own name: "accessibility", "move", "Read"
  args: Record<string, unknown>;
  outcome: string;
  line: string;
}

export type Update =
  | { type: 'caption'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'log'; entry: LogEntry }
  | { type: 'session'; id: string };

export type BrainEvent = Update | { type: 'busy'; busy: boolean } | { type: 'done'; calls: Call[]; ok: boolean };

/** Claude Code's read-only file tools; changes go through Blob's files server, which asks before trash/overwrite and before a command that changes something. */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep'];

export const SYSTEM_PROMPT =
  'The request comes from the user by voice or typing, through a small floating bubble on the desktop. Carry it out ' +
  'on this computer. Your final reply is shown as a one-line caption and may be read aloud: one short plain sentence ' +
  'saying what was done, or the information asked for. No markdown.';

/** Blob's relay (built by build.mjs): clawdcursor starts it in place of its own pill, and Blob draws the pill. */
export const PILL_HOST = fileURLToPath(new URL('../dist/pill-host.mjs', import.meta.url));
/** The env that hands clawdcursor's pill and its "waiting for you" card to Blob, once the host has set where the relay finds it. */
function pillEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env.BLOB_PILL_URL || !env.BLOB_PILL_TOKEN) return undefined;
  return {
    CLAWD_PILL_CMD: JSON.stringify([process.execPath, PILL_HOST]),
    CLAWD_OWN_UI_PIDS: String(process.pid),     // Blob's windows are clawdcursor's own UI, never a target
    // ...and so is what its web view draws in them, in processes of its own that come and go (own-ui.ts)
    ...(env.BLOB_OWN_UI_FILE && { CLAWD_OWN_UI_PIDS_FILE: env.BLOB_OWN_UI_FILE }),
    BLOB_PILL_URL: env.BLOB_PILL_URL, BLOB_PILL_TOKEN: env.BLOB_PILL_TOKEN,
  };
}
/** The clawdcursor MCP server command: `clawdcursor mcp --compact`, or BLOB_CLAWDCURSOR (e.g. a dev build). */
export function clawdcursorCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): ServerCommand {
  const raw = env.BLOB_CLAWDCURSOR?.trim() || 'clawdcursor mcp --compact';
  const parts = (raw.match(/"[^"]*"|\S+/g) ?? []).map(p => p.replace(/^"|"$/g, ''));
  const pill = pillEnv(env);
  // npm installs clawdcursor as a .cmd shim on Windows, which only cmd can start.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', ...parts], ...(pill && { env: pill }) };
  return { command: parts[0], args: parts.slice(1), ...(pill && { env: pill }) };
}

export interface ServerCommand { command: string; args: string[]; env?: Record<string, string> }

/** The servers every brain gets: clawdcursor, Blob's files server and Blob's self server ("blob"), nothing else. */
export function mcpServers(own: { files: ServerCommand; blob: ServerCommand }, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Record<string, ServerCommand> {
  return { clawdcursor: clawdcursorCommand(env, platform), files: own.files, blob: own.blob };
}

/** Claude Code's --mcp-config file. */
export function mcpConfig(own: { files: ServerCommand; blob: ServerCommand }, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const servers = Object.entries(mcpServers(own, env, platform)).map(([name, s]) => [name, { type: 'stdio', ...s }]);
  return JSON.stringify({ mcpServers: Object.fromEntries(servers) }, null, 2);
}

/** `persona`: what Blob knows about itself (persona.ts), as the settings are when the child starts. */
export function claudeArgs(o: { mcpConfigPath: string; model: Model; resume?: string; persona?: string }): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', o.mcpConfigPath,
    '--strict-mcp-config',                  // no other MCP server (not the user's own, not a plugin's)
    '--setting-sources', 'project',         // the cwd is an empty folder: none of the user's hooks, plugins or CLAUDE.md
    '--tools', BUILTIN_TOOLS.join(','),     // read-only built-ins only: no Bash, no Edit/Write (the shell is files `run`, which asks)
    '--allowedTools', ['mcp__clawdcursor__*', 'mcp__files__*', 'mcp__blob__*', ...BUILTIN_TOOLS].join(','),
    '--disable-slash-commands',
    '--no-chrome',
    '--append-system-prompt', o.persona ? `${SYSTEM_PROMPT}\n${o.persona}` : SYSTEM_PROMPT,
    ...(o.model === 'default' ? [] : ['--model', o.model]),
    ...(o.resume ? ['--resume', o.resume] : []),
  ];
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * How to start Codex with no shell in between (the brief and the servers' tokens are arguments). On Windows npm
 * installs it as codex.cmd, which only cmd can start: Blob runs the script that shim names with this same Node.
 */
export function codexCommand(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
  fs: { exists(p: string): boolean; read(p: string): string } = { exists: existsSync, read: p => readFileSync(p, 'utf8') }): ServerCommand {
  if (platform !== 'win32') return { command: 'codex', args: [] };
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const exe = join(dir, 'codex.exe'), cmd = join(dir, 'codex.cmd');
    if (fs.exists(exe)) return { command: exe, args: [] };
    if (!fs.exists(cmd)) continue;
    let js: string | undefined;
    try { js = fs.read(cmd).match(/"%dp0%\\([^"]+\.js)"/)?.[1]; } catch { /* unreadable: not this one */ }
    if (js) return { command: process.execPath, args: [join(dirname(cmd), js)] };
  }
  return { command: 'codex', args: [] };            // not found: starting it fails, and the first-run check says so
}

/**
 * Codex's own tools that are switched off, so Blob's servers are the only way to act: its shell (both kinds), image
 * reading, sub-agents, the account's apps and plugins, the user's hooks, its own browser and computer control, and
 * the small extras. A name this Codex does not know stops it at the start: it fails closed.
 */
export const CODEX_OFF = [
  'shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks',
  'browser_use', 'computer_use', 'image_generation', 'skill_mcp_dependency_install', 'goals', 'sleep_tool', 'tool_suggest',
];

/** A TOML string: JSON's escapes are TOML's, bar the DEL character. */
const toml = (s: string) => JSON.stringify(s).replace(/\x7f/g, '\\u007F');

/**
 * `codex exec` for one request, read from stdin. Nothing of the user's ~/.codex/config.toml is read or written:
 * the servers, the sandbox and the brief are -c overrides of this one run.
 */
export function codexArgs(o: { servers: Record<string, ServerCommand>; model?: string; resume?: string; persona?: string; env?: NodeJS.ProcessEnv }): string[] {
  const home = (o.env ?? process.env).BLOB_HOME;
  const c = (key: string, value: string) => ['-c', `${key}=${value}`];
  return [
    'exec', ...(o.resume ? ['resume', o.resume] : []),
    '--json',                               // events as JSON lines
    '--skip-git-repo-check',                // the cwd is an empty folder, not a repository
    '--ignore-user-config',                 // none of the user's MCP servers, profiles or settings (the sign-in is still theirs)
    '--ignore-rules',                       // nor their command rules
    '--strict-config',                      // an override this Codex does not know is an error, never a silent no-op
    ...c('sandbox_mode', '"read-only"'),    // what is left of Codex's own tools (apply_patch) cannot write...
    ...c('approval_policy', '"never"'),     // ...and nothing can ask its way out: a blocked call is just refused
    ...CODEX_OFF.flatMap(f => ['--disable', f]),
    ...c('agents.enabled', 'false'),
    ...c('web_search', '"disabled"'),
    ...Object.entries(o.servers).flatMap(([name, s]) => {
      // Codex hands a server only a few system variables: Blob's folder goes along when it is not the usual one.
      const env = { ...(home && { BLOB_HOME: home }), ...s.env };
      const k = `mcp_servers.${name}`;
      return [
        ...c(`${k}.command`, toml(s.command)),
        ...c(`${k}.args`, `[${s.args.map(toml).join(',')}]`),
        ...(Object.keys(env).length ? c(`${k}.env`, `{${Object.entries(env).map(([n, v]) => `${n}=${toml(v)}`).join(',')}}`) : []),
        ...c(`${k}.default_tools_approval_mode`, '"approve"'),   // the Yes gates are the servers' own; Codex has nobody to ask
        ...c(`${k}.required`, 'true'),                           // without one of them Codex does not start, and says which
        ...c(`${k}.startup_timeout_sec`, '30'),
        ...c(`${k}.tool_timeout_sec`, '1800'),                   // a call may wait for the user's Yes, or for a pause to end
      ];
    }),
    ...c('developer_instructions', toml(o.persona ? `${SYSTEM_PROMPT}\n${o.persona}` : SYSTEM_PROMPT)),
    ...(o.model && o.model !== 'default' ? ['-m', o.model] : []),
    '-',
  ];
}

/**
 * What goes to Codex's stdin. A resumed session keeps the brief it started with, so the brief as it is now (the
 * time, the settings, the saved facts) goes in front of the request.
 */
export function codexInput(text: string, brief?: string): string {
  return brief ? `<brief_now>\n${brief}\n</brief_now>\n${text}` : text;
}

/** The child's env: no API key or host-session variables, so `claude` signs in with the user's own plan login. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^ANTHROPIC_/i.test(k) || /^CLAUDECODE$/i.test(k) || /^CLAUDE_CODE_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The user message for --input-format stream-json. */
export function userMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** clawdcursor ends each action result with one line: [confirmed], [failed · CODE · hint: … · next: …], ... */
export function outcomeOf(text: string, isError: boolean): { outcome: string; line: string } {
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const m = last.match(/^\[(confirmed|unverified|refused|failed)\b.*\]$/);
  if (m) return { outcome: m[1], line: last };
  return { outcome: isError ? 'error' : 'ok', line: oneLine(lines[0] ?? '') };
}

function stepCaption(tool: string, action?: string): string {
  return `${tool}${action ? ' · ' + action : ''}…`;
}

/** "mcp__files__move" or "files.move" -> { server: 'files', tool: 'move' }; a built-in ("Read") has server ''. */
export function splitToolName(name: string): { server: string; tool: string } {
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) return { server: parts[1], tool: parts.slice(2).join('__') };
  const dot = name.match(/^([\w-]+)\.(.+)$/);
  if (dot) return { server: dot[1], tool: dot[2] };
  return { server: '', tool: name };
}

/** How a call reads in the caption and the log: "accessibility · invoke", "files · move", "Read". */
export function callLabel(server: string, tool: string, args: Record<string, unknown>): { tool: string; action?: string } {
  if (server === 'clawdcursor') return { tool, action: typeof args.action === 'string' ? args.action : undefined };
  if (server) return { tool: server, action: tool };
  return { tool };
}

/** Turns stream-json events into caption and log updates. One parser per run. */
export class StreamParser {
  private pending = new Map<string, { server: string; tool: string; args: Record<string, unknown> }>();
  /** The run's finished tool calls, in order. */
  readonly calls: Call[] = [];
  sawResult = false;
  resultError = false;

  feed(line: string): Update[] {
    let e: any;
    try { e = JSON.parse(line); } catch { return []; }
    const out: Update[] = [];
    if (e?.type === 'system' && e.subtype === 'init') {
      if (typeof e.session_id === 'string') out.push({ type: 'session', id: e.session_id });
      const servers: any[] = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
      const s = servers.find(x => x?.name === 'clawdcursor');
      const f = servers.find(x => x?.name === 'files');
      if (!s) out.push({ type: 'caption', text: 'Claude Code started without clawdcursor.' });
      else if (s.status !== 'connected') out.push({ type: 'caption', text: `clawdcursor is ${s.status ?? 'not connected'}.` });
      else if (f && f.status !== 'connected') out.push({ type: 'caption', text: `Blob's file tools are ${f.status ?? 'not connected'}.` });
      return out;
    }
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'caption', text: oneLine(b.text) });
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const { server, tool } = splitToolName(b.name);
          const args = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {};
          this.pending.set(b.id, { server, tool, args });
          const l = callLabel(server, tool, args);
          out.push({ type: 'caption', text: stepCaption(l.tool, l.action) });
        }
      }
      return out;
    }
    if (e?.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type !== 'tool_result') continue;
        const call = this.pending.get(b.tool_use_id) ?? { server: '', tool: '?', args: {} };
        const o = outcomeOf(resultText(b.content), b.is_error === true);
        this.calls.push({ ...call, ...o });
        out.push({ type: 'log', entry: { ...callLabel(call.server, call.tool, call.args), ...o } });
      }
      return out;
    }
    if (e?.type === 'result') {
      this.sawResult = true;
      this.resultError = e.is_error === true;
      if (typeof e.session_id === 'string') out.push({ type: 'session', id: e.session_id });
      const text = typeof e.result === 'string' && e.result.trim() ? e.result : e.is_error ? `Claude Code stopped (${e.subtype ?? 'error'}).` : 'Done.';
      out.push({ type: 'answer', text: oneLine(text, 400) });
    }
    return out;
  }
}

/** Turns `codex exec --json` events into the same updates. One parser per run. */
export class CodexParser {
  readonly calls: Call[] = [];
  sawResult = false;
  resultError = false;
  private last = '';                                 // the latest message: the answer when the turn ends

  feed(line: string): Update[] {
    let e: any;
    try { e = JSON.parse(line); } catch { return []; }
    const item = e?.item;
    if (e?.type === 'thread.started') return typeof e.thread_id === 'string' ? [{ type: 'session', id: e.thread_id }] : [];
    if (e?.type === 'error' || (e?.type === 'item.completed' && item?.type === 'error')) {
      const text = e.type === 'error' ? e.message : item.message;
      return typeof text === 'string' && text.trim() ? [{ type: 'caption', text: oneLine(text) }] : [];
    }
    if (e?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      this.last = item.text;
      return [{ type: 'caption', text: oneLine(item.text) }];
    }
    if ((e?.type === 'item.started' || e?.type === 'item.completed') && item?.type === 'mcp_tool_call' && typeof item.tool === 'string') {
      // Codex names the server and the tool apart; a name that carries both ("mcp__files__move", "files.move") is split.
      const { server, tool } = typeof item.server === 'string' && item.server ? { server: item.server, tool: item.tool } : splitToolName(item.tool);
      const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments : {};
      const l = callLabel(server, tool, args);
      if (e.type === 'item.started') return [{ type: 'caption', text: stepCaption(l.tool, l.action) }];
      const failed = item.status === 'failed' || !!item.error;
      const o = outcomeOf(item.result ? resultText(item.result.content) : String(item.error?.message ?? ''), failed);
      this.calls.push({ server, tool, args, ...o });
      return [{ type: 'log', entry: { ...l, ...o } }];
    }
    if (e?.type === 'turn.completed' || e?.type === 'turn.failed') {
      this.sawResult = true;
      this.resultError = e.type === 'turn.failed';
      const text = this.resultError ? (typeof e.error?.message === 'string' && e.error.message.trim() ? e.error.message : 'Codex stopped.') : this.last || 'Done.';
      return [{ type: 'answer', text: oneLine(text, 400) }];
    }
    return [];
  }
}

function killTree(p: ChildProcessWithoutNullStreams): void {
  if (p.exitCode !== null || p.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** One `claude -p` or `codex exec` at a time. prewarm() starts it early (when Speak is pressed); run() sends the request. */
export class Brain {
  private child?: { p: ChildProcessWithoutNullStreams; brain: BrainName; model: Model; sent: boolean; halted: boolean; early: Update[]; input: (text: string) => string };
  private session?: { id: string; brain: BrainName };

  constructor(private o: {
    mcpConfigPath: string; servers: Record<string, ServerCommand>; cwd: string; emit: (e: BrainEvent) => void;
    persona?: (brain: BrainName) => string;
  }) {}

  get busy(): boolean { return !!this.child?.sent; }

  private same(model: Model, brain: BrainName): boolean { return this.child?.model === model && this.child.brain === brain; }

  prewarm(model: Model, brain: BrainName = 'claude'): void {
    if (this.child && (this.child.sent || this.same(model, brain))) return;
    this.cancel();
    this.child = this.start(model, brain);
  }

  /** Kills a prewarmed child that never got a request (nothing was said). */
  cancel(): void {
    if (this.child && !this.child.sent) { killTree(this.child.p); this.child = undefined; }
  }

  run(text: string, model: Model, brain: BrainName = 'claude'): boolean {
    if (this.busy) return false;
    if (!this.same(model, brain)) { this.cancel(); this.child = this.start(model, brain); }
    const c = this.child!;
    c.sent = true;
    this.o.emit({ type: 'busy', busy: true });
    this.o.emit({ type: 'caption', text: 'Thinking…' });
    for (const u of c.early.splice(0)) this.o.emit(u);   // e.g. "clawdcursor is failed." from a prewarmed start
    c.p.stdin.end(c.input(text));
    return true;
  }

  /** Stops the request that is running (the phone's Stop): it ends with "Stopped." */
  halt(): void {
    if (!this.child?.sent) return;
    this.child.halted = true;
    killTree(this.child.p);
  }

  stop(): void { if (this.child) killTree(this.child.p); this.child = undefined; }

  private start(model: Model, brain: BrainName) {
    // A session cannot move between brains: the other one starts a new conversation, and says so.
    const moved = !!this.session && this.session.brain !== brain;
    if (moved) this.session = undefined;
    const resume = this.session?.id, persona = this.o.persona?.(brain), codex = brain === 'codex', name = BRAIN_NAME[brain];
    const cmd = codex ? codexCommand() : { command: 'claude', args: [] };
    const args = codex ? codexArgs({ servers: this.o.servers, resume, persona })      // Codex runs its own default model
      : claudeArgs({ mcpConfigPath: this.o.mcpConfigPath, model, resume, persona });
    const p = spawn(cmd.command, [...cmd.args, ...args], {
      cwd: this.o.cwd, env: cleanEnv(), windowsHide: true, detached: process.platform !== 'win32',
    });
    const entry = {
      p, brain, model, sent: false, halted: false,
      early: (moved ? [{ type: 'caption', text: `Now using ${name}: this is a new conversation.` }] : []) as Update[],
      input: codex ? (text: string) => codexInput(text, resume && persona) : userMessage,
    };
    const parser = codex ? new CodexParser() : new StreamParser();
    let stderr = '';
    p.stdout.setEncoding('utf8');
    p.stdin.on('error', () => { /* it exited before reading; the close handler reports it */ });
    p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    createInterface({ input: p.stdout }).on('line', line => {
      for (const u of parser.feed(line)) {
        if (u.type === 'session') this.session = { id: u.id, brain };
        else if (entry.sent) this.o.emit(u);
        else entry.early.push(u);
      }
    });
    let finished = false;
    const done = (why: string) => {
      if (finished) return;
      finished = true;
      if (this.child === entry) this.child = undefined;
      if (!entry.sent) return;
      if (!parser.sawResult) this.o.emit({ type: 'answer', text: entry.halted ? 'Stopped.' : oneLine(stderr.trim().split('\n').pop() || why, 400) });
      this.o.emit({ type: 'busy', busy: false });
      this.o.emit({ type: 'done', calls: parser.calls, ok: parser.sawResult && !parser.resultError });
    };
    p.on('error', err => done(`Could not start ${name}: ${err.message}`));
    p.on('close', code => done(`${name} exited (${code}).`));
    return entry;
  }
}
