// A report to Blob's developers, of one request: when Blob got something wrong, it says sorry and offers to send
// one (the self server's send_report). Nothing is sent by itself: the user says Yes on the bubble, then a GitHub
// issue opens in their browser with the report filled in, to read, change and submit themselves. Only the request
// at hand and the one before it go in (a mistake is often pointed out in the next request): their words, the tool
// calls and Blob's answers, with the home folder and anything that looks like a key, token or password taken out.
// Plain logic, tested in test/report.test.ts.
import { formatLog, type LogRow } from './log.ts';

export const REPORT_REPO = 'AmrDab/blob';
/** The longest report: a GitHub new-issue link carries the text in its address, and browsers cut long ones. */
export const MAX_REPORT = 6000;

/** The rows of the last `n` requests: from the n-th last request row to the end. None when there was no request. */
export function lastRequests(rows: readonly LogRow[], n: number = 2): LogRow[] {
  let start = -1;
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < n; i--) if (rows[i].kind === 'request') { start = i; seen++; }
  return start < 0 ? [] : rows.slice(start);
}

const KEYISH = /\b(pass(?:word|code|phrase)?|pin|api[ _-]?key|secret|token|bearer|authorization)\b(\s*(?:is|:|=)\s*)\S+/gi;
const LONG = /\b(?:[A-Za-z0-9+/_-]{32,}={0,2})\b/g;                 // a key or token on its own
const MAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/** The text with the home folder as ~, and what looks like a key, token, password or email address hidden. */
export function scrub(text: string, home: string): string {
  let s = home ? text.split(home).join('~') : text;
  s = s.replace(KEYISH, (_m, word: string, sep: string) => `${word}${sep}[hidden]`);
  return s.replace(LONG, '[hidden]').replace(MAIL, '[email]');
}

export interface ReportInput {
  /** What went wrong, in Blob's words. */
  what: string;
  rows: readonly LogRow[];
  version: string;
  system: string;
  brain: string;
  model: string;
  home: string;
}

/** The report: what went wrong, where it ran, and the request's log, cut in the middle when it is too long. */
export function reportText(r: ReportInput): string {
  const head = `What went wrong (Blob's words): ${r.what.trim() || 'not said'}\n\nBlob ${r.version} · ${r.system} · ${r.brain} · ${r.model}\n\nThe last requests:\n`;
  let log = scrub(formatLog(r.rows as LogRow[]), r.home);
  const room = MAX_REPORT - head.length;
  if (log.length > room) {
    const cut = '\n… (the middle is left out) …\n', half = Math.floor((room - cut.length) / 2);
    log = log.slice(0, half) + cut + log.slice(log.length - half);
  }
  return scrub(head, r.home) + log;
}

/** The title: the request's first words. */
export function reportTitle(rows: readonly LogRow[]): string {
  const first = rows.find(x => x.kind === 'request');
  const words = first && first.kind === 'request' ? first.text.replace(/\s+/g, ' ').trim() : '';
  return `Report: ${words.length > 60 ? words.slice(0, 57) + '…' : words || 'a request'}`;
}

/** The answer owns up to a mistake ("Sorry about that", "my mistake"): the host then offers the report itself, when the
 *  model did not (send_report). */
export const apologizes = (answer: string) =>
  /\b(sorry|apologi[sz]e|my (mistake|bad|fault)|i was wrong|i got (that|it) wrong)\b/i.test(answer);

/** The GitHub page that opens a new issue with this title and text filled in. */
export const issueUrl = (title: string, body: string, repo: string = REPORT_REPO) =>
  `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body })}`;
