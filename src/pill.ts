// clawdcursor's on-screen pill and its "waiting for you" card, drawn by Blob. clawdcursor starts the relay
// (pill-host.ts) in place of its own pill and speaks the pill's line protocol to it: the mode in the environment,
// commands on stdin, answers on stdout. This file is that protocol (no Node imports: the page bundles it too).

export interface PillInput { placeholder?: string; multiline?: boolean }

export type PillState =
  | { mode: 'running'; activity: string }
  | { mode: 'paused'; message: string; app: string; choices: string[]; input: PillInput | null; sound: boolean };

const MAX_CHOICES = 6;

function json(s: string | undefined): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** What the pill starts as, from the environment clawdcursor gives it (overlayEnv). */
export function pillState(env: Record<string, string | undefined>): PillState {
  if (env.CLAWD_BANNER_MODE !== 'paused') return { mode: 'running', activity: env.CLAWD_BANNER_ACTIVITY?.trim() || 'Working' };
  const list = json(env.CLAWD_BANNER_CHOICES);
  const cfg = json(env.CLAWD_BANNER_INPUT) as PillInput | undefined;
  const input = cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    ? { ...(typeof cfg.placeholder === 'string' && cfg.placeholder ? { placeholder: cfg.placeholder } : {}), ...(cfg.multiline === true ? { multiline: true } : {}) }
    : null;
  return {
    mode: 'paused',
    message: (env.CLAWD_BANNER_MESSAGE ?? '').replace(/^The agent says: /, ''),   // Blob is the one asking
    app: env.CLAWD_BANNER_APP?.trim() ?? '',
    choices: Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string' && c.length > 0).slice(0, MAX_CHOICES) : [],
    input,
    sound: env.CLAWD_PAUSE_SOUND !== '0',
  };
}

export type PillCommand = { type: 'hide'; ms: number } | { type: 'activity'; text: string };

/** One stdin line from clawdcursor: `HIDE <ms>` (step aside for a click, 50 ms to 10 s) or `ACTIVITY <text>`. */
export function parseCommand(line: string): PillCommand | null {
  const l = line.trim();
  const hide = /^HIDE (\d+)$/.exec(l);
  if (hide) return { type: 'hide', ms: Math.max(50, Math.min(Number(hide[1]), 10_000)) };
  if (l.startsWith('ACTIVITY ')) {
    const text = l.slice(9).trim();
    return text ? { type: 'activity', text } : null;
  }
  return null;
}

export type PillAnswer =
  | { kind: 'stop' }                      // the running pill's Stop, or a double-click on it
  | { kind: 'resume' } | { kind: 'end' }
  | { kind: 'choice'; index: number }     // only the index crosses: clawdcursor looks the text up itself
  | { kind: 'reply'; text: string }       // the reply box, or "Something else"
  | { kind: 'refocus' };                  // Esc in the reply box: the keyboard back to the user's window

function b64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The stdout line for an answer; null when the pill in this state has no such answer. */
export function answerLine(a: PillAnswer, state: PillState): string | null {
  if (a.kind === 'stop') return state.mode === 'running' ? 'BANNER_STOP' : null;
  if (state.mode !== 'paused') return null;
  switch (a.kind) {
    case 'resume': return 'BANNER_RESUME';
    case 'end': return 'BANNER_END';
    case 'refocus': return 'BANNER_REFOCUS';
    case 'choice': return Number.isInteger(a.index) && a.index >= 0 && a.index < state.choices.length ? `BANNER_CHOICE ${a.index}` : null;
    case 'reply': {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      return text ? `BANNER_REPLY ${b64(text)}` : null;   // base64, so a typed newline can't pose as another answer
    }
  }
  return null;
}
