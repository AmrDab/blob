// The model ladder for the "auto" setting: a request starts on Haiku; Sonnet, then Opus, take over when the model
// before got stuck. Blob steps up only after a run has ended by itself, never by cutting one off.
import type { BrainName, Model } from './settings.ts';
import type { Call } from './brain.ts';

export type Tier = Exclude<Model, 'auto'>;
/** The step budget of a tier that can step up (--max-turns). */
export const MAX_TURNS: Partial<Record<Tier, number>> = { haiku: 12, sonnet: 30 };
const NEXT: Partial<Record<Tier, Tier>> = { haiku: 'sonnet', sonnet: 'opus' };
const FAILS = 3;                                    // this many failed steps is "stuck"

export const firstTier = (m: Model): Tier => (m === 'auto' ? 'haiku' : m);

/**
 * The user said No, pressed Stop or took the screen back: a stronger model must not carry on. `text` is the call's
 * whole result: a clawdcursor batch has no outcome line, only its steps' own words.
 */
export function userDecided(server: string, text: string): boolean {
  if (server !== 'clawdcursor' && server !== 'files' && server !== 'blob' && server !== 'desk') return false;
  if (server === 'desk') text = text.trim().split('\n').pop() ?? '';   // a desk read carries an app's own text: only Blob's last line counts
  if (/· (USER_SAID_NO|STOPPED|NOT_CONFIRMED|PAUSED)\b/.test(text)) return true;
  // Stop on the pill, a confirm the user turned down, and a pause the user ended or that ran out
  return server === 'clawdcursor' && /stopped by the user — they took control back|not confirmed: confirm mode|"status"\s*:\s*"(ended|timed_out)"/.test(text);
}

/** The model asked for the next tier. */
export const askedUp = (c: { server: string; tool: string }): boolean => c.server === 'blob' && c.tool === 'step_up';

/** A step that went wrong. Looking around and finding nothing (list_dir, a command's exit code) is not one. */
function failure(c: Call): boolean {
  if (c.server !== 'clawdcursor' && c.server !== 'files' && c.server !== 'desk') return false;
  if (c.outcome !== 'failed' && c.outcome !== 'error' && c.outcome !== 'refused') return false;
  // the desk saying "go to the screen", "tell the user" or "not allowed": a stronger model would hear the same
  if (c.server === 'desk' && /· (NO_PATTERN|NOT_IN_BACKGROUND|EMPTY|DID_NOTHING|NOT_RESPONDING|BRIDGE|NOT_FOUND|AMBIGUOUS|ELEVATED|PASSWORD|AI_HOST|OWN_UI|NOT_APP)\b/.test(c.line)) return false;
  if (c.server === 'files' && c.tool === 'list_dir') return false;
  return !(c.server === 'files' && (c.tool === 'run' || c.tool === 'script_run') && /· EXIT_\d+/.test(c.line));
}

/** The tier that takes over after this run, and why; nothing when the answer stands. */
export function stepUp(o: {
  brain: BrainName; model: Model; tier: Tier; halted: boolean; sawResult: boolean; resultError: boolean; stop?: string; calls: Call[];
}): { tier: Tier; why: string } | undefined {
  const tier = NEXT[o.tier];
  if (o.brain === 'codex' || o.model !== 'auto' || !tier) return undefined;
  if (o.halted || !o.sawResult) return undefined;
  if (o.calls.some(c => c.decided)) return undefined;
  if (o.stop === 'max_turns') return { tier, why: 'it ran out of steps' };
  if (o.resultError) return undefined;              // a stronger model would only repeat the error
  if (o.calls.some(askedUp)) return { tier, why: 'it asked for a stronger model' };
  if (o.calls.filter(failure).length >= FAILS) return { tier, why: 'its steps kept failing' };
  return undefined;
}

/** What the next tier is told: it resumes the same session, so the earlier model's calls are above. */
export function continueText(why: string): string {
  return `[Blob] The earlier model stopped before finishing this request (${why}). Everything it did is above: its tool ` +
    'calls and their results. Continue the same request from where it stopped. Do not redo a step that already worked ' +
    'or changed something (an app or page opened, a file moved, a message sent, a command run): if you are not sure ' +
    'whether it took effect, look first. A step the user said No to stays not done. If the request is already done, ' +
    'just give the final one-sentence answer. Never mention this hand-off or models to the user.';
}
