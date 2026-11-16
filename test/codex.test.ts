// Codex as the brain: its command line, its JSON events, and the tool names. Nothing is started.
// The event lines are as `codex exec --json` (codex-cli 0.169.0) printed them against a local stand-in for the model.
import { describe, expect, it } from 'vitest';
import { CODEX_OFF, CodexParser, SYSTEM_PROMPT, codexArgs, codexCommand, codexInput, mcpServers, splitToolName, type ServerCommand } from '../src/brain.ts';
import { persona } from '../src/persona.ts';
import { DEFAULTS } from '../src/settings.ts';

const servers: Record<string, ServerCommand> = {
  clawdcursor: { command: 'cmd', args: ['/c', 'clawdcursor', 'mcp', '--compact'], env: { CLAWD_PILL_CMD: '["node","C:\\\\app\\\\pill-host.mjs"]' } },
  files: { command: String.raw`C:\Program Files\nodejs\node.exe`, args: [String.raw`C:\app\dist\files-mcp.mjs`], env: { BLOB_ASK_URL: 'http://127.0.0.1:47615/ask', BLOB_ASK_TOKEN: 't' } },
  blob: { command: 'node', args: ['self.mjs'] },
};
/** The value of a `-c key=value` override. */
const override = (a: string[], key: string) => a.filter((x, i) => a[i - 1] === '-c' && x.startsWith(`${key}=`)).map(x => x.slice(key.length + 1));

describe('codex command line', () => {
  it('runs one request from stdin as JSON events, with none of the user\'s own Codex config', () => {
    const a = codexArgs({ servers, env: {} });
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a).toEqual(expect.arrayContaining(['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config']));
    expect(a[a.length - 1]).toBe('-');                                  // the request is read from stdin
    expect(a).not.toContain('resume');
    expect(a).not.toContain('-m');                                      // Codex's own default model
    expect(a.join(' ')).not.toMatch(/dangerously|danger-full-access|workspace-write/);
  });

  it('switches Codex\'s own shell and other tools off, and sandboxes what is left: read-only, never asks', () => {
    const a = codexArgs({ servers, env: {} });
    const off = a.filter((x, i) => a[i - 1] === '--disable');
    expect(off).toEqual(CODEX_OFF);
    expect(off).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'computer_use', 'browser_use']));
    expect(override(a, 'sandbox_mode')).toEqual(['"read-only"']);
    expect(override(a, 'approval_policy')).toEqual(['"never"']);
    expect(override(a, 'agents.enabled')).toEqual(['false']);
    expect(override(a, 'web_search')).toEqual(['"disabled"']);
  });

  it('gives it Blob\'s three servers as overrides of this run: its own two required, and never asked about by Codex', () => {
    const a = codexArgs({ servers, env: {} });
    expect(override(a, 'mcp_servers.clawdcursor.command')).toEqual(['"cmd"']);
    expect(override(a, 'mcp_servers.clawdcursor.args')).toEqual(['["/c","clawdcursor","mcp","--compact"]']);
    expect(override(a, 'mcp_servers.clawdcursor.env')).toEqual([String.raw`{CLAWD_PILL_CMD="[\"node\",\"C:\\\\app\\\\pill-host.mjs\"]"}`]);
    expect(override(a, 'mcp_servers.files.command')).toEqual([String.raw`"C:\\Program Files\\nodejs\\node.exe"`]);   // a TOML string
    expect(override(a, 'mcp_servers.files.args')).toEqual([String.raw`["C:\\app\\dist\\files-mcp.mjs"]`]);
    expect(override(a, 'mcp_servers.files.env')).toEqual(['{BLOB_ASK_URL="http://127.0.0.1:47615/ask",BLOB_ASK_TOKEN="t"}']);
    expect(override(a, 'mcp_servers.blob.env')).toEqual([]);            // no env: no empty table
    for (const name of ['clawdcursor', 'files', 'blob']) {
      expect(override(a, `mcp_servers.${name}.default_tools_approval_mode`)).toEqual(['"approve"']);
      expect(override(a, `mcp_servers.${name}.required`)).toEqual([name === 'clawdcursor' ? 'false' : 'true']);   // the screen is the last resort: Codex starts without it
    }
    expect(a.filter(x => /^mcp_servers\.(?!clawdcursor\.|files\.|blob\.)/.test(x))).toEqual([]);   // no other server
    // Codex hands a server only a few system variables, so a Blob folder that is not the usual one goes along
    expect(override(codexArgs({ servers, env: { BLOB_HOME: '/tmp/b' } }), 'mcp_servers.blob.env')).toEqual(['{BLOB_HOME="/tmp/b"}']);
  });

  it('on Windows gets the desk server too, required like the other two of Blob; the screen is still not', () => {
    const desk = { command: 'node', args: ['desk-mcp.mjs'], env: { BLOB_DESK_URL: 'http://127.0.0.1:47615/desk', BLOB_DESK_TOKEN: 'd' } };
    const a = codexArgs({ servers: mcpServers({ files: servers.files, blob: servers.blob, desk }, {}, 'win32'), env: {} });
    expect(override(a, 'mcp_servers.desk.command')).toEqual(['"node"']);
    expect(override(a, 'mcp_servers.desk.args')).toEqual(['["desk-mcp.mjs"]']);
    expect(override(a, 'mcp_servers.desk.env')).toEqual(['{BLOB_DESK_URL="http://127.0.0.1:47615/desk",BLOB_DESK_TOKEN="d"}']);
    expect(override(a, 'mcp_servers.desk.default_tools_approval_mode')).toEqual(['"approve"']);
    expect(override(a, 'mcp_servers.desk.required')).toEqual(['true']);
    expect(override(a, 'mcp_servers.clawdcursor.required')).toEqual(['false']);
    expect(codexArgs({ servers: mcpServers({ files: servers.files, blob: servers.blob, desk }, {}, 'linux'), env: {} }).join(' ')).not.toContain('mcp_servers.desk');
  });

  it('adds the same brief, as developer instructions', () => {
    expect(override(codexArgs({ servers, env: {} }), 'developer_instructions')).toEqual([JSON.stringify(SYSTEM_PROMPT)]);
    const brief = override(codexArgs({ servers, env: {}, persona: 'Blob is an assistant.\nIt says "done".' }), 'developer_instructions')[0];
    expect(brief).not.toMatch(/\n/);                                    // one line: the line breaks are escaped
    expect(JSON.parse(brief)).toBe(`${SYSTEM_PROMPT}\nBlob is an assistant.\nIt says "done".`);
  });

  it('resumes a session, and takes a model that is not the default', () => {
    const a = codexArgs({ servers, env: {}, resume: '01a1dfad-e29f-7c31-b6b2-fc16636cc4f9', model: 'gpt-5.5' });
    expect(a.slice(0, 4)).toEqual(['exec', 'resume', '01a1dfad-e29f-7c31-b6b2-fc16636cc4f9', '--json']);
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(a[a.length - 1]).toBe('-');
    expect(override(a, 'sandbox_mode')).toEqual(['"read-only"']);       // `exec resume` has no -s: the override carries it
    expect(codexArgs({ servers, env: {}, model: 'default' })).not.toContain('-m');
  });

  it('sends the request as it is, and on a resumed session the brief as it is now in front of it', () => {
    expect(codexInput('open notepad')).toBe('open notepad');
    expect(codexInput('open notepad', 'Local time now: 08:00.')).toBe('<brief_now>\nLocal time now: 08:00.\n</brief_now>\nopen notepad');
  });

  it('starts Codex with no shell: its .exe, or on Windows the script npm\'s codex.cmd names, with this Node', () => {
    expect(codexCommand('darwin', {})).toEqual({ command: 'codex', args: [] });
    const shim = String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`;
    const npm = String.raw`C:\Users\u\AppData\Roaming\npm`, bin = String.raw`C:\tools`;
    const has = (files: Record<string, string>) => ({ exists: (p: string) => p in files, read: (p: string) => files[p] });
    if (process.platform !== 'win32') return;                           // the rest joins Windows paths
    expect(codexCommand('win32', { PATH: `${bin};${npm}` }, has({ [String.raw`${npm}\codex.cmd`]: shim })))
      .toEqual({ command: process.execPath, args: [String.raw`${npm}\node_modules\@openai\codex\bin\codex.js`] });
    expect(codexCommand('win32', { Path: `${bin};${npm}` }, has({ [String.raw`${bin}\codex.exe`]: '', [String.raw`${npm}\codex.cmd`]: shim })))
      .toEqual({ command: String.raw`${bin}\codex.exe`, args: [] });
    expect(codexCommand('win32', { PATH: npm }, has({ [String.raw`${npm}\codex.cmd`]: '@echo something else' }))).toEqual({ command: 'codex', args: [] });
    expect(codexCommand('win32', { PATH: npm }, has({}))).toEqual({ command: 'codex', args: [] });   // not installed: starting it fails
  });
});

// One run, as recorded: a message, a clawdcursor call that confirms, one that fails, a files call that Codex itself
// refused (as it would without the approval override), and the last message.
const RUN = [
  '{"type":"thread.started","thread_id":"01a1dfa6-48f6-7e02-8236-b353aa60704a"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Looking."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"clawdcursor","tool":"computer","arguments":{"action":"click","text":"hi"},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"clawdcursor","tool":"computer","arguments":{"action":"click","text":"hi"},"result":{"content":[{"type":"text","text":"did click\\n[confirmed]"}],"structured_content":null},"error":null,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"clawdcursor","tool":"computer","arguments":{"action":"boom"},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"clawdcursor","tool":"computer","arguments":{"action":"boom"},"result":{"content":[{"type":"text","text":"no window\\n[failed · NO_WINDOW · hint: open it first]"}],"structured_content":null},"error":null,"status":"failed"}}',
  '{"type":"item.started","item":{"id":"item_3","type":"mcp_tool_call","server":"files","tool":"move","arguments":{"from":"/a","to":"/b"},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"files","tool":"move","arguments":{"from":"/a","to":"/b"},"result":null,"error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"All done here.\\nNothing else."}}',
  '{"type":"turn.completed","usage":{"input_tokens":40,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0}}',
];

describe('codex JSON events', () => {
  it('turns a run into the same updates: session, captions, one log entry per call, the calls, and the answer', () => {
    const p = new CodexParser();
    const updates = RUN.flatMap(l => p.feed(l));
    expect(updates[0]).toEqual({ type: 'session', id: '01a1dfa6-48f6-7e02-8236-b353aa60704a' });
    expect(updates.filter(u => u.type === 'caption').map(u => (u as { text: string }).text)).toEqual([
      'Looking.', 'computer · click…', 'computer · boom…', 'files · move…', 'All done here. Nothing else.',
    ]);
    expect(updates.filter(u => u.type === 'log').map(u => (u as { entry: unknown }).entry)).toEqual([
      { tool: 'computer', action: 'click', outcome: 'confirmed', line: '[confirmed]' },
      { tool: 'computer', action: 'boom', outcome: 'failed', line: '[failed · NO_WINDOW · hint: open it first]' },
      { tool: 'files', action: 'move', outcome: 'error', line: 'MCP tool call requires approval, but approval policy is never' },
    ]);
    // what habits and shortcuts are built from: the same shape as Claude Code's calls
    expect(p.calls.map(c => [c.server, c.tool, c.args, c.outcome])).toEqual([
      ['clawdcursor', 'computer', { action: 'click', text: 'hi' }, 'confirmed'],
      ['clawdcursor', 'computer', { action: 'boom' }, 'failed'],
      ['files', 'move', { from: '/a', to: '/b' }, 'error'],
    ]);
    expect(updates.filter(u => u.type === 'answer')).toEqual([{ type: 'answer', text: 'All done here. Nothing else.' }]);
    expect(p.sawResult).toBe(true);
    expect(p.resultError).toBe(false);
  });

  it('reports a failed turn as an error, with what Codex said', () => {
    const p = new CodexParser();
    const msg = 'unexpected status 401 Unauthorized: Your session has expired. Please sign in again., url: http://127.0.0.1:48211/v1/responses';
    expect(p.feed('not json')).toEqual([]);
    expect(p.feed(`{"type":"error","message":"Reconnecting... 1/5 (${msg})"}`)).toEqual([{ type: 'caption', text: expect.stringMatching(/^Reconnecting\.\.\. 1\/5/) }]);
    expect(p.sawResult).toBe(false);
    expect(p.feed(`{"type":"turn.failed","error":{"message":"${msg}"}}`)).toEqual([{ type: 'answer', text: msg }]);
    expect(p.sawResult).toBe(true);
    expect(p.resultError).toBe(true);
  });

  it('answers Done. when the turn ends with no message, and shows an error item as a caption', () => {
    const p = new CodexParser();
    expect(p.feed('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable."}}')).toEqual([{ type: 'caption', text: 'Code Mode is unavailable.' }]);
    expect(p.feed('{"type":"turn.completed","usage":{}}')).toEqual([{ type: 'answer', text: 'Done.' }]);
  });
});

describe('the brief', () => {
  it('is the same plain brief for both, bar how to read a file; it says how to switch, and names no company', () => {
    const claude = persona(DEFAULTS), codex = persona({ ...DEFAULTS, brain: 'codex' });
    expect(claude).toMatch(/Read, Glob and Grep to look/);
    expect(claude).toMatch(/brain Claude Code; model Auto \(Haiku first/);
    expect(codex).not.toMatch(/Read, Glob and Grep/);                   // Codex has no built-in file tools here
    expect(codex).toMatch(/run with a command that only looks, to read/);
    expect(codex).toMatch(/brain Codex; model Codex's default model;/);
    expect(persona(DEFAULTS, { brain: 'codex' })).toBe(codex);          // the brain in use, when only the other one is ready
    for (const b of [claude, codex]) {
      expect(b).toMatch(/"use Codex", "use Claude"/);
      expect(b).toMatch(/brain=claude or brain=codex/);
      expect(b).not.toMatch(/OpenAI|Anthropic/i);
    }
  });
});

describe('tool names', () => {
  it('reads both brains\' names as the same server and tool', () => {
    expect(splitToolName('mcp__clawdcursor__computer')).toEqual({ server: 'clawdcursor', tool: 'computer' });
    expect(splitToolName('clawdcursor.computer')).toEqual({ server: 'clawdcursor', tool: 'computer' });
    expect(splitToolName('files.make_folder')).toEqual(splitToolName('mcp__files__make_folder'));
    expect(splitToolName('Read')).toEqual({ server: '', tool: 'Read' });
  });

  it('splits a Codex call that carries the server in the tool name, and keeps one that names them apart', () => {
    const call = (item: object) => { const p = new CodexParser(); p.feed(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed', result: { content: [{ type: 'text', text: '[confirmed]' }] }, ...item } })); return p.calls[0]; };
    expect(call({ tool: 'mcp__clawdcursor__computer', arguments: { action: 'key' } })).toMatchObject({ server: 'clawdcursor', tool: 'computer', outcome: 'confirmed' });
    expect(call({ tool: 'clawdcursor.computer' })).toMatchObject({ server: 'clawdcursor', tool: 'computer', args: {} });
    expect(call({ server: 'blob', tool: 'change_setting', arguments: { key: 'brain', value: 'claude' } })).toMatchObject({ server: 'blob', tool: 'change_setting' });
    expect(call({ server: 'codex', tool: 'list_mcp_resources' })).toMatchObject({ server: 'codex', tool: 'list_mcp_resources' });   // Codex's own helper
  });
});
