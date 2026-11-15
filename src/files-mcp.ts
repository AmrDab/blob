// Blob's files server (stdio MCP): list_dir, make_folder, move (also renames) and trash. Claude Code starts it from
// the --mcp-config Blob writes. Trash goes to the Recycle Bin / Trash, never a permanent delete, and it and a move
// onto an existing file ask the user on the bubble first (No, or no answer in 60 s, refuses).
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { askUser } from './ask.ts';

export interface FileDeps {
  ask: (question: string) => Promise<boolean>;
  trash: (path: string) => Promise<void>;
  platform?: string;
}
export interface ToolResult { text: string; isError: boolean }

const MAX_LIST = 500;
const ok = (text: string): ToolResult => ({ text: `${text}\n[confirmed]`, isError: false });
const failed = (code: string, hint: string): ToolResult => ({ text: `[failed · ${code} · hint: ${hint}]`, isError: true });
const refused = (code: string, hint: string): ToolResult => ({ text: `[refused · ${code} · hint: ${hint}]`, isError: true });
const binName = (platform: string) => (platform === 'win32' ? 'Recycle Bin' : 'Trash');

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

// ── the MCP server ───────────────────────────────────────────────────────────

export async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const tools = fileTools({ ask: q => askUser(q), trash: p => osTrash(p) });
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
  await server.connect(new StdioServerTransport());
}
