// Reminders and scheduled tasks, in ~/.blob/schedule.json. Local time, no cron: one time, every day, weekdays,
// one weekday a week, or every N minutes. The self server adds and removes them; the host looks every 20 s (tick).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blobHome } from './settings.ts';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = typeof DAYS[number];
export type When =
  | { repeat: 'once'; at: string }                     // "YYYY-MM-DD HH:MM"
  | { repeat: 'daily' | 'weekdays'; time: string }     // "HH:MM"
  | { repeat: 'weekly'; weekday: Day; time: string }
  | { repeat: 'every'; minutes: number };
export type Kind = 'remind' | 'task';
/** `last`: the due time it last fired for (or was skipped for). */
export interface Entry { id: string; kind: Kind; text: string; when: When; created: number; last?: number }

export const MAX_ENTRIES = 50;
export const MAX_TEXT = 500;
/** A task this late is skipped, not run (Blob was closed, or the computer asleep). */
export const LATE_MS = 60 * 60_000;
const MIN_TASK_MINUTES = 5;
const DAY_NAME: Record<Day, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

export const scheduleFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'schedule.json');

const two = (n: number) => String(n).padStart(2, '0');
/** "2026-11-16 09:00", local time. */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function timeOf(s: unknown): [number, number] | null {
  const m = typeof s === 'string' ? s.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? [Number(m[1]), Number(m[2])] : null;
}

/** "YYYY-MM-DD HH:MM" (or with a T) as local time, or null when it is not a real date. */
function atMs(s: unknown): number | null {
  const m = typeof s === 'string' ? s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(:\d{2})?$/) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  return date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60 ? date.getTime() : null;
}

/** The model's `when`, checked. A string is what is wrong with it. */
export function parseWhen(raw: unknown): When | string {
  let w = raw;
  if (typeof w === 'string') { try { w = JSON.parse(w); } catch { return 'when is an object, e.g. {"repeat":"once","at":"2026-01-31 09:00"}'; } }
  if (!w || typeof w !== 'object') return 'when is an object, e.g. {"repeat":"once","at":"2026-01-31 09:00"}';
  const o = w as Record<string, unknown>;
  const fix = (t: [number, number]) => `${two(t[0])}:${two(t[1])}`;
  if (o.repeat === 'once') {
    const t = atMs(o.at);
    return t === null ? 'once needs at: "YYYY-MM-DD HH:MM" (local time, 24-hour)' : { repeat: 'once', at: stamp(t) };
  }
  if (o.repeat === 'daily' || o.repeat === 'weekdays' || o.repeat === 'weekly') {
    const t = timeOf(o.time);
    if (!t) return `${o.repeat} needs time: "HH:MM" (24-hour)`;
    if (o.repeat !== 'weekly') return { repeat: o.repeat, time: fix(t) };
    const day = String(o.weekday ?? '').trim().toLowerCase().slice(0, 3) as Day;
    return DAYS.includes(day) ? { repeat: 'weekly', weekday: day, time: fix(t) } : `weekly needs weekday: one of ${DAYS.join(', ')}`;
  }
  if (o.repeat === 'every') {
    const n = Number(o.minutes);
    return Number.isInteger(n) && n >= 1 && n <= 7 * 24 * 60 ? { repeat: 'every', minutes: n } : 'every needs minutes: a whole number from 1 to 10080';
  }
  return 'repeat is one of once, daily, weekdays, weekly, every';
}

/** "once on 2026-11-16 at 09:00", "every Monday at 09:00", "every 30 minutes". */
export function describe(w: When): string {
  if (w.repeat === 'once') return `once on ${w.at.replace(' ', ' at ')}`;
  if (w.repeat === 'every') return w.minutes === 1 ? 'every minute' : `every ${w.minutes} minutes`;
  if (w.repeat === 'weekly') return `every ${DAY_NAME[w.weekday]} at ${w.time}`;
  return `${w.repeat === 'daily' ? 'every day' : 'Monday to Friday'} at ${w.time}`;
}

/** The day `back` days before (or after, when negative) `now`, at the entry's time, when it is one of its days. */
function onDay(w: Exclude<When, { repeat: 'once' | 'every' }>, now: number, back: number): number | null {
  const [h, m] = timeOf(w.time)!;
  const n = new Date(now);
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back, h, m);
  const day = d.getDay();
  if (w.repeat === 'weekdays' && (day === 0 || day === 6)) return null;
  if (w.repeat === 'weekly' && DAYS[day] !== w.weekday) return null;
  return d.getTime();
}

/** The latest time the entry was due, at or before `now`. Null: not yet. */
export function lastDue(e: Entry, now: number): number | null {
  const w = e.when;
  if (w.repeat === 'once') { const t = atMs(w.at)!; return t <= now ? t : null; }
  if (w.repeat === 'every') {
    const step = w.minutes * 60_000, k = Math.floor((now - e.created) / step);
    return k >= 1 ? e.created + k * step : null;
  }
  for (let back = 0; back <= 7; back++) { const t = onDay(w, now, back); if (t !== null && t <= now) return t; }
  return null;
}

/** The next time it is due after `now`. Null: a one-time entry whose time has passed. */
export function nextDue(e: Entry, now: number): number | null {
  const w = e.when;
  if (w.repeat === 'once') { const t = atMs(w.at)!; return t > now ? t : null; }
  if (w.repeat === 'every') {
    const step = w.minutes * 60_000;
    return e.created + (Math.max(0, Math.floor((now - e.created) / step)) + 1) * step;
  }
  for (let ahead = 0; ahead <= 7; ahead++) { const t = onDay(w, now, -ahead); if (t !== null && t > now) return t; }
  return null;
}

export interface Fire { entry: Entry; due: number; late: boolean }

/**
 * What is due now, each entry once however many times it was missed. `entries` is the list to save: fired entries
 * carry the time they fired for, and a one-time entry that fired is gone.
 */
export function tick(entries: Entry[], now: number): { entries: Entry[]; fire: Fire[] } {
  const fire: Fire[] = [], keep: Entry[] = [];
  for (const e of entries) {
    const due = lastDue(e, now);
    if (due === null || due <= (e.last ?? e.created)) { keep.push(e); continue; }
    fire.push({ entry: e, due, late: now - due > LATE_MS });
    if (e.when.repeat !== 'once') keep.push({ ...e, last: due });
  }
  return { entries: keep, fire };
}

// ── the file ─────────────────────────────────────────────────────────────────

function valid(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return typeof x.id === 'string' && (x.kind === 'remind' || x.kind === 'task') && typeof x.text === 'string'
    && typeof x.created === 'number' && (x.last === undefined || typeof x.last === 'number') && typeof parseWhen(x.when) !== 'string';
}

export function loadSchedule(file: string): Entry[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter(valid).map(e => ({ ...e, when: parseWhen(e.when) as When })) : [];
  } catch { return []; }
}

export function saveSchedule(file: string, entries: Entry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(entries, null, 2));
  renameSync(file + '.tmp', file);
}

/** Adds one and saves. A string is why not. */
export function addEntry(file: string, kind: Kind, text: string, when: When, now: number): Entry | string {
  if (when.repeat === 'once' && atMs(when.at)! <= now) return `that time has passed; it is ${stamp(now)} now`;
  if (kind === 'task' && when.repeat === 'every' && when.minutes < MIN_TASK_MINUTES) return `a task repeats every ${MIN_TASK_MINUTES} minutes at the fastest`;
  const entries = loadSchedule(file);
  if (entries.length >= MAX_ENTRIES) return `there are ${MAX_ENTRIES} already; remove one first`;
  let n = 1;
  while (entries.some(e => e.id === String(n))) n++;
  const entry: Entry = { id: String(n), kind, text, when, created: now };
  saveSchedule(file, [...entries, entry]);
  return entry;
}

export function removeEntry(file: string, id: string): boolean {
  const entries = loadSchedule(file);
  const kept = entries.filter(e => e.id !== id);
  if (kept.length === entries.length) return false;
  saveSchedule(file, kept);
  return true;
}
