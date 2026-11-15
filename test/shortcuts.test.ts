import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Call } from '../src/brain.ts';
import { fragileReason, loadShortcuts, nameFrom, saveOffer, saveShortcuts, type Shortcut } from '../src/shortcuts.ts';
import { replay, type Caller } from '../src/replay.ts';

const cc = (tool: string, args: Record<string, unknown>, outcome = 'confirmed'): Call =>
  ({ server: 'clawdcursor', tool, args, outcome, line: `[${outcome}]` });

describe('fragile arguments', () => {
  it('refuses one-session ids and screenshot ids, anywhere in the arguments', () => {
    expect(fragileReason('accessibility', { action: 'invoke', element_id: 'e3', snapshot_id: 's1' })).toMatch(/one session/);
    expect(fragileReason('accessibility', { action: 'set_value', target: { snapshot_id: 's1' }, value: 'x' })).toMatch(/one session/);
    expect(fragileReason('computer', { action: 'click', x: 1, y: 2, space: 'screen', shot: 's3' })).toMatch(/screenshot id/);
  });

  it('refuses image-space coordinates; screen-space ones and the window tool are fine', () => {
    expect(fragileReason('computer', { action: 'click', x: 100, y: 200 })).toMatch(/screenshot/);
    expect(fragileReason('computer', { action: 'click', path: [{ x: 1, y: 2 }] })).toMatch(/screenshot/);
    expect(fragileReason('window', { action: 'resize', x: 0, y: 0, width: 800, height: 600, space: 'image' })).toMatch(/screenshot/);
    expect(fragileReason('computer', { action: 'click', x: 100, y: 200, space: 'screen' })).toBe('');
    expect(fragileReason('window', { action: 'resize', x: 0, y: 0, width: 800, height: 600 })).toBe('');
    expect(fragileReason('system', { action: 'open_file', path: 'C:/notes.txt' })).toBe('');
    expect(fragileReason('accessibility', { action: 'invoke', name: 'Save' })).toBe('');
    expect(fragileReason('computer', { action: 'keys', combo: 'ctrl+s' })).toBe('');
  });

  it('looks inside a batch, as an array or a JSON string', () => {
    const steps = [{ name: 'system', arguments: { action: 'open_app', name: 'Notepad' } }, { name: 'computer', args: { action: 'click', x: 5, y: 5 } }];
    expect(fragileReason('batch', { steps })).toMatch(/screenshot/);
    expect(fragileReason('batch', { steps: JSON.stringify(steps) })).toMatch(/screenshot/);
    expect(fragileReason('batch', { steps: [steps[0]] })).toBe('');
    expect(fragileReason('batch', { steps: [{ name: 'system', arguments: { action: 'pause_for_user', message: 'Sign in' } }] })).toMatch(/asks you/);
    expect(fragileReason('batch', { steps: '{not json' })).toMatch(/could not be read/);
  });
});

describe('save offer', () => {
  it('offers a run whose every step confirmed, as its ordered steps', () => {
    const o = saveOffer([
      cc('system', { action: 'open_app', name: 'Notepad' }),
      cc('accessibility', { action: 'read_tree' }, 'ok'),                       // a read: fine, and kept
      { server: '', tool: 'Read', args: { file_path: '/a' }, outcome: 'ok', line: 'x' },   // a built-in: left out
      { server: 'files', tool: 'move', args: { from: '/a', to: '/b' }, outcome: 'confirmed', line: '[confirmed]' },
      cc('system', { action: 'pause_for_user', message: 'Sign in' }, 'ok'),     // a hand-off: left out
    ]);
    expect(o).toEqual({ steps: [
      { server: 'clawdcursor', tool: 'system', args: { action: 'open_app', name: 'Notepad' } },
      { server: 'clawdcursor', tool: 'accessibility', args: { action: 'read_tree' } },
      { server: 'files', tool: 'move', args: { from: '/a', to: '/b' } },
    ] });
  });

  it('offers nothing when a step did not confirm, or nothing was done', () => {
    for (const bad of ['unverified', 'failed', 'refused', 'error']) {
      expect(saveOffer([cc('system', { action: 'open_app', name: 'X' }), cc('accessibility', { action: 'invoke', name: 'Y' }, bad)])).toBeNull();
    }
    expect(saveOffer([])).toBeNull();
    expect(saveOffer([cc('accessibility', { action: 'read_tree' }, 'ok')])).toBeNull();          // reads only
    expect(saveOffer([{ server: '', tool: 'Glob', args: {}, outcome: 'ok', line: '' }])).toBeNull();
  });

  it('says why when a confirmed run cannot be replayed', () => {
    const o = saveOffer([cc('system', { action: 'open_app', name: 'Paint' }), cc('computer', { action: 'click', x: 10, y: 20 })]);
    expect(o).toEqual({ why: 'step 2 (computer · click) clicks a position read off a screenshot' });
  });

  it('names the offer from the request', () => {
    expect(nameFrom('  open   notepad ')).toBe('open notepad');
    expect(nameFrom('x'.repeat(60))).toHaveLength(40);
  });
});

describe('shortcut store', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('round-trips, and reads a missing or broken file as empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'pronto-test-'));
    const file = join(dir, 'sub', 'shortcuts.json');
    expect(loadShortcuts(file)).toEqual([]);
    const list: Shortcut[] = [{ id: '1', name: 'Notepad', icon: 'file', pinned: true, steps: [{ server: 'clawdcursor', tool: 'system', args: { action: 'open_app', name: 'Notepad' } }] }];
    saveShortcuts(file, list);
    expect(loadShortcuts(file)).toEqual(list);
    writeFileSync(file, '{broken');
    expect(loadShortcuts(file)).toEqual([]);
    writeFileSync(file, JSON.stringify([...list, { id: 2 }, { ...list[0], steps: [{ server: 'other', tool: 'x', args: {} }] }]));
    expect(loadShortcuts(file)).toEqual(list);   // malformed entries are dropped
  });
});

describe('replay', () => {
  const steps = [
    { server: 'clawdcursor' as const, tool: 'system', args: { action: 'open_app', name: 'Notepad' } },
    { server: 'clawdcursor' as const, tool: 'accessibility', args: { action: 'read_tree' } },
    { server: 'clawdcursor' as const, tool: 'accessibility', args: { action: 'invoke', name: 'Save' } },
    { server: 'files' as const, tool: 'move', args: { from: '/a', to: '/b' } },
  ];
  const fake = (replies: { text: string; isError: boolean }[]) => {
    const called: string[] = [];
    const call: Caller = async s => { called.push(`${s.server}.${s.tool}`); const r = replies.shift(); if (!r) throw new Error('no reply'); return r; };
    return { call, called };
  };

  it('runs every step in order when each confirms (a read with no outcome line is fine)', async () => {
    const f = fake([{ text: 'Opened.\n[confirmed]', isError: false }, { text: '{"elements":[]}', isError: false },
      { text: '[confirmed]', isError: false }, { text: 'Moved.\n[confirmed]', isError: false }]);
    const results: string[] = [];
    expect(await replay(steps, f.call, { result: (i, r) => results.push(`${i}:${r.tool}${r.action ? '·' + r.action : ''}:${r.outcome}`) })).toEqual({ ok: true });
    expect(f.called).toEqual(['clawdcursor.system', 'clawdcursor.accessibility', 'clawdcursor.accessibility', 'files.move']);
    expect(results).toEqual(['0:system·open_app:confirmed', '1:accessibility·read_tree:ok', '2:accessibility·invoke:confirmed', '3:files·move:confirmed']);
  });

  it('stops at the first step that does not confirm and says which', async () => {
    for (const line of ['[unverified]', '[failed · NOT_FOUND · hint: x]', '[refused · USER_SAID_NO · hint: y]']) {
      const f = fake([{ text: '[confirmed]', isError: false }, { text: 'ok', isError: false }, { text: `Hmm.\n${line}`, isError: false }]);
      expect(await replay(steps, f.call)).toEqual({ ok: false, at: 2, line });
      expect(f.called).toHaveLength(3);
    }
    const err = fake([{ text: 'boom', isError: true }]);
    expect(await replay(steps, err.call)).toEqual({ ok: false, at: 0, line: 'boom' });
  });

  it('stops when a call throws (server gone, timeout)', async () => {
    const f = fake([{ text: '[confirmed]', isError: false }]);
    const end = await replay(steps, f.call);
    expect(end).toMatchObject({ ok: false, at: 1 });
    expect((end as { line: string }).line).toMatch(/^\[failed · CALL_FAILED · hint: no reply\]$/);
  });
});
