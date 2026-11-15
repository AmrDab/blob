// Reminders and scheduled tasks: the format, when each is due, and what a look (tick) fires. Temp folder only.
// Times are built with local Date parts, so the tests hold in any time zone.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LATE_MS, MAX_ENTRIES, addEntry, describe as say, lastDue, loadSchedule, nextDue, parseWhen, removeEntry, saveSchedule,
  scheduleFile, stamp, tick, type Entry, type When,
} from '../src/schedule.ts';

let dir = '', file = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-sched-')); file = join(dir, 'schedule.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 2026-11-16 is a Monday. */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const entry = (when: When, created: number, more: Partial<Entry> = {}): Entry => ({ id: '1', kind: 'remind', text: 'x', when, created, ...more });
const MIN = 60_000;

describe('when', () => {
  it('takes the five shapes and tidies them', () => {
    expect(parseWhen({ repeat: 'once', at: '2026-11-16T9:05' })).toEqual({ repeat: 'once', at: '2026-11-16 09:05' });
    expect(parseWhen({ repeat: 'daily', time: '7:30' })).toEqual({ repeat: 'daily', time: '07:30' });
    expect(parseWhen({ repeat: 'weekdays', time: '18:00', extra: 1 })).toEqual({ repeat: 'weekdays', time: '18:00' });
    expect(parseWhen({ repeat: 'weekly', weekday: 'Monday', time: '09:00' })).toEqual({ repeat: 'weekly', weekday: 'mon', time: '09:00' });
    expect(parseWhen({ repeat: 'every', minutes: 30 })).toEqual({ repeat: 'every', minutes: 30 });
    expect(parseWhen('{"repeat":"every","minutes":"15"}')).toEqual({ repeat: 'every', minutes: 15 });
  });

  it('says what is wrong with anything else: no cron, no impossible dates', () => {
    for (const bad of [
      null, 'tomorrow', '0 9 * * *', {}, { repeat: 'cron', expr: '0 9 * * *' }, { repeat: 'once' }, { repeat: 'once', at: 'tomorrow 9am' },
      { repeat: 'once', at: '2026-02-30 09:00' }, { repeat: 'once', at: '2026-11-16 25:00' }, { repeat: 'daily', time: '9am' },
      { repeat: 'daily', time: '24:00' }, { repeat: 'weekly', time: '09:00' }, { repeat: 'weekly', weekday: 'someday', time: '09:00' },
      { repeat: 'every', minutes: 0 }, { repeat: 'every', minutes: 1.5 }, { repeat: 'every', minutes: 99999 }, { repeat: 'every' },
    ]) expect(typeof parseWhen(bad), JSON.stringify(bad)).toBe('string');
  });

  it('reads back in plain words', () => {
    expect(say({ repeat: 'once', at: '2026-11-16 09:00' })).toBe('once on 2026-11-16 at 09:00');
    expect(say({ repeat: 'daily', time: '07:30' })).toBe('every day at 07:30');
    expect(say({ repeat: 'weekdays', time: '18:00' })).toBe('Monday to Friday at 18:00');
    expect(say({ repeat: 'weekly', weekday: 'fri', time: '09:00' })).toBe('every Friday at 09:00');
    expect(say({ repeat: 'every', minutes: 30 })).toBe('every 30 minutes');
    expect(stamp(at(16, 9, 5))).toBe('2026-11-16 09:05');
  });
});

describe('due times, in local time', () => {
  it('once: due from its time on, never again after', () => {
    const e = entry({ repeat: 'once', at: '2026-11-16 09:00' }, at(15, 12));
    expect(lastDue(e, at(16, 8, 59))).toBeNull();
    expect(lastDue(e, at(16, 9))).toBe(at(16, 9));
    expect(nextDue(e, at(15, 12))).toBe(at(16, 9));
    expect(nextDue(e, at(16, 9))).toBeNull();
  });

  it('daily: today when the time has come, else yesterday; next is today or tomorrow', () => {
    const e = entry({ repeat: 'daily', time: '09:00' }, at(10, 0));
    expect(lastDue(e, at(16, 8))).toBe(at(15, 9));
    expect(lastDue(e, at(16, 9))).toBe(at(16, 9));
    expect(nextDue(e, at(16, 8))).toBe(at(16, 9));
    expect(nextDue(e, at(16, 9))).toBe(at(17, 9));
  });

  it('weekdays: skips Saturday and Sunday', () => {
    const e = entry({ repeat: 'weekdays', time: '09:00' }, at(10, 0));
    expect(lastDue(e, at(15, 12))).toBe(at(13, 9));               // Sunday noon: Friday's
    expect(nextDue(e, at(13, 10))).toBe(at(16, 9));               // Friday after 9: Monday
    expect(nextDue(e, at(16, 8))).toBe(at(16, 9));
  });

  it('weekly: only its weekday', () => {
    const e = entry({ repeat: 'weekly', weekday: 'mon', time: '09:00' }, at(1, 0));
    expect(lastDue(e, at(18, 12))).toBe(at(16, 9));
    expect(lastDue(e, at(16, 8))).toBe(at(9, 9));
    expect(nextDue(e, at(16, 9))).toBe(at(23, 9));
    expect(nextDue(e, at(14, 9))).toBe(at(16, 9));
  });

  it('every N minutes: counted from when it was made', () => {
    const made = at(16, 9, 7);
    const e = entry({ repeat: 'every', minutes: 30 }, made);
    expect(lastDue(e, made + 29 * MIN)).toBeNull();
    expect(lastDue(e, made + 30 * MIN)).toBe(made + 30 * MIN);
    expect(lastDue(e, made + 95 * MIN)).toBe(made + 90 * MIN);
    expect(nextDue(e, made)).toBe(made + 30 * MIN);
    expect(nextDue(e, made + 95 * MIN)).toBe(made + 120 * MIN);
  });
});

describe('a look at the schedule (tick)', () => {
  it('fires nothing before the time, then each entry once', () => {
    const e = entry({ repeat: 'daily', time: '09:00' }, at(16, 8));
    expect(tick([e], at(16, 8, 59)).fire).toEqual([]);
    const t = tick([e], at(16, 9, 0) + 5000);
    expect(t.fire).toEqual([{ entry: e, due: at(16, 9), late: false }]);
    expect(t.entries).toEqual([{ ...e, last: at(16, 9) }]);
    expect(tick(t.entries, at(16, 9, 1)).fire).toEqual([]);         // the next look: already fired
    expect(tick(t.entries, at(17, 9)).fire).toHaveLength(1);        // tomorrow
  });

  it('does not fire for a time that passed before it was made', () => {
    const e = entry({ repeat: 'daily', time: '09:00' }, at(16, 10));
    expect(tick([e], at(16, 11)).fire).toEqual([]);
    expect(tick([e], at(17, 9)).fire).toHaveLength(1);
  });

  it('drops a one-time entry once it fired', () => {
    const e = entry({ repeat: 'once', at: '2026-11-16 09:00' }, at(15, 12));
    const t = tick([e], at(16, 9, 0));
    expect(t.fire).toHaveLength(1);
    expect(t.entries).toEqual([]);
  });

  it('missed while Blob was closed: once, however many were missed; late when over an hour', () => {
    const e = entry({ repeat: 'every', minutes: 30 }, at(16, 9), { kind: 'task' });
    const t = tick([e], at(16, 15, 10));                            // 12 were missed; the last was due at 15:00
    expect(t.fire).toEqual([{ entry: e, due: at(16, 15), late: false }]);
    const daily = entry({ repeat: 'daily', time: '09:00' }, at(10, 0), { kind: 'task', last: at(13, 9) });
    expect(tick([daily], at(16, 9, 59)).fire[0]).toMatchObject({ due: at(16, 9), late: false });
    expect(tick([daily], at(16, 10, 1)).fire[0]).toMatchObject({ due: at(16, 9), late: true });
    expect(tick([daily], at(16, 10, 1)).entries[0].last).toBe(at(16, 9));   // a skipped one is not due again
    expect(LATE_MS).toBe(60 * MIN);
  });
});

describe('the file', () => {
  it('lives in ~/.blob/schedule.json', () => {
    expect(scheduleFile({ BLOB_HOME: join('x', 'y') })).toBe(join('x', 'y', 'schedule.json'));
  });

  it('adds with the lowest free id, lists, and removes', () => {
    const now = at(16, 8);
    const a = addEntry(file, 'remind', 'call mum', { repeat: 'once', at: '2026-11-16 09:00' }, now) as Entry;
    const b = addEntry(file, 'task', 'check mail', { repeat: 'weekdays', time: '09:00' }, now) as Entry;
    expect([a.id, b.id]).toEqual(['1', '2']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      { id: '1', kind: 'remind', text: 'call mum', when: { repeat: 'once', at: '2026-11-16 09:00' }, created: now },
      { id: '2', kind: 'task', text: 'check mail', when: { repeat: 'weekdays', time: '09:00' }, created: now },
    ]);
    expect(removeEntry(file, '1')).toBe(true);
    expect(removeEntry(file, '1')).toBe(false);
    expect((addEntry(file, 'remind', 'again', { repeat: 'daily', time: '10:00' }, now) as Entry).id).toBe('1');
    expect(loadSchedule(file).map(e => e.id)).toEqual(['2', '1']);
  });

  it('refuses a time that has passed, a task faster than every 5 minutes, and more than the cap', () => {
    const now = at(16, 9);
    expect(addEntry(file, 'remind', 'x', { repeat: 'once', at: '2026-11-16 09:00' }, now)).toMatch(/has passed; it is 2026-11-16 09:00 now/);
    expect(addEntry(file, 'task', 'x', { repeat: 'every', minutes: 1 }, now)).toMatch(/5 minutes/);
    expect(typeof addEntry(file, 'remind', 'x', { repeat: 'every', minutes: 1 }, now)).toBe('object');
    saveSchedule(file, Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ repeat: 'daily', time: '09:00' }, now, { id: String(i + 1) })));
    expect(addEntry(file, 'remind', 'x', { repeat: 'daily', time: '09:00' }, now)).toMatch(/remove one first/);
  });

  it('tolerates junk: a broken file and entries that are not entries', () => {
    expect(loadSchedule(file)).toEqual([]);
    writeFileSync(file, '{ nope');
    expect(loadSchedule(file)).toEqual([]);
    writeFileSync(file, JSON.stringify([{ id: '1' }, 5, { id: '2', kind: 'remind', text: 'ok', when: { repeat: 'daily', time: '9:00' }, created: 1 },
      { id: '3', kind: 'task', text: 'bad when', when: { repeat: 'cron' }, created: 1 }]));
    expect(loadSchedule(file)).toEqual([{ id: '2', kind: 'remind', text: 'ok', when: { repeat: 'daily', time: '09:00' }, created: 1 }]);
  });
});
