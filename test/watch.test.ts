// The learn-only watcher with a fake reader: no clawdcursor, no screen. Temp folder only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Step } from '../src/shortcuts.ts';
import { KEEP_MS, Watcher, clawdcursorReader, hostOf, loadActivity, prune, topActivity, type Front, type Reader } from '../src/watch.ts';

let dir = '';
let file = '';
let front: Front | null = null;
let address: string | null = null;
let busy = false;
let now = 1_000_000_000_000;
let reads = { active: 0, address: 0, closed: 0 };
const reader: Reader = {
  active: async () => { reads.active++; return front; },
  addressBar: async () => { reads.address++; return address; },
  close: async () => { reads.closed++; },
};
/** A watcher with the cheap Windows-style key (the reader is asked only after a change). */
const watcher = () => new Watcher({
  file, reader, busy: () => busy, now: () => now, ownPid: 1,
  front: () => (front ? `${front.pid}|${front.title}` : null),
});
/** Two looks: a change is read once it is still there at the second. */
const settle = async (w: Watcher) => { await w.look(); await w.look(); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blob-watch-'));
  file = join(dir, 'activity.jsonl');
  front = null; address = null; busy = false; now = 1_000_000_000_000;
  reads = { active: 0, address: 0, closed: 0 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('hostOf', () => {
  it('keeps the site and nothing else', () => {
    expect(hostOf('https://mail.example.com/inbox/123?token=abc#x')).toBe('mail.example.com');
    expect(hostOf('www.example.com/path')).toBe('example.com');
    expect(hostOf('user:secret@example.com/private')).toBe('example.com');
    expect(hostOf('localhost:3000/app')).toBe('localhost');
  });

  it('is nothing for a search being typed or an empty bar', () => {
    expect(hostOf('how to bake bread')).toBeUndefined();
    expect(hostOf('bread')).toBeUndefined();
    expect(hostOf('')).toBeUndefined();
    expect(hostOf(null)).toBeUndefined();
  });
});

describe('watcher', () => {
  it('notes a new window only once it has stayed, and reads nothing before that', async () => {
    const w = watcher();
    front = { app: 'Notepad', title: 'notes.txt - Notepad', pid: 10 };
    await w.look();
    expect(reads.active).toBe(0);
    front = { app: 'Calculator', title: 'Calculator', pid: 11 };   // switched away within one look
    await settle(w);
    expect(loadActivity(file)).toEqual([{ t: now, app: 'Calculator', title: 'Calculator' }]);
    expect(reads.active).toBe(1);
  });

  it('does not note the same window twice, and reads nothing while nothing changes', async () => {
    const w = watcher();
    front = { app: 'Notepad', title: 'a', pid: 10 };
    await settle(w); await settle(w); await settle(w);
    expect(loadActivity(file)).toHaveLength(1);
    expect(reads.active).toBe(1);
  });

  it('stores the site of a browser window, never the address', async () => {
    const w = watcher();
    front = { app: 'msedge', title: 'Inbox - Mail', pid: 20 };
    address = 'https://mail.example.com/inbox/123?token=abc';
    await settle(w);
    expect(loadActivity(file)).toEqual([{ t: now, app: 'msedge', title: 'Inbox - Mail', host: 'mail.example.com' }]);
    expect(JSON.stringify(loadActivity(file))).not.toMatch(/token|inbox\/123|https/);
  });

  it('does not read the address bar of other apps', async () => {
    const w = watcher();
    front = { app: 'Notepad', title: 'a', pid: 10 };
    await settle(w);
    expect(reads.address).toBe(0);
  });

  it('does nothing while Blob is doing a task, even one that starts mid-read', async () => {
    const w = watcher();
    busy = true;
    front = { app: 'Notepad', title: 'a', pid: 10 };
    await settle(w); await settle(w);
    expect(reads.active).toBe(0);
    busy = false;
    front = { app: 'chrome', title: 'b', pid: 12 };
    address = 'example.com';
    await w.look();
    const real = reader.addressBar;
    reader.addressBar = async () => { busy = true; return address; };
    await w.look();
    reader.addressBar = real;
    expect(loadActivity(file)).toEqual([]);
  });

  it('skips Blob\'s own windows and private browser windows', async () => {
    const w = watcher();
    front = { app: 'node', title: 'Blob', pid: 1 };
    await settle(w);
    front = { app: 'msedge', title: 'Bank - [InPrivate] - Microsoft Edge', pid: 20 };
    await settle(w);
    expect(loadActivity(file)).toEqual([]);
  });

  it('without a cheap key (macOS) it asks the reader each look, with the same two-look rule', async () => {
    const w = new Watcher({ file, reader, busy: () => busy, now: () => now, ownPid: 1 });
    front = { app: 'Safari', title: 'News', pid: 30 };
    await w.look();
    expect(loadActivity(file)).toEqual([]);
    await w.look(); await w.look();
    expect(loadActivity(file)).toEqual([{ t: now, app: 'Safari', title: 'News' }]);
  });

  it('closes the reader when it fails or the watcher stops, and start/stop are safe to repeat', async () => {
    const w = watcher();
    front = { app: 'Notepad', title: 'a', pid: 10 };
    const real = reader.active;
    reader.active = async () => { throw new Error('gone'); };
    await settle(w);
    reader.active = real;
    expect(reads.closed).toBe(1);
    w.start(); w.start();
    expect(w.running).toBe(true);
    w.stop(); w.stop();
    expect(w.running).toBe(false);
    expect(reads.closed).toBe(2);
  });
});

describe('retention', () => {
  it('keeps 14 days', () => {
    const old = { t: now - KEEP_MS - 1000, app: 'Old', title: 'x' };
    const recent = { t: now - KEEP_MS + 60_000, app: 'Recent', title: 'y' };
    writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\nnot json\n`);
    prune(file, now);
    expect(loadActivity(file)).toEqual([recent]);
  });

  it('prunes as it goes: the first note drops what is too old', async () => {
    writeFileSync(file, JSON.stringify({ t: now - KEEP_MS - 1, app: 'Old', title: 'x' }) + '\n');
    const w = watcher();
    front = { app: 'Notepad', title: 'a', pid: 10 };
    await settle(w);
    expect(loadActivity(file).map(e => e.app)).toEqual(['Notepad']);
  });

  it('summarises the apps and sites most often in front, without titles', () => {
    const e = (app: string, host?: string) => JSON.stringify({ t: now, app, title: 'secret title', ...(host && { host }) });
    writeFileSync(file, [e('msedge', 'example.com'), e('msedge', 'example.com'), e('Notepad'), e('msedge', 'example.org')].join('\n') + '\n');
    expect(topActivity(file, 5, now)).toEqual({ apps: ['msedge (3×)', 'Notepad (1×)'], sites: ['example.com (2×)', 'example.org (1×)'] });
  });
});

describe('the clawdcursor reader', () => {
  it('makes only the two read calls, and reads their answers', async () => {
    const calls: Step[] = [];
    const r = clawdcursorReader({
      call: async step => {
        calls.push(step);
        if (step.tool === 'window') return { text: '{"title":"Inbox","processName":"msedge","appName":"Microsoft Edge","processId":20,"bounds":{"x":0,"y":0,"width":1,"height":1}}', isError: false };
        return { text: '{"name":"Address and search bar","value":"https://example.com/a"}', isError: false };
      },
      close: async () => {},
    });
    expect(await r.active()).toEqual({ app: 'Microsoft Edge', title: 'Inbox', pid: 20 });
    expect(await r.addressBar(20)).toBe('https://example.com/a');
    expect(calls).toEqual([
      { server: 'clawdcursor', tool: 'window', args: { action: 'active' } },
      { server: 'clawdcursor', tool: 'accessibility', args: { action: 'get_value', name: 'Address and search bar', processId: 20 } },
    ]);
  });

  it('is null for no window, an error, or a value that could not be read', async () => {
    const answer = (text: string, isError = false) => clawdcursorReader({ call: async () => ({ text, isError }), close: async () => {} });
    expect(await answer('(no active window)').active()).toBeNull();
    expect(await answer('{"title":"x","processName":"a","processId":1}', true).active()).toBeNull();
    expect(await answer('{"name":"Address and search bar","readable":false,"elementName":"Address and search bar"}').addressBar(1)).toBeNull();
  });
});
