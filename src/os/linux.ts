// Linux.
import { posix } from './posix.ts';
import type { Os } from './types.ts';

export const linux: Os = {
  ...posix,
  id: 'linux',
  name: 'Linux',
  dockGap: 56,
  topInset: 0,
  quitHint: 'close the bubble from the taskbar',
};
