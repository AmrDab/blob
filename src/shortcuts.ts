// Shortcuts: a run whose every step confirmed, saved as its ordered tool calls and replayed later with no model.
// Stored in ~/.pronto/shortcuts.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Call } from './brain.ts';

export interface Step { server: 'clawdcursor' | 'files'; tool: string; args: Record<string, unknown> }
export interface Shortcut { id: string; name: string; icon: string; pinned: boolean; steps: Step[] }


const BAD = new Set(['unverified', 'refused', 'failed', 'error']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why these args won't mean the same thing on a later day, or '' when they will. */
export function fragileReason(tool: string, args: Record<string, unknown>): string {
  const keys = new Set<string>();
  const imageSpace = { found: false };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      if (k === 'space' && x === 'image') imageSpace.found = true;
      walk(x);
    }
  };
  walk(args);
  if (keys.has('snapshot_id') || keys.has('element_id')) return 'points at an element by an id that only lasts one session';
  if (keys.has('shot')) return 'uses a screenshot id';
  if (imageSpace.found) return 'uses a position read off a screenshot';
  // Pointer coordinates default to screenshot pixels (clawdcursor's computer tool); only space:"screen" is stable.
  // `window` takes screen units by default. Anything else with x/y or a point path and no space:"screen" is treated
  // as image-space (a string `path` is a file path, as in open_file).
  if (tool !== 'window' && ('x' in args || 'y' in args || Array.isArray(args.path)) && args.space !== 'screen') {
    return 'clicks a position read off a screenshot';
  }
  if (tool === 'batch') {
    let steps = args.steps;
    if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { return 'has a batch that could not be read'; } }
    if (!Array.isArray(steps)) return 'has a batch that could not be read';
    for (const s of steps) {
      if (!isObj(s) || typeof s.name !== 'string') return 'has a batch that could not be read';
      const a = isObj(s.arguments) ? s.arguments : isObj(s.args) ? s.args : {};
      if (a.action === 'pause_for_user') return 'asks you something part-way';
      const why = fragileReason(s.name, a);
      if (why) return why;
    }
  }
  return '';
}

const isPause = (c: { server: string; tool: string; args: Record<string, unknown> }) =>
  c.server === 'clawdcursor' && c.tool === 'system' && c.args.action === 'pause_for_user';

/**
 * What to offer after a run. null: nothing (a step didn't confirm, or nothing was done).
 * { steps }: it can be saved. { why }: every step confirmed, but one can't be replayed.
 * Counted: clawdcursor and files calls. "ok" (a read with no outcome line) is fine; at least one must be "confirmed".
 * Claude Code's built-in reads are left out (no model replays them); so are pause_for_user hand-offs.
 */
export function saveOffer(calls: Call[]): { steps: Step[] } | { why: string } | null {
  const mine = calls.filter(c => c.server === 'clawdcursor' || c.server === 'files');
  if (!mine.some(c => c.outcome === 'confirmed')) return null;
  if (mine.some(c => BAD.has(c.outcome))) return null;
  const steps: Step[] = [];
  for (const c of mine) {
    if (isPause(c)) continue;
    const why = c.server === 'clawdcursor' ? fragileReason(c.tool, c.args) : '';
    if (why) return { why: `step ${steps.length + 1} (${c.tool}${typeof c.args.action === 'string' ? ' · ' + c.args.action : ''}) ${why}` };
    steps.push({ server: c.server as Step['server'], tool: c.tool, args: c.args });
  }
  return steps.length ? { steps } : null;
}

/** The name a save offer starts with: the request, trimmed to fit. */
export function nameFrom(request: string): string {
  const t = request.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 39).trimEnd() + '…' : t;
}

function valid(s: unknown): s is Shortcut {
  return isObj(s) && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.icon === 'string'
    && typeof s.pinned === 'boolean' && Array.isArray(s.steps)
    && s.steps.every(x => isObj(x) && (x.server === 'clawdcursor' || x.server === 'files') && typeof x.tool === 'string' && isObj(x.args));
}

export function loadShortcuts(file: string): Shortcut[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter(valid) : [];
  } catch { return []; }
}

/** Written to a temp file first, so a crash mid-write never leaves half a file. */
export function saveShortcuts(file: string, list: Shortcut[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(list, null, 2));
  renameSync(file + '.tmp', file);
}
