// The files server's logic, on a temp folder, with a fake question and a fake trash (nothing reaches the real
// Recycle Bin or the bubble).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileTools, osLocal } from '../src/files-mcp.ts';
import { Questions, askUser } from '../src/ask.ts';
import { outcomeOf } from '../src/brain.ts';

let dir = '';
let asked: string[] = [];
let answer = false;
let trashed: string[] = [];
let launched: string[] = [];
let platform = 'win32';
const tools = () => fileTools({
  ask: async q => { asked.push(q); return answer; },
  trash: async p => { trashed.push(p); rmSync(p, { recursive: true }); },
  launch: async t => { launched.push(t); },
  platform,
});
const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blob-files-'));
  asked = []; trashed = []; launched = []; answer = false; platform = 'win32';
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

  it('opens web, mail and settings links as they are, and no other scheme', async () => {
    const r = await tools().open({ target: 'https://example.com/a?b=1&c=2' });
    expect(r.text).toMatch(/\[confirmed\]$/);
    expect(outcome(await tools().open({ target: 'mailto:a@b.c' }))).toBe('confirmed');
    expect(outcome(await tools().open({ target: 'ms-settings:display' }))).toBe('confirmed');
    expect(launched).toEqual(['https://example.com/a?b=1&c=2', 'mailto:a@b.c', 'ms-settings:display']);
    for (const target of ['search-ms:query=x', 'file:///C:/x']) expect((await tools().open({ target })).text).toMatch(/SCHEME/);
    // quotes and spaces would reach the mail app's command line as more arguments
    expect((await tools().open({ target: 'mailto:a@b.c" /a "C:\\secret.txt' })).text).toMatch(/BAD_URL/);
    expect(launched).toHaveLength(3);
    platform = 'linux';
    for (const target of ['ms-settings:display', 'search-ms:query=x', 'file:///C:/x']) {
      const no = await tools().open({ target });
      expect(outcome(no)).toBe('refused');
      expect(no.text).toMatch(/SCHEME/);
    }
    platform = 'darwin';
    expect(outcome(await tools().open({ target: 'x-apple.systempreferences:com.apple.preference.sound' }))).toBe('confirmed');
    expect(launched).toHaveLength(4);
    expect(asked).toEqual([]);                           // never a question: nothing here is a program
  });

  it('opens folders, documents and media, never a program', async () => {
    for (const name of ['x.exe', 'x.lnk', 'x.py', 'x.PDF']) writeFileSync(join(dir, name), '');
    for (const name of ['x.exe', 'x.lnk', 'x.py']) {
      const no = await tools().open({ target: join(dir, name) });
      expect(outcome(no)).toBe('refused');
      expect(no.text).toMatch(/NOT_OPENABLE/);
    }
    expect(outcome(await tools().open({ target: join(dir, 'x.PDF') }))).toBe('confirmed');
    expect(outcome(await tools().open({ target: dir }))).toBe('confirmed');
    expect(launched).toEqual([join(dir, 'x.PDF'), dir]);
    mkdirSync(join(dir, 'X.app'));
    expect(outcome(await tools().open({ target: join(dir, 'X.app') }))).toBe('confirmed');   // only a program on a Mac
    platform = 'darwin';
    expect((await tools().open({ target: join(dir, 'X.app') })).text).toMatch(/NOT_OPENABLE/);
    expect((await tools().open({ target: join(dir, 'gone.pdf') })).text).toMatch(/NOT_FOUND/);
    expect((await tools().open({ target: 'Word' })).text).toMatch(/NOT_ABSOLUTE/);            // an app by name is not a path
    expect(launched).toHaveLength(3);
    mkdirSync(join(dir, 'Plain', 'Contents'), { recursive: true });                       // a bundle by its insides, any name
    writeFileSync(join(dir, 'Plain', 'Contents', 'Info.plist'), '');
    expect((await tools().open({ target: join(dir, 'Plain') })).text).toMatch(/NOT_OPENABLE/);
    expect(launched).toHaveLength(3);
  });

  it('opens nothing on another machine, and no mail link that attaches a file', async () => {
    for (const target of ['\\\\server\\share\\a.pdf', '//server/share/a.pdf', '\\\\?\\C:\\a.pdf', '\\\\.\\pipe\\x']) {
      expect((await tools().open({ target })).text).toMatch(/NOT_LOCAL/);
    }
    for (const target of ['mailto:a@b.c?attach=C:/secret.txt', 'mailto:a@b.c?subject=hi&Attachment=x']) {
      expect((await tools().open({ target })).text).toMatch(/MAIL_FIELD/);
    }
    expect((await tools().open({ target: 'mailto:a@b.c?subject=hi#attach=x' })).text).toMatch(/MAIL_FIELD/);
    // what opens is rebuilt from what was checked: one field per &, each encoded
    expect(outcome(await tools().open({ target: 'mailto:a@b.c,d@e.f?Subject=Hi&body=See+you;attach=x' }))).toBe('confirmed');
    expect(launched).toEqual(['mailto:a@b.c,d@e.f?subject=Hi&body=See%20you%3Battach%3Dx']);
    // a mapped network drive is a path on another machine
    writeFileSync(join(dir, 'z.pdf'), '');
    const t = fileTools({ ask: async () => true, trash: async () => {}, launch: async x => { launched.push(x); }, local: () => false, platform });
    expect((await t.open({ target: join(dir, 'z.pdf') })).text).toMatch(/NOT_LOCAL/);
    expect(launched).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('knows a fixed disk is on this computer', () => {
    expect(osLocal(tmpdir())).toBe(true);
  });

  it('says so when the system could not open it', async () => {
    const t = fileTools({ ask: async () => true, trash: async () => {}, launch: async () => { throw new Error('Windows error 2'); } });
    const r = await t.open({ target: 'https://example.com' });
    expect(outcome(r)).toBe('failed');
    expect(r.text).toMatch(/CANT_OPEN · hint: Windows error 2/);
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

  it('is No without Blob, on an error, or on anything but yes:true', async () => {
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

  it('an offer never holds up a question: it steps aside, comes back after, and no answer is not a No', async () => {
    vi.useFakeTimers();
    try {
      let up: string[] = [];                             // what the bubble shows, oldest first
      const q = new Questions({ show: (id, text) => up.push(`${id}:${text}`), hide: id => { up = up.filter(x => !x.startsWith(`${id}:`)); } });
      const keep = q.offer('Keep it?', 600_000);
      expect(up).toEqual(['1:Keep it?']);
      const trash = q.ask('Trash a.txt?');               // a file question behind the offer
      const replace = q.ask('Replace b.txt?');
      expect(up).toEqual(['2:Trash a.txt?', '3:Replace b.txt?']);   // the questions, in order; the offer is out of their way
      expect(q.answer('2', true)).toBe(true);
      expect(await trash).toBe(true);
      expect(up).toEqual(['3:Replace b.txt?']);
      vi.advanceTimersByTime(60_000);                    // an unanswered question is still No
      expect(await replace).toBe(false);
      expect(up).toEqual(['1:Keep it?']);                // back once no question is open
      vi.advanceTimersByTime(540_000);                   // 10 minutes since it was made
      expect(await keep).toBeNull();
      expect(up).toEqual([]);

      const no = q.offer('Keep it?', 600_000);
      const second = q.offer('Keep that?', 600_000);     // one offer at a time
      expect(up).toEqual(['4:Keep it?']);
      expect(q.answer('4', false)).toBe(true);
      expect(await no).toBe(false);
      expect(up).toEqual(['5:Keep that?']);
      const asked = q.ask('Trash c.txt?');
      expect(up).toEqual(['6:Trash c.txt?']);
      expect(q.answer('5', true)).toBe(true);            // a click that was already on its way to the offer still counts for it
      expect(await second).toBe(true);
      q.answer('6', false);
      expect(await asked).toBe(false);
      expect(up).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
