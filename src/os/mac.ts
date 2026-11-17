// macOS.
import { posix } from './posix.ts';
import type { Os } from './types.ts';

export const mac: Os = {
  ...posix,
  id: 'darwin',
  name: 'macOS',
  settingsScheme: 'x-apple.systempreferences:',
  dockGap: 90,                                     // a Dock is taller than a taskbar
  topInset: 40,                                    // the menu bar and the notch
  quitHint: 'Cmd+Q on the bubble',
  micSettings: ['open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']],
};
