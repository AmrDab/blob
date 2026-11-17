// Windows.
import type { Os } from './types.ts';

export const win: Os = {
  id: 'win32',
  name: 'Windows',
  shell: {
    label: 'PowerShell',
    name: 'PowerShell',
    scriptExt: '.ps1',
    looks: 'Get-ChildItem, Get-Content, Select-String, Get-Process, Get-Command, Test-Path, winget list, winget search, --version',
  },
  claudeInstall: 'irm https://claude.ai/install.ps1 | iex',
  trashName: 'Recycle Bin',
  settingsScheme: 'ms-settings:',
  dockGap: 56,
  topInset: 0,
  quitHint: 'close the bubble from the taskbar',
  micSettings: ['cmd', ['/c', 'start', '', 'ms-settings:privacy-microphone']],
};
