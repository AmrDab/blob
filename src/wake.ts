// "Hey Blob" typed anywhere: Blob comes forward with the Type box open. The system's key watcher (os.keyWatch) hands
// each typed character here; only the last few are kept, in memory, never logged or sent anywhere. The phrase counts
// at the start of a word, in any case: "hey blob", "Hi Blob", "hey, blob" (not "they blob"). Plain logic, tested in
// test/wake.test.ts.

/** What the key watcher reports: a typed character, Backspace, or anything that moves the cursor (an arrow, a click). */
export interface KeySink { char(c: string): void; back(): void; reset(): void }

const KEEP = 16;                                      // longer than "hey, blob" with a space or two to spare
const PHRASE = /(?:^|[^\p{L}\p{N}])(?:hey|hi)[\s,]+blob$/u;

/** Calls `wake` each time the typed text ends in the phrase. */
export function wakeMatcher(wake: () => void): KeySink {
  let typed = '';
  return {
    char(c) {
      if (!c || /[\r\n\t]/.test(c)) { typed = ''; return; }   // Return or Tab: a new line, a new field
      typed = (typed + c.toLowerCase()).slice(-KEEP);
      if (PHRASE.test(typed)) { typed = ''; wake(); }
    },
    back() { typed = typed.slice(0, -1); },
    reset() { typed = ''; },
  };
}

/** The first name in a full name ("Amr Aldabbas" → "Amr"); '' when there is none. */
export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? '';

/** What Blob says as it comes forward. */
export const greeting = (name: string) => (name ? `Hey ${name}, how can I help you?` : 'Hey, how can I help you?');
