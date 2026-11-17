// What Blob does differently from one operating system to the next. Each system fills this in, in its own file here;
// nothing outside src/os/ asks which system it is on (test/os-boundary.test.ts). A member that is optional is one
// that some system does not have.

export interface Os {
  /** Node's name for the system (process.platform). */
  id: string;
  /** The name people know it by. */
  name: string;

  /** The shell the `run` tool and the saved scripts use. */
  shell: {
    /** In a tool's description: "Run one … command". */
    label: string;
    /** In the brief: "the files tool run (…)". */
    name: string;
    /** A saved script's file ending. */
    scriptExt: string;
    /** The brief's examples of commands that only look. */
    looks: string;
  };

  /** How Claude Code is installed, for the user to copy. */
  claudeInstall: string;

  /** Where a trashed file goes, by the name the system shows. */
  trashName: string;
  /** The links that open the system's settings ("ms-settings:"), where it has them. */
  settingsScheme?: string;

  /** How far the bubble starts above the bottom of the screen: clear of the taskbar or the Dock. */
  dockGap: number;
  /** What the top of the screen keeps for itself (a menu bar, a notch). */
  topInset: number;
  /** How the bubble is closed, for the line Blob prints at start. */
  quitHint: string;
  /** The command that opens the microphone's privacy settings. */
  micSettings?: [command: string, args: string[]];
}
