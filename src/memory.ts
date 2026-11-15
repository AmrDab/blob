// Blob's memory: ~/.blob/memory.md, one fact per "- " line. A plain file on this computer that the user can read and
// edit. Its facts are added to the AI's brief at each start (persona.ts), so they do reach the AI with every request.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blobHome } from './settings.ts';

export const MAX_FACT = 300;        // characters in one fact
export const MAX_FILE = 16_000;     // characters in the file: remember() refuses past this
export const MAX_BRIEF = 4_000;     // characters of it that go into the brief (the newest facts)

const HEADER = "# Blob's memory\n\nOne fact per line. Edit or delete lines as you like.\n\n";
const SECRET = /\b(pass(word|code|phrase)|pin code|api[ _-]?key|secret|token)s?\b.{0,24}(\bis\b|:|=)/i;

export const memoryFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'memory.md');

export function readMemory(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
}

const same = (a: string) => a.replace(/\s+/g, ' ').trim().toLowerCase();
const isFact = (line: string) => /^\s*[-*]\s+\S/.test(line);
const factOf = (line: string) => line.replace(/^\s*[-*]\s+/, '').trim();

/** The facts, oldest first. */
export function facts(file: string): string[] {
  return readMemory(file).split(/\r?\n/).filter(isFact).map(factOf);
}

/** Adds one fact at the end. 'known': it is there already. 'secret': it reads like a password or key. */
export function remember(file: string, fact: unknown): 'saved' | 'known' | 'secret' | 'empty' | 'full' {
  const f = typeof fact === 'string' ? fact.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '').slice(0, MAX_FACT) : '';
  if (!f) return 'empty';
  if (SECRET.test(f)) return 'secret';
  const text = readMemory(file);
  if (facts(file).some(x => same(x) === same(f))) return 'known';
  if (text.length + f.length > MAX_FILE) return 'full';
  write(file, `${text ? text.replace(/\s*$/, '\n') : HEADER}- ${f}\n`);
  return 'saved';
}

/** The facts that contain `text` (case does not matter). */
export function matching(file: string, text: string): string[] {
  const t = same(text);
  return t ? facts(file).filter(f => same(f).includes(t)) : [];
}

/** Removes those facts' lines; the rest of the file stays as the user wrote it. Returns how many went. */
export function forget(file: string, gone: string[]): number {
  const drop = new Set(gone.map(same));
  const lines = readMemory(file).split(/\r?\n/);
  const kept = lines.filter(l => !(isFact(l) && drop.has(same(factOf(l)))));
  if (kept.length !== lines.length) write(file, kept.join('\n'));
  return lines.length - kept.length;
}

/** What goes into the brief: the facts, newest kept when there are too many to fit. */
export function memoryBrief(file: string, max: number = MAX_BRIEF): string {
  const out: string[] = [];
  let size = 0;
  for (const f of facts(file).reverse()) {
    size += f.length + 3;
    if (size > max) break;
    out.unshift(`- ${f}`);
  }
  return out.join('\n');
}
