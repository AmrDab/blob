// Linux.
import { statfsSync } from 'node:fs';
import { linuxOverlay, protect } from '../overlay.ts';
import { posix, run } from './posix.ts';
import type { Os } from './types.ts';

// statfs types of network filesystems: NFS, SMB, CIFS, SMB2, AFS, Coda, NCP, 9P
const NET_FS = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x5346414f, 0x73757245, 0x564c, 0x01021997]);

export const linux: Os = {
  ...posix,
  id: 'linux',
  name: 'Linux',
  trash: (path, exec = run) => exec('gio', ['trash', '--', path]),
  open: target => run('xdg-open', [target]),
  /** On this computer when it is not on a network mount. */
  isLocal(path) {
    try { return !NET_FS.has(Number(statfsSync(path).type)); } catch { return false; }
  },
  hideFromCapture: protect,
  overlay: linuxOverlay,
  dockGap: 56,
  topInset: 0,
  quitHint: 'close the bubble from the taskbar',
  sendKey: 'Ctrl+Enter',
};
