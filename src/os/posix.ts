// What macOS and Linux share.
import type { Os } from './types.ts';

export const posix = {
  shell: {
    label: 'shell',
    name: 'the login shell',
    scriptExt: '.sh',
    looks: 'ls, cat, grep, ps, which, --version',
  },
  claudeInstall: 'curl -fsSL https://claude.ai/install.sh | bash',
  trashName: 'Trash',
} satisfies Partial<Os>;
