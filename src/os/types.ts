// What Blob does differently from one operating system to the next. Each system fills this in, in its own file here;
// nothing outside src/os/ asks which system it is on (test/os-boundary.test.ts). A member that is optional is one
// that some system does not have.
import type { Apply } from '../autostart.ts';

/** Runs a program to its end; rejects with what it wrote on stderr. */
export type Exec = (cmd: string, args: string[]) => Promise<void>;

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
  /** Moves a file or folder to the trash, never a permanent delete. `exec` is for tests. */
  trash(path: string, exec?: Exec): Promise<void>;
  /** Opens a URL or a path in its usual app, with no shell in between. */
  open(target: string): Promise<void>;
  /** False when the path is on another machine (a mapped network drive, an NFS or SMB mount). */
  isLocal(path: string): boolean;
  /** Whether a folder is a program, where folders can be. `ext`: its ending, lower case. */
  isProgram?(dir: string, ext: string): boolean;

  /** Starting Blob at sign-in (autostart.ts). `exe`: a path to this Node that lasts, where the one it runs from may not. */
  autostart?: { apply: Apply; exe?(exe: string, path: string): string };

  /** How far the bubble starts above the bottom of the screen: clear of the taskbar or the Dock. */
  dockGap: number;
  /** What the top of the screen keeps for itself (a menu bar, a notch). */
  topInset: number;
  /** How the bubble is closed, for the line Blob prints at start. */
  quitHint: string;
  /** The command that opens the microphone's privacy settings. */
  micSettings?: [command: string, args: string[]];
}
