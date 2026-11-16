import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';
import { PILL_HOST, StreamParser, callLabel, claudeArgs, cleanEnv, clawdcursorCommand, mcpConfig, mcpServers, outcomeOf, splitToolName, userMessage } from '../src/brain.ts';

describe('claude command line', () => {
  it('runs stream-json print mode with clawdcursor, the files (and shell), desk and self servers and the read-only built-ins', () => {
    const a = claudeArgs({ mcpConfigPath: '/tmp/mcp.json', model: 'sonnet' });
    const after = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe('-p');
    expect(after('--input-format')).toBe('stream-json');
    expect(after('--output-format')).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(after('--mcp-config')).toBe('/tmp/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(after('--tools')).toBe('Read,Glob,Grep');
    expect(after('--allowedTools')).toBe('mcp__clawdcursor__*,mcp__files__*,mcp__desk__*,mcp__blob__*,Read,Glob,Grep');   // files__* covers the shell tool, run
    expect(a.join(' ')).not.toMatch(/Bash|Edit|Write/);                 // Claude Code's own shell stays off: run asks, Bash would not
    expect(after('--model')).toBe('sonnet');
    expect(after('--append-system-prompt')).toMatch(/one short plain sentence/);
    expect(a).not.toContain('--resume');
  });

  it('adds what Blob knows about itself to the system prompt, and takes Opus', () => {
    const a = claudeArgs({ mcpConfigPath: 'm.json', model: 'opus', persona: 'Blob is an assistant.' });
    expect(a[a.indexOf('--append-system-prompt') + 1]).toMatch(/caption[^]*\nBlob is an assistant\.$/);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
  });

  it('leaves the model to Claude Code for Default, and resumes a session', () => {
    const a = claudeArgs({ mcpConfigPath: 'm.json', model: 'default', resume: 'abc-123' });
    expect(a).not.toContain('--model');
    expect(a[a.indexOf('--resume') + 1]).toBe('abc-123');
    expect(claudeArgs({ mcpConfigPath: 'm.json', model: 'haiku' })).toContain('haiku');
  });

  it('caps the steps only when told to (a tier of auto that can step up)', () => {
    const a = claudeArgs({ mcpConfigPath: 'm.json', model: 'haiku', maxTurns: 12 });
    expect(a[a.indexOf('--max-turns') + 1]).toBe('12');
    expect(claudeArgs({ mcpConfigPath: 'm.json', model: 'haiku' })).not.toContain('--max-turns');
  });

  it('sends a fresh brief on every start, a resume too', () => {
    const a = claudeArgs({ mcpConfigPath: 'm.json', model: 'sonnet', resume: 'abc' });
    expect(a[a.indexOf('--system-prompt-snapshot') + 1]).toBe('off');
  });

  it('starts clawdcursor mcp --compact, through cmd on Windows, or the override', () => {
    expect(clawdcursorCommand({}, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'clawdcursor', 'mcp', '--compact'] });
    expect(clawdcursorCommand({}, 'darwin')).toEqual({ command: 'clawdcursor', args: ['mcp', '--compact'] });
    expect(clawdcursorCommand({ BLOB_CLAWDCURSOR: 'node "C:/dev x/cli.js" mcp --compact' }, 'linux'))
      .toEqual({ command: 'node', args: ['C:/dev x/cli.js', 'mcp', '--compact'] });
    expect(clawdcursorCommand({ BLOB_PILL_URL: 'http://127.0.0.1:1/pill' }, 'linux').env).toBeUndefined();   // no token yet
  });

  it('hands the pill to Blob: the relay as CLAWD_PILL_CMD, Blob as own UI, and where the relay finds Blob', () => {
    const host = { BLOB_PILL_URL: 'http://127.0.0.1:1/pill', BLOB_PILL_TOKEN: 'p' };
    const env = { ...host, CLAWD_PILL_CMD: JSON.stringify([process.execPath, PILL_HOST]), CLAWD_OWN_UI_PIDS: String(process.pid) };
    expect(isAbsolute(PILL_HOST)).toBe(true);
    expect(PILL_HOST.replace(/\\/g, '/')).toMatch(/\/dist\/pill-host\.mjs$/);
    expect(clawdcursorCommand(host, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'clawdcursor', 'mcp', '--compact'], env });
    // The file that names Blob's web view processes (they change while clawdcursor runs) goes along when there is one.
    expect(clawdcursorCommand({ ...host, BLOB_OWN_UI_FILE: '/tmp/blob/own-ui-pids' }, 'linux').env)
      .toEqual({ ...env, CLAWD_OWN_UI_PIDS_FILE: '/tmp/blob/own-ui-pids' });
    expect(clawdcursorCommand({ ...host, BLOB_CLAWDCURSOR: 'node cli.js mcp' }, 'linux')).toEqual({ command: 'node', args: ['cli.js', 'mcp'], env });
    const files = { command: '/usr/bin/node', args: ['/app/dist/files-mcp.mjs'], env: { BLOB_ASK_URL: 'http://127.0.0.1:1/ask', BLOB_ASK_TOKEN: 't' } };
    expect(JSON.parse(mcpConfig({ files, blob: { command: 'node', args: ['self.mjs'] } }, host, 'linux'))).toEqual({ mcpServers: {
      clawdcursor: { type: 'stdio', command: 'clawdcursor', args: ['mcp', '--compact'], env },
      files: { type: 'stdio', ...files },
      blob: { type: 'stdio', command: 'node', args: ['self.mjs'] },
    } });
  });

  it('adds the desk server on Windows only, between files and blob', () => {
    const own = { files: { command: 'node', args: ['files.mjs'] }, blob: { command: 'node', args: ['self.mjs'] }, desk: { command: 'node', args: ['desk.mjs'], env: { BLOB_DESK_URL: 'http://127.0.0.1:1/desk', BLOB_DESK_TOKEN: 'd' } } };
    const win = JSON.parse(mcpConfig(own, {}, 'win32')).mcpServers;
    expect(Object.keys(win)).toEqual(['clawdcursor', 'files', 'desk', 'blob']);
    expect(win.desk).toEqual({ type: 'stdio', ...own.desk });
    expect(Object.keys(JSON.parse(mcpConfig(own, {}, 'linux')).mcpServers)).toEqual(['clawdcursor', 'files', 'blob']);
    expect(Object.keys(mcpServers(own, {}, 'darwin'))).toEqual(['clawdcursor', 'files', 'blob']);
    expect(Object.keys(mcpServers({ files: own.files, blob: own.blob }, {}, 'win32'))).toEqual(['clawdcursor', 'files', 'blob']);   // none given: none added
  });

  it('writes one stream-json user message line', () => {
    const line = userMessage('open notepad');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'open notepad' }] } });
  });
});

describe('env', () => {
  it('drops API keys and host-session variables, keeps the rest, and turns CLAUDE.md loading off', () => {
    const env = cleanEnv({
      PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/c', BLOB_CLAWDCURSOR: 'x',
    });
    // Claude Code reads a CLAUDE.md from every folder above the cwd, whatever --setting-sources says: the user's own
    // coding rules are not Blob's brief. A value inherited from the host session does not switch it back on.
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/c', BLOB_CLAWDCURSOR: 'x', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
    expect(cleanEnv({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' })).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
  });
});

// Handwritten from the stream-json shapes Claude Code prints with --verbose (system/init, assistant, user tool_result, result).
const RUN = [
  { type: 'system', subtype: 'init', session_id: 's-1', tools: ['mcp__clawdcursor__computer'], mcp_servers: [{ name: 'clawdcursor', status: 'connected' }] },
  { type: 'assistant', session_id: 's-1', message: { role: 'assistant', content: [
    { type: 'text', text: "I'll open Notepad." },
    { type: 'tool_use', id: 'toolu_1', name: 'mcp__clawdcursor__system', input: { action: 'open_app', name: 'Notepad' } },
  ] } },
  { type: 'user', session_id: 's-1', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Opened Notepad.\n[confirmed]' }] },
  ] } },
  { type: 'assistant', session_id: 's-1', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'mcp__clawdcursor__accessibility', input: { action: 'invoke', name: 'Save' } },
  ] } },
  { type: 'user', session_id: 's-1', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true,
      content: 'No element named "Save".\n[failed · NOT_FOUND · hint: read the tree first · next: accessibility {"action":"read_tree"}]' },
  ] } },
  { type: 'assistant', session_id: 's-1', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_3', name: 'mcp__clawdcursor__accessibility', input: { action: 'read_tree' } },
  ] } },
  { type: 'user', session_id: 's-1', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: '{"elements":[]}' }] },
  ] } },
  { type: 'assistant', session_id: 's-1', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_4', name: 'mcp__files__move', input: { from: '/a', to: '/b' } },
    { type: 'tool_use', id: 'toolu_5', name: 'Read', input: { file_path: '/b' } },
  ] } },
  { type: 'user', session_id: 's-1', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_4', content: [{ type: 'text', text: 'Moved /a to /b.\n[confirmed]' }] },
    { type: 'tool_result', tool_use_id: 'toolu_5', content: 'hello' },
  ] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Notepad is open.\nIt is empty.', session_id: 's-1', total_cost_usd: 0.01 },
].map(e => JSON.stringify(e));

describe('stream-json parsing', () => {
  it('turns a run into captions (each step), one log entry per call, and the answer', () => {
    const p = new StreamParser();
    const updates = RUN.flatMap(l => p.feed(l));
    expect(updates.filter(u => u.type === 'caption').map(u => (u as { text: string }).text)).toEqual([
      "I'll open Notepad.", 'system · open_app…', 'accessibility · invoke…', 'accessibility · read_tree…', 'files · move…', 'Read…',
    ]);
    expect(updates.filter(u => u.type === 'answer')).toEqual([{ type: 'answer', text: 'Notepad is open. It is empty.' }]);
    expect(updates.filter(u => u.type === 'log').map(u => (u as { entry: unknown }).entry)).toEqual([
      { tool: 'system', action: 'open_app', outcome: 'confirmed', line: '[confirmed]' },
      { tool: 'accessibility', action: 'invoke', outcome: 'failed',
        line: '[failed · NOT_FOUND · hint: read the tree first · next: accessibility {"action":"read_tree"}]' },
      { tool: 'accessibility', action: 'read_tree', outcome: 'ok', line: '{"elements":[]}' },
      { tool: 'files', action: 'move', outcome: 'confirmed', line: '[confirmed]' },
      { tool: 'Read', outcome: 'ok', line: 'hello' },
    ]);
    // the calls a shortcut is saved from: server, tool and the full arguments, in order
    expect(p.calls.map(c => [c.server, c.tool, c.args, c.outcome])).toEqual([
      ['clawdcursor', 'system', { action: 'open_app', name: 'Notepad' }, 'confirmed'],
      ['clawdcursor', 'accessibility', { action: 'invoke', name: 'Save' }, 'failed'],
      ['clawdcursor', 'accessibility', { action: 'read_tree' }, 'ok'],
      ['files', 'move', { from: '/a', to: '/b' }, 'confirmed'],
      ['', 'Read', { file_path: '/b' }, 'ok'],
    ]);
    expect(p.resultError).toBe(false);
    expect(updates.filter(u => u.type === 'session')).toEqual([{ type: 'session', id: 's-1' }, { type: 'session', id: 's-1' }]);
    expect(p.sawResult).toBe(true);
  });

  it('says nothing when clawdcursor did not connect: the screen is the last resort', () => {
    const p = new StreamParser();
    const init = (servers: unknown[]) => p.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: servers }));
    const files = { name: 'files', status: 'connected' };
    expect(init([{ name: 'clawdcursor', status: 'failed' }, files])).toEqual([{ type: 'session', id: 's' }]);
    expect(init([files])).toEqual([{ type: 'session', id: 's' }]);
  });

  it('tells a run that used up its steps from any other error', () => {
    const line = '{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns","stop_reason":"tool_use","errors":["Reached maximum number of turns (2)"],"num_turns":3,"session_id":"s"}';
    const p = new StreamParser();
    expect(p.feed(line).filter(u => u.type === 'answer')).toEqual([{ type: 'answer', text: "I couldn't finish that: it took too many steps." }]);
    expect([p.stop, p.resultError, p.sawResult]).toEqual(['max_turns', true, true]);
    const q = new StreamParser();
    q.feed(line.replace('"terminal_reason":"max_turns",', ''));
    expect(q.stop).toBe('max_turns');
    const r = new StreamParser();
    r.feed(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' }));
    expect(r.stop).toBe('completed');
  });

  const say = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const use = (id: string, name: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const got = (id: string, text: string, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: text }] } });
  const end = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' });

  it('on a tier that can step up, holds what the model says until its next step, and never shows the hand-off', () => {
    const p = new StreamParser(true);
    expect(p.feed(say('Looking.'))).toEqual([]);
    expect(p.feed(use('1', 'mcp__files__list_dir'))).toEqual([{ type: 'caption', text: 'Looking.' }, { type: 'caption', text: 'files · list_dir…' }]);
    expect(p.feed(say("I couldn't open Word."))).toEqual([]);
    expect(p.feed(use('2', 'mcp__blob__step_up'))).toEqual([]);
    expect(p.feed(got('2', 'Noted. End your turn now with no reply text.'))).toEqual([]);
    expect(p.calls.map(c => c.tool)).toEqual(['step_up']);                  // still counted: the ladder reads it
    expect(p.feed(say('Sorry.'))).toEqual([]);
    // no model took over (say the user had said No): an empty reply after step_up is not "Done."
    expect(p.feed(end)).toEqual([{ type: 'answer', text: "I couldn't finish that." }]);
    expect(new StreamParser().feed(say('Hello.'))).toEqual([{ type: 'caption', text: 'Hello.' }]);
    expect(new StreamParser().feed(end)).toEqual([{ type: 'answer', text: 'Done.' }]);
  });

  it('marks a call the user decided, from the whole result (a batch has no outcome line)', () => {
    const p = new StreamParser();
    p.feed(use('1', 'mcp__clawdcursor__batch'));
    p.feed(got('1', 'batch: 0/2 completed, halted at step 0\nstep 0: stopped by the user — they took control back, and nothing runs until they give it back.', true));
    p.feed(use('2', 'mcp__files__run'));
    p.feed(got('2', 'Not run.\n[refused · USER_SAID_NO · hint: the user did not agree]'));
    p.feed(use('3', 'Read'));
    p.feed(got('3', 'a line with · STOPPED in a file'));
    expect(p.calls.map(c => c.decided)).toEqual([true, true, undefined]);
  });

  it('reports an error result and ignores lines that are not JSON', () => {
    const p = new StreamParser();
    expect(p.feed('not json')).toEqual([]);
    expect(p.feed(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's' })))
      .toContainEqual({ type: 'answer', text: 'Claude Code stopped (error_during_execution).' });
    expect(p.resultError).toBe(true);
  });

  it('says so when the files server did not connect', () => {
    const p = new StreamParser();
    expect(p.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's',
      mcp_servers: [{ name: 'files', status: 'failed' }] })))                 // also with clawdcursor missing
      .toContainEqual({ type: 'caption', text: "Blob's file tools are failed." });
  });

  it('splits tool names and labels calls', () => {
    expect(splitToolName('mcp__clawdcursor__accessibility')).toEqual({ server: 'clawdcursor', tool: 'accessibility' });
    expect(splitToolName('mcp__files__make_folder')).toEqual({ server: 'files', tool: 'make_folder' });
    expect(splitToolName('Glob')).toEqual({ server: '', tool: 'Glob' });
    expect(callLabel('clawdcursor', 'window', { action: 'focus' })).toEqual({ tool: 'window', action: 'focus' });
    expect(callLabel('files', 'trash', { path: '/x' })).toEqual({ tool: 'files', action: 'trash' });
  });

  it('reads the outcome from the last line only', () => {
    expect(outcomeOf('Typed it.\n[unverified]', false)).toEqual({ outcome: 'unverified', line: '[unverified]' });
    expect(outcomeOf('[refused · PAUSED]', false).outcome).toBe('refused');
    expect(outcomeOf('[confirmed]\nmore text after', false)).toEqual({ outcome: 'ok', line: '[confirmed]' });
    expect(outcomeOf('boom', true)).toEqual({ outcome: 'error', line: 'boom' });
  });
});
