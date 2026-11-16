// Blob's files server (stdio MCP): list_dir, make_folder, move (also renames), trash, open, and run (a shell command,
// shell.ts). Claude Code starts it from the --mcp-config Blob writes. Trash goes to the Recycle Bin / Trash, never a permanent delete, and it and a move
// onto an existing file ask the user on the bubble first (No, or no answer in 60 s, refuses).
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { askUser } from './ask.ts';
import { MAX_COMMAND, runTool, systemExec } from './shell.ts';

export interface FileDeps {
  ask: (question: string) => Promise<boolean>;
  trash: (path: string) => Promise<void>;
  /** Opens a URL or a path in its usual app. */
  launch: (target: string) => Promise<void>;
  platform?: string;
}
export interface ToolResult { text: string; isError: boolean }

const MAX_LIST = 500;
const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });
const binName = (platform: string) => (platform === 'win32' ? 'Recycle Bin' : 'Trash');
/** The files `open` opens: documents, pictures, audio and video. Anything else may be a program, and that is run's to ask about. */
const OPENS = new Set(('pdf txt md rtf csv log json xml doc docx xls xlsx ppt pptx odt ods odp jpg jpeg png gif bmp webp heic tif tiff svg ' +
  'mp3 wav m4a aac flac ogg mp4 mov m4v mkv avi webm').split(' '));
/** macOS folders that are programs. */
const BUNDLES = new Set(['.app', '.workflow', '.bundle', '.pkg', '.mpkg', '.prefpane', '.terminal']);
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
  const platform = deps.platform ?? process.platform;
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
        if (!(await deps.ask(`Replace "${to}" with "${from}"? The old one goes to the ${binName(platform)}.`))) {
          return refused('USER_SAID_NO', 'the user did not agree to replace it; ask them what to do instead');
        }
        try { await deps.trash(to); } catch (e) { return failed('TRASH_FAILED', `could not move the old ${to} to the ${binName(platform)}: ${(e as Error).message}`); }
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
      if (!(await deps.ask(`Move "${p}" to the ${binName(platform)}?`))) {
        return refused('USER_SAID_NO', 'the user did not agree; leave it where it is');
      }
      try { await deps.trash(p); } catch (e) { return failed('TRASH_FAILED', (e as Error).message); }
      return ok(`Moved ${p} to the ${binName(platform)}.`);
    },

    /** A web, mail or settings link, a folder, or a document: never a program, so there is no question. */
    async open(a: { target?: unknown }): Promise<ToolResult> {
      let target = typeof a.target === 'string' ? a.target.trim() : '';
      if (/^[a-z][a-z0-9+.-]+:/i.test(target)) {       // a URL; two letters at least, so C: is a path
        let url;
        if (/["\s\x00-\x1f]/.test(target)) return failed('BAD_URL', 'a URL has no spaces or quotes: encode them');   // nothing extra for the app's command line
        try { url = new URL(target); } catch { return failed('BAD_URL', `"${target}" is not a URL`); }
        const schemes = ['http:', 'https:', 'mailto:', ...(platform === 'win32' ? ['ms-settings:'] : platform === 'darwin' ? ['x-apple.systempreferences:'] : [])];
        if (!schemes.includes(url.protocol)) return refused('SCHEME', 'open only web, mail and settings links');
        // a mail link fills in a new message, nothing more: no attach= of a file from this computer
        if (url.protocol === 'mailto:' && [...url.searchParams.keys()].some(k => !MAIL_FIELDS.has(k.toLowerCase()))) {
          return refused('MAIL_FIELD', 'a mail link takes only to, subject, body, cc and bcc');
        }
      } else {
        // a network or device path (\\server\share, \\?\, //host) would reach out to another machine, with the user's sign-in
        if (/^[\\/]{2}/.test(target)) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        const p = fullPath(a.target);
        if (typeof p !== 'string') return p;
        if (/^[\\/]{2}/.test(p)) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        if (!existsSync(p)) return failed('NOT_FOUND', `${p} does not exist`);
        const real = realpathSync(p), ext = extname(real).toLowerCase();   // a link is judged by what it points to
        if (/^[\\/]{2}/.test(real)) return refused('NOT_LOCAL', 'open only files and folders on this computer');
        // a Mac folder can be a program (an .app, or any bundle with Contents/Info.plist)
        const program = (d: string) => platform === 'darwin' && (BUNDLES.has(ext) || existsSync(join(d, 'Contents', 'Info.plist')));
        if (statSync(real).isDirectory() ? program(real) : !OPENS.has(ext.slice(1))) {
          return refused('NOT_OPENABLE', 'open only folders, documents, pictures, audio and video; a program goes through run, which asks the user first');
        }
        target = p;
      }
      try { await deps.launch(target); } catch (e) { return failed('CANT_OPEN', (e as Error).message); }
      return ok(`Opened ${target}.`);
    },
  };
}

// ── the OS trash ─────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) =>
  execFile(cmd, args, { windowsHide: true, timeout: 60_000 }, (err, _out, stderr) => (err ? rej(new Error(stderr.trim() || err.message)) : res())));

let shDelete: ((path: string) => { result: number; aborted: boolean }) | undefined;

/** Windows: SHFileOperation with undo (the Recycle Bin); a file that can't be recycled asks first instead of vanishing. */
function windowsTrash(path: string): void {
  if (!shDelete) {
    const koffi = createRequire(import.meta.url)('koffi');
    if (process.arch === 'ia32') throw new Error('32-bit Windows is not supported');
    const OP = koffi.struct('BLOB_SHFILEOPSTRUCTW', {
      hwnd: 'intptr_t', wFunc: 'uint32_t', pFrom: 'const char16_t *', pTo: 'const char16_t *',
      fFlags: 'uint16_t', fAnyOperationsAborted: 'int32_t', hNameMappings: 'void *', lpszProgressTitle: 'const char16_t *',
    });
    const fn = koffi.load('shell32.dll').func('int __stdcall SHFileOperationW(_Inout_ BLOB_SHFILEOPSTRUCTW *op)');
    // FO_DELETE; FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    shDelete = p => {
      const op = { hwnd: 0, wFunc: 3, pFrom: p + '\0', pTo: null, fFlags: 0x40 | 0x10 | 0x4 | 0x400 | 0x4000, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null };
      const result = fn(op);
      return { result, aborted: !!op.fAnyOperationsAborted };
    };
  }
  const r = shDelete(path);
  if (r.aborted) throw new Error('cancelled');
  if (r.result !== 0) throw new Error(`Windows error ${r.result}`);
  if (existsSync(path)) throw new Error('it is still there');
}

export async function osTrash(path: string, platform: string = process.platform): Promise<void> {
  if (platform === 'win32') return windowsTrash(path);
  if (platform === 'darwin') {
    return run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', path]);
  }
  return run('gio', ['trash', '--', path]);
}

let shOpen: ((...a: unknown[]) => unknown) | undefined;

/** Opens a URL or a path in its usual app, with no shell in between. */
export async function osOpen(target: string, platform: string = process.platform): Promise<void> {
  if (platform === 'darwin') return run('open', [target]);
  if (platform !== 'win32') return run('xdg-open', [target]);
  shOpen ??= createRequire(import.meta.url)('koffi').load('shell32.dll')
    .func('intptr_t __stdcall ShellExecuteW(intptr_t hwnd, const char16_t *verb, const char16_t *file, const char16_t *params, const char16_t *dir, int show)');
  const r = shOpen!(0, null, target, null, null, 1);   // SW_SHOWNORMAL; above 32 is success
  if (Number(r) <= 32) throw new Error(`Windows error ${r}`);
}

// ── the MCP server ───────────────────────────────────────────────────────────

export async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const tools = fileTools({ ask: q => askUser(q), trash: p => osTrash(p), launch: t => osOpen(t) });
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
  const shell = process.platform === 'win32' ? 'PowerShell' : 'shell';
  server.registerTool('run', {
    description: `Run one ${shell} command in the home folder and get its output. A command that only looks ` +
      '(list, read, search, status, version) runs at once. Anything else is shown to the user word for word with ' +
      `Yes and No first, and runs only on Yes. At most ${MAX_COMMAND} characters. Never put a password, key or token in it.`,
    inputSchema: {
      command: z.string().describe(`The ${shell} command, exactly as it should run.`),
      timeout_s: z.number().optional().describe('Seconds before it is stopped (default 60, at most 600).'),
    },
  }, async a => reply(await runTool(a, { ask: (q, detail) => askUser(q, { detail }), exec: systemExec })));
  await server.connect(new StdioServerTransport());
}
