// The files server's logic, on a temp folder, with a fake question and a fake trash (nothing reaches the real
// Recycle Bin or the bubble).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileTools } from '../src/files-mcp.ts';
import { Questions, askUser } from '../src/ask.ts';
import { outcomeOf } from '../src/brain.ts';

let dir = '';
let asked: string[] = [];
let answer = false;
let trashed: string[] = [];
const tools = () => fileTools({
  ask: async q => { asked.push(q); return answer; },
  trash: async p => { trashed.push(p); rmSync(p, { recursive: true }); },
  platform: 'win32',
});
const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pronto-files-'));
  asked = []; trashed = []; answer = false;
  writeFileSync(join(dir, 'a.txt'), 'A');
  writeFileSync(join(dir, 'b.txt'), 'B');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('files tools', () => {
  it('lists a folder, folders first', () => {
    mkdirSync(join(dir, 'zdir'));
    expect(tools().list_dir({ path: dir }).text).toBe('zdir/\na.txt\nb.txt');
    expect(outcome(tools().list_dir({ path: join(dir, 'nope') }))).toBe('failed');
  });

  it('refuses relative paths', () => {
    const r = tools().list_dir({ path: 'Documents' });
    expect(outcome(r)).toBe('failed');
    expect(r.text).toMatch(/NOT_ABSOLUTE/);
  });

  it('makes folders, and confirms one that is already there', () => {
    expect(outcome(tools().make_folder({ path: join(dir, 'x', 'y') }))).toBe('confirmed');
    expect(existsSync(join(dir, 'x', 'y'))).toBe(true);
    expect(outcome(tools().make_folder({ path: join(dir, 'x') }))).toBe('confirmed');
    expect(outcome(tools().make_folder({ path: join(dir, 'a.txt') }))).toBe('failed');
  });

  it('moves and renames without asking when nothing is in the way', async () => {
    mkdirSync(join(dir, 'sub'));
    expect(outcome(await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'sub', 'a2.txt') }))).toBe('confirmed');
    expect(readFileSync(join(dir, 'sub', 'a2.txt'), 'utf8')).toBe('A');
    expect(asked).toEqual([]);
  });

  it('asks before replacing a file: No refuses and changes nothing', async () => {
    const r = await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'b.txt') });
    expect(outcome(r)).toBe('refused');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Replace .*b\.txt.*Recycle Bin/);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('B');
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('on Yes, the old file goes to the trash, then the move happens', async () => {
    answer = true;
    expect(outcome(await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'b.txt') }))).toBe('confirmed');
    expect(trashed).toEqual([join(dir, 'b.txt')]);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('A');
  });

  it('a case-only rename is not a replace', async () => {
    const r = await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'A.txt') });
    expect(outcome(r)).toBe('confirmed');
    expect(asked).toEqual([]);
    expect(trashed).toEqual([]);
  });

  it('will not move onto a folder or into a missing one', async () => {
    mkdirSync(join(dir, 'sub'));
    expect((await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'sub') })).text).toMatch(/TARGET_IS_FOLDER/);
    expect((await tools().move({ from: join(dir, 'a.txt'), to: join(dir, 'none', 'a.txt') })).text).toMatch(/NO_FOLDER/);
    expect((await tools().move({ from: join(dir, 'zz.txt'), to: join(dir, 'c.txt') })).text).toMatch(/NOT_FOUND/);
    expect(asked).toEqual([]);
  });

  it('always asks before the trash: No refuses, Yes trashes', async () => {
    const t = tools();
    expect(outcome(await t.trash({ path: join(dir, 'a.txt') }))).toBe('refused');
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    answer = true;
    expect(outcome(await t.trash({ path: join(dir, 'a.txt') }))).toBe('confirmed');
    expect(trashed).toEqual([join(dir, 'a.txt')]);
    expect(asked).toHaveLength(2);
    expect(outcome(await t.trash({ path: join(dir, 'gone.txt') }))).toBe('failed');
    expect(asked).toHaveLength(2);   // nothing to ask about
  });
});

describe('asking the user', () => {
  it('posts the question with the token and reads the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ yes: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await askUser('Trash it?', { url: 'http://127.0.0.1:1/ask', token: 'tok', fetch })).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:1/ask');
    expect((calls[0].init.headers as Record<string, string>)['x-ask-token']).toBe('tok');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ question: 'Trash it?' });
  });

  it('is No without Pronto, on an error, or on anything but yes:true', async () => {
    expect(await askUser('q', { url: '', token: '' })).toBe(false);
    const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await askUser('q', { url: 'u', token: 't', fetch: reply('{"yes":false}') })).toBe(false);
    expect(await askUser('q', { url: 'u', token: 't', fetch: reply('{"yes":"yes"}') })).toBe(false);
    expect(await askUser('q', { url: 'u', token: 't', fetch: reply('', 403) })).toBe(false);
    expect(await askUser('q', { url: 'u', token: 't', fetch: (async () => { throw new Error('down'); }) as unknown as typeof fetch })).toBe(false);
  });

  it('the host resolves on the click, or No after 60 s', async () => {
    vi.useFakeTimers();
    try {
      const shown: string[] = [], hidden: string[] = [];
      const q = new Questions({ show: (id, text) => shown.push(`${id}:${text}`), hide: id => hidden.push(id) });
      const first = q.ask('Trash a.txt?');
      const second = q.ask('Replace b.txt?');
      expect(shown).toEqual(['1:Trash a.txt?', '2:Replace b.txt?']);
      expect(q.answer('1', true)).toBe(true);
      expect(await first).toBe(true);
      expect(q.answer('1', false)).toBe(false);          // already answered
      vi.advanceTimersByTime(59_999);
      expect(hidden).toEqual(['1']);
      vi.advanceTimersByTime(1);
      expect(await second).toBe(false);
      expect(hidden).toEqual(['1', '2']);
      expect(q.answer('2', true)).toBe(false);           // too late
    } finally { vi.useRealTimers(); }
  });
});
