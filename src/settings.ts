// Blob's settings, in ~/.blob/settings.json. There is no settings menu: the user asks Blob, Blob asks back with a
// Yes/No card (self-mcp.ts), and only a Yes lands here. The host reads them and listens for changes.
import { mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MODELS = ['default', 'sonnet', 'haiku', 'opus'] as const;
export type Model = typeof MODELS[number];

export interface Settings {
  model: Model;
  watching: boolean;        // learn from what the user does (watch.ts)
  autoShortcuts: boolean;   // build a shortcut from a task done about 3 times (habits.ts)
  voice: boolean;           // hold the blob and talk
  phonePaired: boolean;     // status only: the host sets it, nobody asks for it
  onboarded: boolean;       // the first-run questions were answered; the host sets it
}
export type Key = keyof Settings;

/** Before the first-run questions: nothing that learns about the user is on until they say Yes. */
export const DEFAULTS: Settings = {
  model: 'sonnet', watching: false, autoShortcuts: true, voice: true, phonePaired: false, onboarded: false,
};

/** What the user can change by asking. The rest is set by the host. */
export const CHANGEABLE = ['model', 'watching', 'autoShortcuts', 'voice'] as const;
/** What the first run asks about (phone pairing is its own step: the QR). */
export const FIRST_RUN = ['watching', 'voice', 'autoShortcuts'] as const;

export const WHAT: Record<Key, string> = {
  model: 'Which Claude model does the work: default, sonnet, haiku or opus. A change applies from the next request.',
  watching: 'Learn only: Blob notes which app, window title and website are in front. No screenshots, no page text. ' +
    'The notes stay on this computer. A short list of the apps and sites you use most goes to Blob\'s AI only when ' +
    'you say Yes to it, asked each time.',
  autoShortcuts: 'When the same task has worked about 3 times, Blob makes a shortcut for it and asks once whether to keep it.',
  voice: 'Hold the blob and talk. Off means typing only.',
  phonePaired: 'Whether a phone is paired (status only; "pair my phone" shows the QR).',
  onboarded: 'Whether the first-run questions were answered (status only).',
};

/** The first-run cards' questions, one per FIRST_RUN key. The card's text is WHAT. */
export const ASK: Record<typeof FIRST_RUN[number], string> = {
  watching: 'Learn from what you do?', voice: 'Talk to Blob?', autoShortcuts: 'Make shortcuts for you?',
};

export const blobHome = (env: NodeJS.ProcessEnv = process.env) => env.BLOB_HOME || join(homedir(), '.blob');
export const settingsFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'settings.json');

/** A value of the key's type, or undefined when it isn't one. "on"/"off" and "yes"/"no" count for the switches. */
export function parseValue(key: Key, v: unknown): Settings[Key] | undefined {
  if (key === 'model') {
    const m = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return (MODELS as readonly string[]).includes(m) ? m as Model : undefined;
  }
  if (typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === 'false' || s === 'off' || s === 'no') return false;
  return undefined;
}

/** The file's settings: anything missing or of the wrong type is the default. */
export function loadSettings(file: string): Settings {
  let data: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw;
  } catch { /* no file yet, or junk */ }
  const out = { ...DEFAULTS } as Record<Key, unknown>;
  for (const k of Object.keys(DEFAULTS) as Key[]) {
    const v = typeof data[k] === typeof DEFAULTS[k] ? parseValue(k, data[k]) : undefined;
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as Settings;
}

export type Listener = (now: Settings, changed: Key[]) => void;

/** The settings of one file. The self server (another process) writes the same file; watch() picks that up. */
export class SettingsStore {
  private now: Settings;
  private listeners = new Set<Listener>();
  private watching = false;

  constructor(readonly file: string = settingsFile()) { this.now = loadSettings(file); }

  get(): Settings { return { ...this.now }; }

  /** Sets one key and saves. Reads the file first, so a change made by the other process is kept. */
  set<K extends Key>(key: K, value: Settings[K]): void {
    const next = { ...loadSettings(this.file), [key]: value };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2));
    renameSync(this.file + '.tmp', this.file);
    this.take(next);
  }

  /** Called with the new settings and the keys that changed. Returns the way to stop listening. */
  onChange(f: Listener): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  /** Reads the file again; listeners hear about what changed. */
  reload(): void { this.take(loadSettings(this.file)); }

  /** Follow changes another process makes to the file (checked once a second). */
  watch(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.file, { interval: 1000, persistent: false }, () => this.reload());
  }

  unwatch(): void {
    if (this.watching) unwatchFile(this.file);
    this.watching = false;
  }

  private take(next: Settings): void {
    const changed = (Object.keys(DEFAULTS) as Key[]).filter(k => next[k] !== this.now[k]);
    this.now = next;
    if (changed.length) for (const f of this.listeners) f(this.get(), changed);
  }
}
