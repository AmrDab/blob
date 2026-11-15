import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';
import { PILL_HOST, StreamParser, callLabel, claudeArgs, cleanEnv, clawdcursorCommand, mcpConfig, outcomeOf, splitToolName, userMessage } from '../src/brain.ts';

describe('claude command line', () => {
  it('runs stream-json print mode with clawdcursor, the files server and the read-only built-ins', () => {
    const a = claudeArgs({ mcpConfigPath: '/tmp/mcp.json', model: 'sonnet' });
    const after = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe('-p');
    expect(after('--input-format')).toBe('stream-json');
    expect(after('--output-format')).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(after('--mcp-config')).toBe('/tmp/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(after('--tools')).toBe('Read,Glob,Grep');
    expect(after('--allowedTools')).toBe('mcp__clawdcursor__*,mcp__files__*,Read,Glob,Grep');
    expect(a.join(' ')).not.toMatch(/Bash|Edit|Write/);
    expect(after('--model')).toBe('sonnet');
    expect(after('--append-system-prompt')).toMatch(/clawdcursor/);
    expect(a).not.toContain('--resume');
  });

  it('leaves the model to Claude Code for Default, and resumes a session', () => {
    const a = claudeArgs({ mcpConfigPath: 'm.json', model: 'default', resume: 'abc-123' });
    expect(a).not.toContain('--model');
    expect(a[a.indexOf('--resume') + 1]).toBe('abc-123');
    expect(claudeArgs({ mcpConfigPath: 'm.json', model: 'haiku' })).toContain('haiku');
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
    expect(clawdcursorCommand({ ...host, BLOB_CLAWDCURSOR: 'node cli.js mcp' }, 'linux')).toEqual({ command: 'node', args: ['cli.js', 'mcp'], env });
    const files = { command: '/usr/bin/node', args: ['/app/dist/files-mcp.mjs'], env: { BLOB_ASK_URL: 'http://127.0.0.1:1/ask', BLOB_ASK_TOKEN: 't' } };
    expect(JSON.parse(mcpConfig(files, host, 'linux'))).toEqual({ mcpServers: {
      clawdcursor: { type: 'stdio', command: 'clawdcursor', args: ['mcp', '--compact'], env },
      files: { type: 'stdio', ...files },
    } });
  });

  it('writes one stream-json user message line', () => {
    const line = userMessage('open notepad');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'open notepad' }] } });
  });
});

describe('env', () => {
  it('drops API keys and host-session variables, keeps the rest', () => {
    const env = cleanEnv({
      PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/c', BLOB_CLAWDCURSOR: 'x',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/c', BLOB_CLAWDCURSOR: 'x' });
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

  it('says so when clawdcursor did not connect', () => {
    const p = new StreamParser();
    const init = (servers: unknown[]) => p.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: servers }));
    expect(init([{ name: 'clawdcursor', status: 'failed' }])).toContainEqual({ type: 'caption', text: 'clawdcursor is failed.' });
    expect(init([])).toContainEqual({ type: 'caption', text: 'Claude Code started without clawdcursor.' });
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
      mcp_servers: [{ name: 'clawdcursor', status: 'connected' }, { name: 'files', status: 'failed' }] })))
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
