// Frequency shortcuts: signatures and the 3-run proposal. Temp folder only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Call } from '../src/brain.ts';
import { frequentTasks, iconFor, record, signature } from '../src/habits.ts';
import type { Shortcut } from '../src/shortcuts.ts';

const cc = (tool: string, args: Record<string, unknown>, outcome = 'confirmed'): Call =>
  ({ server: 'clawdcursor', tool, args, outcome, line: `[${outcome}]` });
const inbox = (): Call[] => [
  cc('window', { action: 'open_app', name: 'Outlook' }),
  cc('accessibility', { action: 'invoke', name: 'Inbox' }),
];
let dir = '';
let file = '';
const run = (calls: Call[], request = 'open my inbox', shortcuts: Shortcut[] = [], ok = true) => record(file, { request, calls, ok }, shortcuts);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-habits-')); file = join(dir, 'habits.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('signature', () => {
  it('is the same for the same steps, whatever the key order, case or spacing', () => {
    const a = signature([{ server: 'clawdcursor', tool: 'window', args: { action: 'open_app', name: 'Outlook' } }]);
    const b = signature([{ server: 'clawdcursor', tool: 'window', args: { name: ' outlook ', action: 'open_app' } }]);
    expect(a).toBe(b);
  });

  it('differs for other arguments or another order', () => {
    const s = (name: string) => ({ server: 'clawdcursor' as const, tool: 'window', args: { action: 'open_app', name } });
    expect(signature([s('Outlook')])).not.toBe(signature([s('Notepad')]));
    expect(signature([s('Outlook'), s('Notepad')])).not.toBe(signature([s('Notepad'), s('Outlook')]));
  });
});

describe('record', () => {
  it('proposes a shortcut on the third fully confirmed run, with a name and an icon', () => {
    expect(run(inbox())).toBeNull();
    expect(run(inbox())).toBeNull();
    const p = run(inbox(), 'Open my inbox');
    expect(p).toMatchObject({ name: 'Open my inbox', icon: 'mail' });
    expect(p!.steps).toHaveLength(2);
  });

  it('counts runs that only differ by a look in between as the same task', () => {
    run(inbox());
    run([inbox()[0], cc('accessibility', { action: 'read_tree' }, 'ok'), inbox()[1]]);
    expect(run(inbox())).not.toBeNull();
  });

  it('offers once: not again after it was proposed, kept or declined', () => {
    run(inbox()); run(inbox());
    expect(run(inbox())).not.toBeNull();
    expect(run(inbox())).toBeNull();
    expect(run(inbox())).toBeNull();
  });

  it('does not propose what is already a shortcut', () => {
    const existing: Shortcut = { id: '1', name: 'Inbox', icon: 'mail', pinned: true, steps: inbox().map(c => ({ server: 'clawdcursor', tool: c.tool, args: c.args })) };
    run(inbox()); run(inbox());
    expect(run(inbox(), 'open my inbox', [existing])).toBeNull();
  });

  it('does not count runs that failed, had an unconfirmed step, or cannot be replayed', () => {
    const fragile = [cc('computer', { action: 'click', x: 10, y: 20 })];
    const unverified = [inbox()[0], cc('accessibility', { action: 'invoke', name: 'Inbox' }, 'unverified')];
    for (let i = 0; i < 4; i++) {
      expect(run(fragile)).toBeNull();
      expect(run(unverified)).toBeNull();
      expect(run(inbox(), 'open my inbox', [], false)).toBeNull();
    }
    expect(run(inbox())).toBeNull();     // the first run that counts
  });

  it('keeps different tasks apart', () => {
    const notepad = () => [cc('window', { action: 'open_app', name: 'Notepad' })];
    run(inbox()); run(notepad(), 'open notepad'); run(inbox()); run(notepad(), 'open notepad');
    expect(run(notepad(), 'open notepad')).toMatchObject({ name: 'open notepad', icon: 'bolt' });
  });

  it('survives a junk file and keeps a bounded history', () => {
    writeFileSync(file, 'junk');
    for (let i = 0; i < 230; i++) run([cc('window', { action: 'open_app', name: `App ${i}` })], `open app ${i}`);
    expect(JSON.parse(readFileSync(file, 'utf8')).runs).toHaveLength(200);
  }, 20_000);   // 230 file writes: about 2 s alone, past the default 5 s while the whole suite runs

  it('lists the tasks asked for more than once', () => {
    run(inbox()); run(inbox(), 'Open my inbox'); run(inbox(), 'something else');
    expect(frequentTasks(file)).toEqual(['open my inbox (2×)']);
  });
});

describe('iconFor', () => {
  it('guesses from the request and the steps, else a bolt', () => {
    expect(iconFor('play my playlist', [])).toBe('music');
    expect(iconFor('go', [{ server: 'clawdcursor', tool: 'window', args: { action: 'open_url', url: 'https://example.com' } }])).toBe('globe');
    expect(iconFor('do the thing', [])).toBe('bolt');
  });
});
