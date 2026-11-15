// Blob's memory file. Temp folder only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FACT, MAX_FILE, facts, forget, matching, memoryBrief, memoryFile, readMemory, remember } from '../src/memory.ts';

let dir = '', file = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-mem-')); file = join(dir, 'memory.md'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('memory', () => {
  it('lives in ~/.blob/memory.md', () => {
    expect(memoryFile({ BLOB_HOME: join('x', 'y') })).toBe(join('x', 'y', 'memory.md'));
  });

  it('starts empty, and remembers facts as plain "- " lines under a short heading', () => {
    expect(facts(file)).toEqual([]);
    expect(memoryBrief(file)).toBe('');
    expect(remember(file, 'Uses Outlook for mail.')).toBe('saved');
    expect(remember(file, '  Lives in\n Dubai  ')).toBe('saved');
    expect(readFileSync(file, 'utf8')).toBe("# Blob's memory\n\nOne fact per line. Edit or delete lines as you like.\n\n- Uses Outlook for mail.\n- Lives in Dubai\n");
    expect(facts(file)).toEqual(['Uses Outlook for mail.', 'Lives in Dubai']);
    expect(memoryBrief(file)).toBe('- Uses Outlook for mail.\n- Lives in Dubai');
  });

  it('does not save the same fact twice, an empty one, or one past the size cap', () => {
    remember(file, 'Uses Outlook for mail.');
    expect(remember(file, 'uses  outlook for MAIL.')).toBe('known');
    expect(remember(file, '- Uses Outlook for mail.')).toBe('known');
    expect(remember(file, '   ')).toBe('empty');
    expect(remember(file, 42)).toBe('empty');
    expect(facts(file)).toHaveLength(1);
    expect(remember(file, 'x'.repeat(MAX_FACT + 1))).toBe('long');      // refused, never cut: what was asked is what is saved
    expect(remember(file, 'Likes <b>tea</b>')).toBe('unsafe');
    expect(facts(file)).toHaveLength(1);
    writeFileSync(file, '- ' + 'y'.repeat(MAX_FILE) + '\n');
    expect(remember(file, 'one more')).toBe('full');
  });

  it('refuses what reads like a password or a key, and keeps a fact that only mentions one', () => {
    for (const s of ['my wifi password is hunter2', 'API key: sk-123', 'The token = abc', 'bank passcode is 1234']) {
      expect(remember(file, s), s).toBe('secret');
    }
    expect(facts(file)).toEqual([]);
    expect(remember(file, 'Keeps passwords in 1Password')).toBe('saved');
  });

  it('keeps what the user wrote by hand, and forgets only matching fact lines', () => {
    writeFileSync(file, '# Mine\r\nsome note\r\n* Likes dark mode\r\n- Uses Outlook for mail\r\n- Uses Chrome\r\n');
    expect(facts(file)).toEqual(['Likes dark mode', 'Uses Outlook for mail', 'Uses Chrome']);
    expect(matching(file, 'USES')).toEqual(['Uses Outlook for mail', 'Uses Chrome']);
    expect(matching(file, 'note')).toEqual([]);                    // not a fact line
    expect(matching(file, '  ')).toEqual([]);
    expect(forget(file, ['Uses Chrome'])).toBe(1);
    expect(readMemory(file)).toBe('# Mine\nsome note\n* Likes dark mode\n- Uses Outlook for mail\n');
    expect(forget(file, ['nothing like it'])).toBe(0);
    remember(file, 'New one');
    expect(facts(file)).toEqual(['Likes dark mode', 'Uses Outlook for mail', 'New one']);
  });

  it('gives the brief the newest facts when they do not all fit', () => {
    for (let i = 1; i <= 9; i++) remember(file, `fact number ${i}`);
    expect(memoryBrief(file, 40)).toBe('- fact number 8\n- fact number 9');
    expect(memoryBrief(file).split('\n')).toHaveLength(9);
  });
});
