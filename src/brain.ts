// One run at a time of the user's own `claude -p`, with clawdcursor as its only tools.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Model = 'sonnet' | 'haiku' | 'default';

export interface LogEntry {
  tool: string;       // "computer", "accessibility", ... (the mcp__clawdcursor__ prefix dropped)
  action?: string;    // the call's `action` argument, when it has one
  outcome: string;    // confirmed | unverified | refused | failed | ok | error
  line: string;       // clawdcursor's own outcome line, or the first line of the result
}

export type Update =
  | { type: 'caption'; text: string }
  | { type: 'log'; entry: LogEntry }
  | { type: 'session'; id: string };

const PREFIX = 'mcp__clawdcursor__';

export const SYSTEM_PROMPT =
  'You are driven from a small floating bubble on the desktop: the request comes from the user by voice or typing. ' +
  'Do it on this computer with the clawdcursor tools. Your final reply is shown as a one-line caption: ' +
  'one or two short plain sentences saying what you did or found, no markdown.';

/** The clawdcursor MCP server command: `clawdcursor mcp --compact`, or PRONTO_CLAWDCURSOR (e.g. a dev build). */
export function clawdcursorCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): { command: string; args: string[] } {
  const raw = env.PRONTO_CLAWDCURSOR?.trim() || 'clawdcursor mcp --compact';
  const parts = (raw.match(/"[^"]*"|\S+/g) ?? []).map(p => p.replace(/^"|"$/g, ''));
  // npm installs clawdcursor as a .cmd shim on Windows, which only cmd can start.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', ...parts] };
  return { command: parts[0], args: parts.slice(1) };
}

/** The --mcp-config file: clawdcursor and nothing else. */
export function mcpConfig(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const { command, args } = clawdcursorCommand(env, platform);
  return JSON.stringify({ mcpServers: { clawdcursor: { type: 'stdio', command, args } } }, null, 2);
}

export function claudeArgs(o: { mcpConfigPath: string; model: Model; resume?: string }): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', o.mcpConfigPath,
    '--strict-mcp-config',                  // no other MCP server (not the user's own, not a plugin's)
    '--setting-sources', 'project',         // the cwd is an empty folder: none of the user's hooks, plugins or CLAUDE.md
    '--tools', '',                          // no built-in tool: the desktop is reached through clawdcursor only
    '--allowedTools', `${PREFIX}*`,
    '--disable-slash-commands',
    '--no-chrome',
    '--append-system-prompt', SYSTEM_PROMPT,
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

/** Turns stream-json events into caption and log updates. One parser per run. */
export class StreamParser {
  private calls = new Map<string, { tool: string; action?: string }>();
  sawResult = false;

  feed(line: string): Update[] {
    let e: any;
    try { e = JSON.parse(line); } catch { return []; }
    const out: Update[] = [];
    if (e?.type === 'system' && e.subtype === 'init') {
      if (typeof e.session_id === 'string') out.push({ type: 'session', id: e.session_id });
      const s = Array.isArray(e.mcp_servers) ? e.mcp_servers.find((x: any) => x?.name === 'clawdcursor') : undefined;
      if (!s) out.push({ type: 'caption', text: 'Claude Code started without clawdcursor.' });
      else if (s.status !== 'connected') out.push({ type: 'caption', text: `clawdcursor is ${s.status ?? 'not connected'}.` });
      return out;
    }
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'caption', text: oneLine(b.text) });
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const tool = b.name.startsWith(PREFIX) ? b.name.slice(PREFIX.length) : b.name;
          const action = typeof b.input?.action === 'string' ? b.input.action : undefined;
          this.calls.set(b.id, { tool, action });
          out.push({ type: 'caption', text: stepCaption(tool, action) });
        }
      }
      return out;
    }
    if (e?.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type !== 'tool_result') continue;
        const call = this.calls.get(b.tool_use_id) ?? { tool: '?' };
        out.push({ type: 'log', entry: { ...call, ...outcomeOf(resultText(b.content), b.is_error === true) } });
      }
      return out;
    }
    if (e?.type === 'result') {
      this.sawResult = true;
      if (typeof e.session_id === 'string') out.push({ type: 'session', id: e.session_id });
      const text = typeof e.result === 'string' && e.result.trim() ? e.result : e.is_error ? `Claude Code stopped (${e.subtype ?? 'error'}).` : 'Done.';
      out.push({ type: 'caption', text: oneLine(text, 400) });
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
  private child?: { p: ChildProcessWithoutNullStreams; model: Model; sent: boolean; early: Update[] };
  private session?: string;

  constructor(private o: { mcpConfigPath: string; cwd: string; emit: (u: Update | { type: 'busy'; busy: boolean }) => void }) {}

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

  stop(): void { if (this.child) killTree(this.child.p); this.child = undefined; }

  private start(model: Model) {
    const p = spawn('claude', claudeArgs({ mcpConfigPath: this.o.mcpConfigPath, model, resume: this.session }), {
      cwd: this.o.cwd, env: cleanEnv(), windowsHide: true, detached: process.platform !== 'win32',
    });
    const entry = { p, model, sent: false, early: [] as Update[] };
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
      if (!parser.sawResult) this.o.emit({ type: 'caption', text: oneLine(stderr.trim().split('\n').pop() || why, 400) });
      this.o.emit({ type: 'busy', busy: false });
    };
    p.on('error', err => done(`Could not start claude: ${err.message}`));
    p.on('close', code => done(`claude exited (${code}).`));
    return entry;
  }
}
