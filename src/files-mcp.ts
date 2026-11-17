// Blob's files server (stdio MCP): list_dir, make_folder, move (also renames), trash, open, run (a shell command,
// shell.ts) and the saved scripts (scripts.ts). Claude Code starts it from the --mcp-config Blob writes. Trash goes to the Recycle Bin / Trash, never a permanent delete, and it and a move
// onto an existing file ask the user on the bubble first (No, or no answer in 60 s, refuses).
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { askUser } from './ask.ts';
import { os, osFor } from './os/index.ts';
import { scriptTools, scriptsDir } from './scripts.ts';
import { MAX_COMMAND, runTool, systemExec } from './shell.ts';

export interface FileDeps {
  ask: (question: string) => Promise<boolean>;
  trash: (path: string) => Promise<void>;
  /** Opens a URL or a path in its usual app. */
  launch: (target: string) => Promise<void>;
  /** False when the path is on another machine (a mapped network drive, an NFS or SMB mount). */
  local?: (path: string) => boolean;
  platform?: string;
}
export interface ToolResult { text: string; isError: boolean }

const MAX_LIST = 500;
const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });
/** The files `open` opens: documents, pictures, audio and video. Anything else may be a program, and that is run's to ask about. */
const OPENS = new Set(('pdf txt md rtf csv log json xml doc docx xls xlsx ppt pptx odt ods odp jpg jpeg png gif bmp webp heic tif tiff svg ' +
  'mp3 wav m4a aac flac ogg mp4 mov m4v mkv avi webm').split(' '));
/** What a mail link may carry. */
const MAIL_FIELDS = new Set(['to', 'subject', 'body', 'cc', 'bcc']);

/** A full path from the model's argument: "~" expands, anything relative is refused (there is no useful cwd). */
function fullPath(p: unknown): string | ToolResult {
  if (typeof p !== 'string' || !p.trim()) return failed('NO_PATH', 'pass a full path');
  let s = p.trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(1));
  if (!isAbsolute(s)) return failed('NOT_ABSOLUTE', `"${p}" is not a full path; pass one from the drive or home folder`);
  return resolve(s);
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev && x.ino !== 0n;
  } catch { return false; }
}

export function fileTools(deps: FileDeps) {
  const sys = osFor(deps.platform ?? os.id), bin = sys.trashName;
  return {
    list_dir(a: { path?: unknown }): ToolResult {
      const p = fullPath(a.path);
      if (typeof p !== 'string') return p;
      let entries;
      try { entries = readdirSync(p, { withFileTypes: true }); } catch (e) {
        return failed((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'CANT_READ', `${p}: ${(e as Error).message}`);
      }
      const names = entries
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((x, y) => Number(y.endsWith('/')) - Number(x.endsWith('/')) || x.localeCompare(y));
      if (!names.length) return { text: `${p} is empty.`, isError: false };
      const more = names.length > MAX_LIST ? `\n… and ${names.length - MAX_LIST} more` : '';
      return { text: names.slice(0, MAX_LIST).join('\n') + more, isError: false };
    },

    make_folder(a: { path?: unknown }): ToolResult {
      const p = fullPath(a.path);
      if (typeof p !== 'string') return p;
      if (existsSync(p)) return statSync(p).isDirectory() ? ok(`${p} is already there.`) : failed('EXISTS_AS_FILE', `${p} is a file`);
      try { mkdirSync(p, { recursive: true }); } catch (e) { return failed('CANT_MAKE', (e as Error).message); }
      return ok(`Made ${p}.`);
    },

    async move(a: { from?: unknown; to?: unknown }): Promise<ToolResult> {
      const from = fullPath(a.from);
      if (typeof from !== 'string') return from;
      const to = fullPath(a.to);
      if (typeof to !== 'string') return to;
      if (!existsSync(from)) return failed('NOT_FOUND', `${from} does not exist`);
      if (from === to) return ok('Nothing to move: it is already there.');
      if (!existsSync(dirname(to))) return failed('NO_FOLDER', `${dirname(to)} does not exist; make_folder it first`);
      // A rename that only changes the case (Windows, macOS) is the same file: no replacing, no question.
      if (existsSync(to) && !sameFile(from, to)) {
        if (statSync(to).isDirectory()) {
          return failed('TARGET_IS_FOLDER', `"to" is the full new path; to put it inside that folder use ${join(to, basename(from))}`);
        }
        if (!(await deps.ask(`Replace "${to}" with "${from}"? The old one goes to the ${bin}.`))) {
          return refused('USER_SAID_NO', 'the user did not agree to replace it; ask them what to do instead');
        }
        try { await deps.trash(to); } catch (e) { return failed('TRASH_FAILED', `could not move the old ${to} to the ${bin}: ${(e as Error).message}`); }
      }
      try {
        renameSync(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') return failed('CANT_MOVE', (e as Error).message);
        // Another drive: copy, then remove the original only once the copy is complete.
        try { cpSync(from, to, { recursive: true, errorOnExist: true, force: false }); rmSync(from, { recursive: true }); }
        catch (e2) { return failed('CANT_MOVE', (e2 as Error).message); }
      }
      return ok(`Moved ${from} to ${to}.`);
    },

    async trash(a: { path?: unknown }): Promise<ToolResult> {
      const p = fullPath(a.path);
      if (typeof p !== 'string') return p;
      if (!existsSync(p)) return failed('NOT_FOUND', `${p} does not exist`);
      if (!(await deps.ask(`Move "${p}" to the ${bin}?`))) {
        return refused('USER_SAID_NO', 'the user did not agree; leave it where it is');
      }
      try { await deps.trash(p); } catch (e) { return failed('TRASH_FAILED', (e as Error).message); }
      return ok(`Moved ${p} to the ${bin}.`);
    },

    /** A web, mail or settings link, a folder, or a document: never a program, so there is no question. */
    async open(a: { target?: unknown }): Promise<ToolResult> {
      let target = typeof a.target === 'string' ? a.target.trim() : '';
      if (/^[a-z][a-z0-9+.-]+:/i.test(target)) {       // a URL; two letters at least, so C: is a path
        let url;
        if (/["\s\x00-\x1f]/.test(target)) return failed('BAD_URL', 'a URL has no spaces or quotes: encode them');   // nothing extra for the app's command line
        try { url = new URL(target); } catch { return failed('BAD_URL', `"${target}" is not a URL`); }
        const schemes = ['http:', 'https:', 'mailto:', ...(sys.settingsScheme ? [sys.settingsScheme] : [])];
        if (!schemes.includes(url.protocol)) return refused('SCHEME', 'open only web, mail and settings links');
        // a mail link fills in a new message, nothing more: no attach= of a file from this computer. What opens is
        // rebuilt from what was checked, so a mail app that reads the link another way sees the same fields.
        if (url.protocol === 'mailto:') {
          const fields = [...url.searchParams];
          if (url.hash || fields.some(([k]) => !MAIL_FIELDS.has(k.toLowerCase()))) {
            return refused('MAIL_FIELD', 'a mail link takes only to, subject, body, cc and bcc');
          }
          const e = encodeURIComponent;
          target = `mailto:${e(decodeURIComponent(url.pathname)).replace(/%40/g, '@').replace(/%2C/gi, ',')}` +
            (fields.length ? '?' + fields.map(([k, v]) => `${k.toLowerCase()}=${e(v)}`).join('&') : '');
        }
      } else {
        // a network or device path (\\server\share, \\?\, //host) would reach out to another machine, with the user's sign-in
        if (/^[\\/]{2}/.test(target)) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        const p = fullPath(a.target);
        if (typeof p !== 'string') return p;
        if (/^[\\/]{2}/.test(p)) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        if (!existsSync(p)) return failed('NOT_FOUND', `${p} does not exist`);
        const real = realpathSync(p), ext = extname(real).toLowerCase();   // a link is judged by what it points to
        if (/^[\\/]{2}/.test(real) || deps.local?.(real) === false) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        // a folder can be a program (a Mac .app)
        if (statSync(real).isDirectory() ? !!sys.isProgram?.(real, ext) : !OPENS.has(ext.slice(1))) {
          return refused('NOT_OPENABLE', 'open only folders, documents, pictures, audio and video; a program goes through run, which asks the user first');
        }
        target = p;
      }
      try { await deps.launch(target); } catch (e) { return failed('CANT_OPEN', (e as Error).message); }
      return ok(`Opened ${target}.`);
    },
  };
}

// ── the MCP server ───────────────────────────────────────────────────────────

export async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const tools = fileTools({ ask: q => askUser(q), trash: p => os.trash(p), launch: t => os.open(t), local: p => os.isLocal(p) });
  const server = new McpServer({ name: 'blob-files', version: '0.1.0' });
  const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError });
  const path = z.string().describe('Full path (a leading ~ means the home folder).');
  server.registerTool('list_dir', {
    description: 'List a folder: one name per line, folders end with /.',
    inputSchema: { path }, annotations: { readOnlyHint: true },
  }, async a => reply(tools.list_dir(a)));
  server.registerTool('make_folder', {
    description: 'Make a folder (and any missing parents).',
    inputSchema: { path },
  }, async a => reply(tools.make_folder(a)));
  server.registerTool('move', {
    description: 'Move or rename a file or folder. "to" is the full new path, not a folder to drop it in. ' +
      'If a file is already at "to", the user is asked first; the old one goes to the Recycle Bin / Trash.',
    inputSchema: { from: path, to: path },
  }, async a => reply(await tools.move(a)));
  server.registerTool('trash', {
    description: 'Move a file or folder to the Recycle Bin / Trash (never a permanent delete). The user is asked first.',
    inputSchema: { path }, annotations: { destructiveHint: true },
  }, async a => reply(await tools.trash(a)));
  server.registerTool('open', {
    description: 'Open a web page, a mailto: or settings link, a file or a folder in its usual app. Documents, pictures, audio, video and folders only; a program goes through run.',
    inputSchema: { target: z.string().describe('A URL, or a full path (a leading ~ means the home folder).') },
  }, async a => reply(await tools.open(a)));
  const shell = os.shell.label;
  const shellDeps = { ask: (q: string, detail: string) => askUser(q, { detail }), exec: systemExec };
  server.registerTool('run', {
    description: `Run one ${shell} command in the home folder and get its output. A command that only looks ` +
      '(list, read, search, status, version) runs at once. Anything else is shown to the user word for word with ' +
      `Yes and No first, and runs only on Yes. At most ${MAX_COMMAND} characters. Never put a password, key or token in it.`,
    inputSchema: {
      command: z.string().describe(`The ${shell} command, exactly as it should run.`),
      timeout_s: z.number().optional().describe('Seconds before it is stopped (default 60, at most 600).'),
    },
  }, async a => reply(await runTool(a, shellDeps)));
  const scripts = scriptTools({ ...shellDeps, dir: scriptsDir() });
  const name = z.string().describe('The script\'s name: lower-case letters, digits and dashes ("dark-mode-on").');
  server.registerTool('script_save', {
    description: 'Save a short command that just worked and is worth reusing (a settings toggle, opening a settings page, a ' +
      'status lookup like battery or Wi-Fi), so the next time is one script_run. One purpose per script; never a ' +
      'password, key or token; not a one-off task. Saving runs nothing and asks nothing. The same name replaces the old script.',
    inputSchema: {
      name,
      description: z.string().describe('What it does, in one plain line (120 characters at most).'),
      command: z.string().describe(`The ${shell} command, exactly as it ran (${MAX_COMMAND} characters at most).`),
      consequential: z.boolean().optional().describe('True when it sends, deletes, pays, installs or can\'t be undone: the user is then asked every time.'),
    },
  }, async a => reply(scripts.script_save(a)));
  server.registerTool('script_run', {
    description: 'Run a saved script by name and get its output. One that only looks runs at once. One that changes something ' +
      'is shown to the user with Yes and No the first time, and again only after its text changed; one that deletes, ' +
      'sends, pays or shuts down asks every time.',
    inputSchema: { name },
  }, async a => reply(await scripts.script_run(a)));
  server.registerTool('script_list', {
    description: 'The saved scripts: name, what each does, and whether it changes something.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => reply(scripts.script_list()));
  server.registerTool('script_remove', {
    description: 'Delete a saved script. The user is asked first.',
    inputSchema: { name }, annotations: { destructiveHint: true },
  }, async a => reply(await scripts.script_remove(a)));
  await server.connect(new StdioServerTransport());
}
