// One run at a time of the user's own `claude -p`, with clawdcursor and Blob's file tools.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Model } from './settings.ts';

export type { Model };

export interface LogEntry {
  tool: string;       // "computer", "accessibility", ... (the mcp__clawdcursor__ prefix dropped)
  action?: string;    // the call's `action` argument, when it has one
  outcome: string;    // confirmed | unverified | refused | failed | ok | error
  line: string;       // clawdcursor's own outcome line, or the first line of the result
}

/** One finished tool call of a run, in order: what a shortcut is saved from. server '' = a Claude Code built-in. */
export interface Call {
  server: string;     // 'clawdcursor' | 'files' | ''
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

/** Claude Code's read-only file tools; changes go through Blob's files server, which asks before trash/overwrite. */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep'];

export const SYSTEM_PROMPT =
  'You are driven from a small floating bubble on the desktop: the request comes from the user by voice or typing. ' +
  'Do it on this computer with the clawdcursor tools. For files and folders use Read, Glob and Grep to look and the ' +
  'files tools (list_dir, make_folder, move, trash) to change them, not the desktop. Your final reply is shown as a ' +
  'one-line caption: one or two short plain sentences saying what you did or found, no markdown.';

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

/** The --mcp-config file: clawdcursor, Blob's files server and Blob's self server ("blob"), nothing else. */
export function mcpConfig(own: { files: ServerCommand; blob: ServerCommand }, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return JSON.stringify({ mcpServers: {
    clawdcursor: { type: 'stdio', ...clawdcursorCommand(env, platform) },
    files: { type: 'stdio', ...own.files },
    blob: { type: 'stdio', ...own.blob },
  } }, null, 2);
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
    '--tools', BUILTIN_TOOLS.join(','),     // read-only built-ins only: no Bash, no Edit/Write
    '--allowedTools', ['mcp__clawdcursor__*', 'mcp__files__*', 'mcp__blob__*', ...BUILTIN_TOOLS].join(','),
    '--disable-slash-commands',
    '--no-chrome',
    '--append-system-prompt', o.persona ? `${SYSTEM_PROMPT}\n${o.persona}` : SYSTEM_PROMPT,
    ...(o.model === 'default' ? [] : ['--model', o.model]),
    ...(o.resume ? ['--resume', o.resume] : []),
  ];
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

/** "mcp__files__move" -> { server: 'files', tool: 'move' }; a built-in ("Read") has server ''. */
export function splitToolName(name: string): { server: string; tool: string } {
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) return { server: parts[1], tool: parts.slice(2).join('__') };
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

function killTree(p: ChildProcessWithoutNullStreams): void {
  if (p.exitCode !== null || p.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** One `claude -p` at a time. prewarm() starts it early (when Speak is pressed); run() sends the request. */
export class Brain {
  private child?: { p: ChildProcessWithoutNullStreams; model: Model; sent: boolean; halted: boolean; early: Update[] };
  private session?: string;

  constructor(private o: { mcpConfigPath: string; cwd: string; emit: (e: BrainEvent) => void; persona?: () => string }) {}

  get busy(): boolean { return !!this.child?.sent; }

  prewarm(model: Model): void {
    if (this.child && (this.child.sent || this.child.model === model)) return;
    this.cancel();
    this.child = this.start(model);
  }

  /** Kills a prewarmed child that never got a request (nothing was said). */
  cancel(): void {
    if (this.child && !this.child.sent) { killTree(this.child.p); this.child = undefined; }
  }

  run(text: string, model: Model): boolean {
    if (this.busy) return false;
    if (this.child?.model !== model) { this.cancel(); this.child = this.start(model); }
    const c = this.child!;
    c.sent = true;
    this.o.emit({ type: 'busy', busy: true });
    this.o.emit({ type: 'caption', text: 'Thinking…' });
    for (const u of c.early.splice(0)) this.o.emit(u);   // e.g. "clawdcursor is failed." from a prewarmed start
    c.p.stdin.end(userMessage(text));
    return true;
  }

  /** Stops the request that is running (the phone's Stop): it ends with "Stopped." */
  halt(): void {
    if (!this.child?.sent) return;
    this.child.halted = true;
    killTree(this.child.p);
  }

  stop(): void { if (this.child) killTree(this.child.p); this.child = undefined; }

  private start(model: Model) {
    const p = spawn('claude', claudeArgs({ mcpConfigPath: this.o.mcpConfigPath, model, resume: this.session, persona: this.o.persona?.() }), {
      cwd: this.o.cwd, env: cleanEnv(), windowsHide: true, detached: process.platform !== 'win32',
    });
    const entry = { p, model, sent: false, halted: false, early: [] as Update[] };
    const parser = new StreamParser();
    let stderr = '';
    p.stdout.setEncoding('utf8');
    p.stdin.on('error', () => { /* it exited before reading; the close handler reports it */ });
    p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    createInterface({ input: p.stdout }).on('line', line => {
      for (const u of parser.feed(line)) {
        if (u.type === 'session') this.session = u.id;
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
    p.on('error', err => done(`Could not start claude: ${err.message}`));
    p.on('close', code => done(`claude exited (${code}).`));
    return entry;
  }
}
