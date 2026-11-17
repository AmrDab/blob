// What Blob keeps out of the text it shows and of the programs it starts. No imports: shell.ts, memory.ts and
// computer.ts share it, and computer.ts is loaded by src/os.

/** Characters that do not show, or that change the order text is shown in. */
/** Characters that don't show on screen (controls, zero-width, bidi): text with them is never shown on a Yes card. */
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u00a0\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** The command's environment: none of Blob's own tokens, no API keys. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|BLOB_)/i.test(k) || /^CLAUDECODE$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
