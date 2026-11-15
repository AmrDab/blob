import { describe, expect, it } from 'vitest';
import { StreamParser, claudeArgs, cleanEnv, clawdcursorCommand, mcpConfig, outcomeOf, userMessage } from '../src/brain.ts';

describe('claude command line', () => {
  it('runs stream-json print mode with clawdcursor as the only tools', () => {
    const a = claudeArgs({ mcpConfigPath: '/tmp/mcp.json', model: 'sonnet' });
    const after = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe('-p');
    expect(after('--input-format')).toBe('stream-json');
    expect(after('--output-format')).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(after('--mcp-config')).toBe('/tmp/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toBe('mcp__clawdcursor__*');
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
    expect(clawdcursorCommand({ PRONTO_CLAWDCURSOR: 'node "C:/dev x/cli.js" mcp --compact' }, 'linux'))
      .toEqual({ command: 'node', args: ['C:/dev x/cli.js', 'mcp', '--compact'] });
    expect(JSON.parse(mcpConfig({}, 'linux'))).toEqual({ mcpServers: { clawdcursor: { type: 'stdio', command: 'clawdcursor', args: ['mcp', '--compact'] } } });
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
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/c', PRONTO_CLAWDCURSOR: 'x',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/c', PRONTO_CLAWDCURSOR: 'x' });
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
  { type: 'result', subtype: 'success', is_error: false, result: 'Notepad is open.\nIt is empty.', session_id: 's-1', total_cost_usd: 0.01 },
].map(e => JSON.stringify(e));

describe('stream-json parsing', () => {
  it('turns a run into captions (step, then answer) and one log entry per clawdcursor call', () => {
    const p = new StreamParser();
    const updates = RUN.flatMap(l => p.feed(l));
    expect(updates.filter(u => u.type === 'caption').map(u => (u as { text: string }).text)).toEqual([
      "I'll open Notepad.", 'system · open_app…', 'accessibility · invoke…', 'accessibility · read_tree…', 'Notepad is open. It is empty.',
    ]);
    expect(updates.filter(u => u.type === 'log').map(u => (u as { entry: unknown }).entry)).toEqual([
      { tool: 'system', action: 'open_app', outcome: 'confirmed', line: '[confirmed]' },
      { tool: 'accessibility', action: 'invoke', outcome: 'failed',
        line: '[failed · NOT_FOUND · hint: read the tree first · next: accessibility {"action":"read_tree"}]' },
      { tool: 'accessibility', action: 'read_tree', outcome: 'ok', line: '{"elements":[]}' },
    ]);
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
      .toContainEqual({ type: 'caption', text: 'Claude Code stopped (error_during_execution).' });
  });

  it('reads the outcome from the last line only', () => {
    expect(outcomeOf('Typed it.\n[unverified]', false)).toEqual({ outcome: 'unverified', line: '[unverified]' });
    expect(outcomeOf('[refused · PAUSED]', false).outcome).toBe('refused');
    expect(outcomeOf('[confirmed]\nmore text after', false)).toEqual({ outcome: 'ok', line: '[confirmed]' });
    expect(outcomeOf('boom', true)).toEqual({ outcome: 'error', line: 'boom' });
  });
});
