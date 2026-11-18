// What Blob does differently from one operating system to the next. Each system fills this in, in its own file here;
// nothing outside src/os/ asks which system it is on (test/os-boundary.test.ts). A member that is optional is one
// that some system does not have.
import type { Application, BrowserWindow } from '@webviewjs/webview';
import type { Apply } from '../autostart.ts';
import type { Cursor, Win } from '../clickthrough.ts';
import type { LoadApps, Profile, Run } from '../computer.ts';
import type { Bridge } from '../desk.ts';
import type { FocusKeeper } from '../focus.ts';
import type { LauncherDeps } from '../launcher.ts';
import type { Overlay } from '../overlay.ts';
import type { Proc } from '../own-ui.ts';

/** Runs a program to its end; rejects with what it wrote on stderr. */
export type Exec = (cmd: string, args: string[]) => Promise<void>;
/** A program and its arguments. */
export interface Command { command: string; args: string[] }

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
    /** The language a command is written in: which commands only look (shell.ts). */
    dialect: 'powershell' | 'posix';
    /** The program and arguments that run one command. */
    argv(command: string, env: NodeJS.ProcessEnv): [string, string[]];
  };

  /** Whether a child is started at the head of a process group of its own, which is how its whole tree is ended. */
  spawnGroup: boolean;
  /** Ends a process and everything it started. `signal`: what its group is sent, where a group is how. */
  killTree(pid: number, signal: NodeJS.Signals): void;

  /** How a command-line tool npm installed is started, with no shell of Blob's in between. `parts`: its name and arguments. */
  cli(parts: string[]): Command;
  /** How to start Claude Code: `claude`, or its full path when it is installed but not on PATH. */
  findClaude(env: NodeJS.ProcessEnv, home: string, exists: (p: string) => boolean): string;
  /** How to start Codex with no shell in between. */
  findCodex(env: NodeJS.ProcessEnv, fs: { exists(p: string): boolean; read(p: string): string }): Command;
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

  /** Reads this computer's details (computer.ts). Throws when the system's own tools can't be run. The arguments are for tests. */
  readProfile?(exec?: Run, ls?: (dir: string) => string[], home?: string): Promise<Profile>;
  /** The reader of the apps open now, made at the first request; none when it has nothing to name them with. `procs`: this.processes(). */
  openApps?(self: number, procs?: () => Proc[]): LoadApps | undefined;
  /** A lister of every running process, where Blob needs one (its web view's processes, the open apps' names). Undefined when it can't be read. */
  processes?(): (() => Proc[]) | undefined;
  /** A cheap key for the window in front, for the watcher: null for none, or one of Blob's own. Undefined when it can't be read. */
  frontWindow?(): (() => string | null) | undefined;

  /**
   * How the user opens Blob: an entry the system shows, written at every start (launcher.ts). `app`: on macOS Blob is
   * its own app (the microphone is asked for as Blob), so it opens itself through it: now, or once this process is gone.
   * `inApp`: this process is the app's own (it runs the app's copy of Node).
   */
  launcher?: {
    install(d: LauncherDeps): Promise<void>;
    app?: { open(env: NodeJS.ProcessEnv): Promise<boolean>; later(env: NodeJS.ProcessEnv): void; inApp(): boolean };
  };

  /** Starting Blob at sign-in (autostart.ts). `exe`: a path to this Node that lasts, where the one it runs from may not. */
  autostart?: { apply: Apply; exe?(exe: string, path: string): string };

  /**
   * The desk: working an open window in the background, through its controls (desk.ts). Where a system has it, Blob
   * starts the bridge (main.ts), the brain gets the desk server (brain.ts) and the brief names the desk tools (persona.ts).
   */
  desk?: { bridge(o: ConstructorParameters<typeof Bridge>[0]): Bridge };

  /** What the window library has no option for, done once after the first web view is made (mac.ts). `quit`: Blob's own
   *  quit. `reopen`: Blob was opened again (from Spotlight, Finder) while open. */
  appSetup?(app: Pick<Application, 'setMenu'>, quit: () => void, reopen?: () => void): void;
  /** A reader of the cursor, for the bubble's click-through and drag (clickthrough.ts). Undefined when it can't be read. `now` is for tests. */
  cursor?(win: Win, now?: () => number): (() => Cursor) | undefined;
  /** Keeps note of the window (or app) the user was in, to hand the keyboard back to after a click on Blob (focus.ts). `own`: Blob's window. */
  focusKeeper?(own: bigint | number): FocusKeeper;
  /** Leaves a window out of screen captures (overlay.ts). False when the system can't. */
  hideFromCapture(win: BrowserWindow): boolean;
  /** The native side of the pill's window (overlay.ts): left out of captures, and kept from taking the keyboard as far as the system lets it. */
  overlay(win: BrowserWindow): Overlay;
  /** The sound of a reminder, where it is not the pill's own (overlay.ts's beep). */
  reminderSound?(): void;
  /** What the web view reads from the environment when it is made: set for that moment only (main.ts). */
  webviewEnv?: Record<string, string>;

  /**
   * The settings panes of the permissions the user has to switch on before Blob can use the computer, where the
   * system has them: the first-run check asks for them and opens the pane of the one still missing (setup.ts).
   */
  permissionPanes?: { accessibility: string; screenRecording: string };

  /** How far the bubble starts above the bottom of the screen: clear of the taskbar or the Dock. */
  dockGap: number;
  /** What the top of the screen keeps for itself (a menu bar, a notch). */
  topInset: number;
  /** How the bubble is closed, for the line Blob prints at start. */
  quitHint: string;
  /** The command that opens the microphone's privacy settings. */
  micSettings?: [command: string, args: string[]];
  /** The microphone is given to the app Blob was started from, and a refusal comes with no prompt: the page's card says where to switch it on. */
  micOfLauncher?: true;
  /** The keys that send a reply of several lines, as the pill's note names them. */
  sendKey: string;
}
