// Blob's saved scripts (on the files server): short commands that worked once and are worth one call the next time
// (a settings toggle, a status lookup). Each is a plain file in ~/.blob/scripts that the user can read and edit, and
// that file is the text that runs. scripts.json beside them holds the description and what the user said Yes to.
// A script that only looks runs at once; one that changes something asks once per text; a consequential one always asks.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from './files-mcp.ts';
import { SECRET, UNSAFE_FACT } from './memory.ts';
import { os } from './os/index.ts';
import { blobHome } from './settings.ts';
import { classify, execTool, saidNo, unfit, type ShellDeps } from './shell.ts';

export const MAX_NAME = 40;
export const MAX_DESCRIPTION = 120;
export const MAX_BRIEF = 1_500;     // characters of the list that go into the brief

export interface Script {
  name: string;
  description: string;
  /** Set at save: it asks every time. */
  consequential: boolean;
  /** sha256 of the exact text the user last said Yes to. */
  approved?: string;
}

export interface ScriptDeps extends ShellDeps { dir: string }

/** Lower-case words joined by single dashes. (And not a name Windows keeps for a device.) */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
/**
 * Text that deletes, uninstalls, ends, powers off, sends or pays, in PowerShell or sh: such a script asks every time,
 * whatever was said at save. (Format-Table and its kin only lay out text.)
 */
export const CONSEQUENTIAL = new RegExp('\\b(' + [
  'remove', 'delete', 'del', 'erase', 'rm', 'rmdir', 'rd', 'unlink', 'shred', 'wipe', 'truncate', 'uninstall', 'purge',
  'format(?!-(table|list|wide|custom|hex)\\b)', 'mkfs\\S*', 'diskpart', 'dd', 'clear-recyclebin', 'clear-disk', 'empty',
  'shut ?down', 'restart', 'reboot', 'halt', 'poweroff', 'log ?off', 'log ?out', 'stop-computer',
  'sudo', 'su', 'doas', 'runas', 'kill', 'killall', 'pkill', 'taskkill', 'stop-process', 'spps',
  'send', 'mail', 'post', 'pay', 'buy', 'purchase',
].join('|') + ')\\b', 'i');

export const scriptsDir = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'scripts');
const ext = (platform: string) => (platform === 'win32' ? '.ps1' : '.sh');
const indexFile = (dir: string) => join(dir, 'scripts.json');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });

function write(file: string, text: string): void {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
}

/** The index; a hand-edited entry that is not one is left out. */
export function loadScripts(dir: string): Script[] {
  try {
    const all: unknown = JSON.parse(readFileSync(indexFile(dir), 'utf8'));
    if (!Array.isArray(all)) return [];
    return all.filter(s => s && typeof s.name === 'string' && SLUG.test(s.name) && typeof s.description === 'string')
      .map(s => ({ name: s.name, description: s.description, consequential: s.consequential === true, ...(typeof s.approved === 'string' && { approved: s.approved }) }));
  } catch { return []; }
}

function saveScripts(dir: string, all: Script[]): void {
  mkdirSync(dir, { recursive: true });
  write(indexFile(dir), JSON.stringify(all, null, 2) + '\n');
}

/** The script's text as it would run (the file may have been edited by hand, in an editor that writes CRLF). */
function textOf(file: string): string | undefined {
  try { return readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim(); } catch { return undefined; }
}

/** What goes into the brief: name and description, as many as fit. */
export function scriptsBrief(dir: string, max: number = MAX_BRIEF): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  let size = 0;
  for (const s of loadScripts(dir)) {
    // a hand-edited description can hold anything: nothing that could leave the brief's fence
    const description = s.description.replace(new RegExp(UNSAFE_FACT.source, 'g'), '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    size += s.name.length + description.length + 5;
    if (size > max) break;
    out.push({ name: s.name, description });
  }
  return out;
}

export function scriptTools(d: ScriptDeps) {
  const platform = d.platform ?? os.id;
  const fileOf = (name: string) => join(d.dir, name + ext(platform));
  const nameOf = (v: unknown): string | ToolResult => {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!SLUG.test(name) || name.length > MAX_NAME || DEVICE.test(name)) {
      return failed('BAD_NAME', `a script's name is lower-case letters, digits and dashes, at most ${MAX_NAME} characters ("dark-mode-on")`);
    }
    return name;
  };

  return {
    /** Saves the text; runs nothing and asks nothing (the first run of a change asks). */
    script_save(a: { name?: unknown; description?: unknown; command?: unknown; consequential?: unknown }): ToolResult {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const description = typeof a.description === 'string' ? a.description.replace(/\s+/g, ' ').trim() : '';
      if (!description || description.length > MAX_DESCRIPTION || UNSAFE_FACT.test(description)) {
        return failed('BAD_DESCRIPTION', `say what the script does in one plain line, at most ${MAX_DESCRIPTION} characters`);
      }
      const command = typeof a.command === 'string' ? a.command.replace(/\r\n/g, '\n').trim() : '';
      const bad = unfit(command);
      if (bad) return bad;
      if (SECRET.test(command) || SECRET.test(description)) return refused('SECRET', 'a script never holds a password, code, key or token');
      try {
        const all = loadScripts(d.dir), old = all.find(s => s.name === name);
        const entry: Script = { name, description, consequential: a.consequential === true, ...(old?.approved && { approved: old.approved }) };
        mkdirSync(d.dir, { recursive: true });
        write(fileOf(name), command + '\n');      // the file first: an index entry with no file would not run
        saveScripts(d.dir, old ? all.map(s => (s === old ? entry : s)) : [...all, entry]);
      } catch (e) { return failed('CANT_SAVE', (e as Error).message); }
      return { text: `Saved the script "${name}".\n[confirmed]`, isError: false };
    },

    async script_run(a: { name?: unknown }): Promise<ToolResult> {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const all = loadScripts(d.dir), entry = all.find(s => s.name === name), text = textOf(fileOf(name));
      if (!entry || text === undefined) return failed('NOT_FOUND', `there is no saved script "${name}"; script_list shows them`);
      const bad = unfit(text);
      if (bad) return bad;
      const changes = classify(text, platform) === 'ask';
      if (changes) {
        const always = entry.consequential || CONSEQUENTIAL.test(text), hash = sha(text);
        if (always || hash !== entry.approved) {
          if (!(await d.ask(`Run the saved script "${name}"?`, text))) return saidNo();
          // the Yes is for this exact text: an edit to the file asks again
          if (!always) try { saveScripts(d.dir, all.map(s => (s === entry ? { ...entry, approved: hash } : s))); } catch { /* it asks again next time */ }
        }
      }
      return execTool(text, changes, d);
    },

    script_list(): ToolResult {
      const all = loadScripts(d.dir);
      if (!all.length) return { text: 'No scripts are saved.', isError: false };
      return {
        text: all.map(s => {
          const text = textOf(fileOf(s.name));
          const kind = text === undefined ? 'its file is missing'
            : classify(text, platform) === 'read' ? 'only looks'
            : s.consequential || CONSEQUENTIAL.test(text) ? 'changes something, asks every time' : 'changes something';
          return `${s.name}: ${s.description} (${kind})`;
        }).join('\n'),
        isError: false,
      };
    },

    async script_remove(a: { name?: unknown }): Promise<ToolResult> {
      const name = nameOf(a.name);
      if (typeof name !== 'string') return name;
      const all = loadScripts(d.dir);
      if (!all.some(s => s.name === name)) return failed('NOT_FOUND', `there is no saved script "${name}"; script_list shows them`);
      if (!(await d.ask(`Remove the saved script "${name}"?`, ''))) return refused('USER_SAID_NO', 'the user did not agree; the script stays');
      try {
        rmSync(fileOf(name), { force: true });
        saveScripts(d.dir, all.filter(s => s.name !== name));
      } catch (e) { return failed('CANT_REMOVE', (e as Error).message); }
      return { text: `Removed the script "${name}".\n[confirmed]`, isError: false };
    },
  };
}
