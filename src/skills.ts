// Blob's saved skills (on the self server): short written recipes for tasks that worked — the steps in order, the
// fastest route, what to avoid — that the model reads and follows the next time, so it copes with another file,
// person or wording. Each is a plain file in ~/.blob/skills that the user can read and edit. skills.json beside them
// holds the description, and the names the user said No to. Nothing is saved without a Yes to the text itself.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from './files-mcp.ts';
import { SECRET, UNSAFE_FACT } from './memory.ts';
import { HIDDEN } from './safe.ts';
import { DEVICE, MAX_DESCRIPTION, MAX_NAME, SLUG } from './scripts.ts';
import { blobHome } from './settings.ts';

export { MAX_DESCRIPTION, MAX_NAME };
/** The Yes card shows the description, a blank line and the recipe, whole: together they fit under MAX_DETAIL (ask.ts). */
export const MAX_STEPS = 450;
export const MAX_READ = 2_000;      // characters of a recipe (the user may have made it longer by hand) that are read back
export const MAX_DECLINED = 50;     // names the user said No to: the newest are kept
export const MAX_BRIEF = 1_500;     // characters of the list that go into the brief

export interface Skill { name: string; description: string }
export interface Skills { saved: Skill[]; declined: string[] }
export interface SkillDeps {
  dir: string;
  /** `detail`: text shown under the question as it is. */
  ask: (question: string, detail?: string) => Promise<boolean>;
}

export const skillsDir = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'skills');
const indexFile = (dir: string) => join(dir, 'skills.json');
const fileOf = (dir: string, name: string) => join(dir, name + '.md');
const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });
const isName = (v: unknown): v is string => typeof v === 'string' && SLUG.test(v) && v.length <= MAX_NAME && !DEVICE.test(v);

function write(file: string, text: string): void {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
}

/** The index; a hand-edited entry that is not one is left out. */
export function loadSkills(dir: string): Skills {
  try {
    const all = JSON.parse(readFileSync(indexFile(dir), 'utf8')) as { saved?: unknown; declined?: unknown };
    return {
      saved: (Array.isArray(all.saved) ? all.saved : []).filter(s => s && isName(s.name) && typeof s.description === 'string')
        .map(s => ({ name: s.name, description: s.description })),
      declined: (Array.isArray(all.declined) ? all.declined : []).filter(isName),
    };
  } catch { return { saved: [], declined: [] }; }
}

function saveSkills(dir: string, all: Skills): void {
  mkdirSync(dir, { recursive: true });
  write(indexFile(dir), JSON.stringify(all, null, 2) + '\n');
}

/** The recipe as it is now (the file may have been edited by hand, in an editor that writes CRLF). */
function textOf(file: string): string | undefined {
  try { return readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim(); } catch { return undefined; }
}

/** What goes into the brief: name and description, as many as fit, and the declined names. */
export function skillsBrief(dir: string, max: number = MAX_BRIEF): Skills {
  const all = loadSkills(dir), saved: Skill[] = [];
  let size = 0;
  for (const s of all.saved) {
    // a hand-edited description can hold anything: nothing that could leave the brief's fence
    const description = s.description.replace(new RegExp(UNSAFE_FACT.source, 'g'), '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    size += s.name.length + description.length + 5;
    if (size > max) break;
    saved.push({ name: s.name, description });
  }
  return { saved, declined: all.declined.slice(-MAX_DECLINED) };
}

export function skillTools(d: SkillDeps) {
  const nameOf = (v: unknown): string | ToolResult => {
    const name = typeof v === 'string' ? v.trim() : '';
    return isName(name) ? name
      : failed('BAD_NAME', `a skill's name is lower-case letters, digits and dashes, at most ${MAX_NAME} characters ("send-weekly-report")`);
  };
  const missing = (name: string) => failed('NOT_FOUND', `there is no saved skill "${name}"; skill_list shows them`);

  return {
    /** Asks first, with the description and the recipe shown as they would be saved. A No to a new skill is kept: that name is not offered again. */
    async skill_save(a: { name?: unknown; description?: unknown; steps?: unknown }): Promise<ToolResult> {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const description = typeof a.description === 'string' ? a.description.replace(/\s+/g, ' ').trim() : '';
      if (!description || description.length > MAX_DESCRIPTION || UNSAFE_FACT.test(description)) {
        return failed('BAD_DESCRIPTION', `say what the skill does in one plain line, at most ${MAX_DESCRIPTION} characters`);
      }
      const steps = typeof a.steps === 'string' ? a.steps.replace(/\r\n/g, '\n').trim() : '';
      if (!steps) return failed('NO_STEPS', 'pass the recipe: what worked, in order, in a few short lines');
      if (steps.length > MAX_STEPS) return failed('TOO_LONG', `the recipe is at most ${MAX_STEPS} characters: keep only what is needed the next time`);
      if (HIDDEN.test(steps)) return failed('HIDDEN_CHARACTERS', 'the recipe has characters that do not show on screen; write it in plain text');
      if (SECRET.test(steps) || SECRET.test(description)) return refused('SECRET', 'a skill never holds a password, code, key or token');
      const all = loadSkills(d.dir), old = all.saved.find(s => s.name === name);
      // a declined name still asks: a No may have been no answer, and the user may ask for it later; the brief keeps
      // the model from offering it again unasked
      if (old && old.description === description && textOf(fileOf(d.dir, name)) === steps) return ok(`The skill "${name}" is saved already.`);
      if (!(await d.ask(`Save "${name}" as a skill?`, `${description}\n\n${steps}`))) {
        // a No to a changed text leaves the saved skill as it was, and its name open to a later correction
        if (!old) try { saveSkills(d.dir, { saved: all.saved, declined: [...all.declined, name].slice(-MAX_DECLINED) }); } catch { /* it may be offered once more */ }
        return refused('USER_SAID_NO', `the user said No (or did not answer); nothing was saved. Do not mention it${old ? '' : ', and do not offer this skill again'}`);
      }
      try {
        const entry: Skill = { name, description };
        mkdirSync(d.dir, { recursive: true });
        write(fileOf(d.dir, name), steps + '\n');     // the file first: an index entry with no file could not be read
        saveSkills(d.dir, { saved: old ? all.saved.map(s => (s === old ? entry : s)) : [...all.saved, entry], declined: all.declined.filter(n => n !== name) });
      } catch (e) { return failed('CANT_SAVE', (e as Error).message); }
      return ok(`Saved the skill "${name}".`);
    },

    /** The recipe: the user's own note, said Yes to or edited by them. */
    skill_read(a: { name?: unknown }): ToolResult {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const entry = loadSkills(d.dir).saved.find(s => s.name === name), text = textOf(fileOf(d.dir, name));
      if (!entry || !text) return missing(name);
      return { text: `${name}: ${entry.description}\n${text.slice(0, MAX_READ)}`, isError: false };
    },

    skill_list(): ToolResult {
      const all = loadSkills(d.dir);
      const saved = all.saved.length ? all.saved.map(s => `${s.name}: ${s.description}`).join('\n') : 'No skills are saved.';
      return { text: saved + (all.declined.length ? `\nThe user said No to: ${all.declined.join(', ')}` : ''), isError: false };
    },

    async skill_remove(a: { name?: unknown }): Promise<ToolResult> {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const all = loadSkills(d.dir), entry = all.saved.find(s => s.name === name);
      if (!entry) return missing(name);
      if (!(await d.ask(`Remove the skill "${name}"?`, entry.description))) return refused('USER_SAID_NO', 'the user did not agree; the skill stays');
      try {
        rmSync(fileOf(d.dir, name), { force: true });
        saveSkills(d.dir, { saved: all.saved.filter(s => s !== entry), declined: all.declined });
      } catch (e) { return failed('CANT_REMOVE', (e as Error).message); }
      return ok(`Removed the skill "${name}".`);
    },
  };
}
