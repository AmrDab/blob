// Frequent tasks become shortcuts. Each finished run is noted in ~/.blob/habits.json; when the same steps have
// worked 3 times, record() hands back a proposal and the host builds the shortcut, pins it and offers "Keep it?" once.
// What can be saved is decided by shortcuts.ts (saveOffer); nothing here repeats those rules.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Call } from './brain.ts';
import { blobHome } from './settings.ts';
import { ICONS } from './shared.ts';
import { nameFrom, saveOffer, type Shortcut, type Step } from './shortcuts.ts';

export const RUNS_FOR_SHORTCUT = 3;
const MAX_RUNS = 200;
const MAX_OFFERED = 200;

/** One finished run. sig is '' unless every step confirmed and the run can be replayed. */
interface Run { t: number; request: string; sig: string }
interface Habits { runs: Run[]; offered: string[] }   // offered: signatures proposed once already (kept or not)
export interface Proposal { sig: string; name: string; icon: string; steps: Step[] }

export const habitsFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'habits.json');

function load(file: string): Habits {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return {
      runs: Array.isArray(d?.runs)
        ? d.runs.filter((r: any) => r && typeof r.t === 'number' && typeof r.request === 'string' && typeof r.sig === 'string')
        : [],
      offered: Array.isArray(d?.offered) ? d.offered.filter((s: unknown) => typeof s === 'string') : [],
    };
  } catch { return { runs: [], offered: [] }; }
}

function save(file: string, h: Habits): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(h));
  renameSync(file + '.tmp', file);
}

/** Arguments in one fixed form: keys in order, text trimmed, single-spaced and lower-cased. */
function normal(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim().toLowerCase();
  if (Array.isArray(v)) return v.map(normal);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, normal(o[k])]));
  }
  return v;
}

/** The same steps in the same order give the same signature. */
export function signature(steps: Pick<Step, 'server' | 'tool' | 'args'>[]): string {
  const text = JSON.stringify(steps.map(s => [s.server, s.tool, normal(s.args)]));
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

const ICON_WORDS: [typeof ICONS[number], RegExp][] = [
  ['mail', /\b(e-?mail|mail|inbox|outlook|gmail)\b/],
  ['music', /\b(music|song|playlist|spotify|play)\b/],
  ['camera', /\b(photo|picture|camera|screenshot|image)\b/],
  ['chat', /\b(chat|message|slack|teams|whatsapp|discord|text)\b/],
  ['cart', /\b(buy|order|cart|shop|amazon)\b/],
  ['gear', /\b(settings?|setup|configure)\b/],
  ['folder', /\b(folder|downloads|documents|desktop)\b/],
  ['file', /\b(file|document|pdf|spreadsheet|note|notes)\b/],
  ['globe', /\b(site|website|web|browser|google|search|https?|www)\b/],
];

/** An icon for a new shortcut, guessed from the words of the request and its steps. */
export function iconFor(request: string, steps: Step[]): string {
  const text = `${request} ${JSON.stringify(steps.map(s => s.args))}`.toLowerCase();
  return ICON_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'bolt';
}

/**
 * Notes a finished run. Returns a proposal the first time the same steps have worked RUNS_FOR_SHORTCUT times, unless
 * there is a shortcut for them already. A signature is proposed once: after that it is never offered again, whether
 * the user kept the shortcut or said No.
 */
export function record(
  file: string,
  run: { request: string; calls: Call[]; ok: boolean },
  shortcuts: Shortcut[],
  now: number = Date.now(),
): Proposal | null {
  const offer = run.ok ? saveOffer(run.calls) : null;
  const steps = offer && 'steps' in offer ? offer.steps : null;
  // The signature is the steps that did something. Looks in between (reads, which never "confirm") vary from run to
  // run and would make the same task look like a new one each time.
  const confirmed = new Set(run.calls.filter(c => c.outcome === 'confirmed').map(c => c.args));
  const acts = steps?.filter(s => confirmed.has(s.args)) ?? [];
  const sig = acts.length ? signature(acts) : '';

  const h = load(file);
  h.runs.push({ t: now, request: nameFrom(run.request), sig });
  h.runs = h.runs.slice(-MAX_RUNS);
  let proposal: Proposal | null = null;
  if (steps && sig && !h.offered.includes(sig) && h.runs.filter(r => r.sig === sig).length >= RUNS_FOR_SHORTCUT) {
    const whole = signature(steps);
    if (!shortcuts.some(s => signature(s.steps) === whole)) {
      proposal = { sig, name: nameFrom(run.request), icon: iconFor(run.request, steps), steps };
    }
    h.offered = [...h.offered, sig].slice(-MAX_OFFERED);
  }
  save(file, h);
  return proposal;
}

/** What the user asks for most, from the noted runs: "open my inbox (4×)". */
export function frequentTasks(file: string, max = 5): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const r of load(file).runs) {
    const key = r.request.toLowerCase();
    const c = count.get(key) ?? { name: r.request, n: 0 };
    c.n++;
    count.set(key, c);
  }
  return [...count.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, max).map(c => `${c.name} (${c.n}×)`);
}
