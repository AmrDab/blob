// macOS.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { macAutostart, stableNode } from '../autostart.ts';
import { posix, run } from './posix.ts';
import type { Os } from './types.ts';

// NSFileManager moves the item itself to the Trash. (Asking Finder would follow a link and trash what it points at,
// and needs the user's OK to control Finder.) isDirectory=false stops NSURL looking at the disk, which would add a
// trailing slash to a link to a folder and so name the folder it points at.
const TRASH = 'function run(a){var e=Ref();if(!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPathIsDirectory(a[0],false),null,e))'
  + 'throw new Error(e[0]?ObjC.unwrap(e[0].localizedDescription):"could not move it to the Trash")}';

/** Folders that are programs. */
const BUNDLES = new Set(['.app', '.workflow', '.bundle', '.pkg', '.mpkg', '.prefpane', '.terminal']);

/** A network share mounts under /Volumes like a disk, so it is the path's mount that says: `df` names it, and a
 *  network one is //user@host/share or host:/path. */
function isLocal(path: string): boolean {
  try {
    const dev = execFileSync('df', ['-P', path], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop()?.split(/\s+/)[0] ?? '';
    return !/^\/\/|^[^/]+:/.test(dev);
  } catch { return false; }
}

export const mac: Os = {
  ...posix,
  id: 'darwin',
  name: 'macOS',
  settingsScheme: 'x-apple.systempreferences:',
  trash: (path, exec = run) => exec('osascript', ['-l', 'JavaScript', '-e', TRASH, path]),
  open: target => run('open', [target]),
  isLocal,
  // an .app, or any bundle with Contents/Info.plist
  isProgram: (dir, ext) => BUNDLES.has(ext) || existsSync(join(dir, 'Contents', 'Info.plist')),
  autostart: { apply: macAutostart, exe: stableNode },
  dockGap: 90,                                     // a Dock is taller than a taskbar
  topInset: 40,                                    // the menu bar and the notch
  quitHint: 'Cmd+Q on the bubble',
  micSettings: ['open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']],
};
