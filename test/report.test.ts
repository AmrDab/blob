import { describe, expect, it } from 'vitest';
import type { LogRow } from '../src/log.ts';
import { MAX_REPORT, apologizes, issueUrl, lastRequests, reportText, reportTitle, scrub } from '../src/report.ts';

const rows: LogRow[] = [
  { t: 0, kind: 'request', text: 'an older request' },
  { t: 1, kind: 'answer', text: 'done' },
  { t: 2, kind: 'request', text: 'Open my notes and add milk' },
  { t: 3, kind: 'call', tool: 'computer', action: 'click', outcome: 'ok', line: 'clicked "Notes" in /Users/amr/Documents' },
  { t: 4, kind: 'answer', text: 'I added eggs. Sorry, that was wrong.' },
];
const input = { what: 'I typed eggs instead of milk.', rows: lastRequests(rows, 1), version: '0.1.1', system: 'macOS', brain: 'Claude Code', model: 'auto', home: '/Users/amr' };

describe('a report', () => {
  it('holds the last request and the one before it (where a mistake pointed out now was made), and no older one', () => {
    const more: LogRow[] = [...rows, { t: 5, kind: 'request', text: 'That was wrong' }, { t: 6, kind: 'answer', text: 'Sorry' }];
    expect(lastRequests(more).map(r => r.t)).toEqual([2, 3, 4, 5, 6]);
    expect(lastRequests(rows, 1).map(r => r.t)).toEqual([2, 3, 4]);
    expect(lastRequests(rows).map(r => r.t)).toEqual([0, 1, 2, 3, 4]);
    expect(lastRequests([])).toEqual([]);
    expect(lastRequests([{ t: 0, kind: 'answer', text: 'x' }])).toEqual([]);
  });

  it("says what went wrong in Blob's words, where it ran, and the request's log", () => {
    const r = reportText(input);
    expect(r).toContain("What went wrong (Blob's words): I typed eggs instead of milk.");
    expect(r).toContain('Blob 0.1.1 · macOS · Claude Code · auto');
    expect(r).toContain('› Open my notes and add milk');
    expect(r).toContain('computer · click');
    expect(r).not.toContain('an older request');
  });

  it('leaves out the home folder and what looks like a key, token, password or email address', () => {
    expect(scrub('clicked in /Users/amr/Documents', '/Users/amr')).toBe('clicked in ~/Documents');
    expect(scrub('typed password: hunter2 and token=abc', '')).toBe('typed password: [hidden] and token=[hidden]');
    expect(scrub('key sk-ant-0123456789abcdef0123456789abcdef here', '')).toBe('key [hidden] here');
    expect(scrub('mail me at someone@example.com', '')).toBe('mail me at [email]');
    expect(reportText(input)).toContain('~/Documents');
  });

  it('is cut in the middle when too long, keeping the start and the end', () => {
    const long = [{ t: 0, kind: 'request', text: 'go' } as LogRow,
      ...Array.from({ length: 400 }, (_, i) => ({ t: i, kind: 'call', tool: 'computer', outcome: 'ok', line: `step ${i} `.repeat(4) }) as LogRow),
      { t: 9, kind: 'answer', text: 'the end' } as LogRow];
    const r = reportText({ ...input, rows: long });
    expect(r.length).toBeLessThanOrEqual(MAX_REPORT);
    expect(r).toContain('› go');
    expect(r).toContain('the end');
    expect(r).toContain('the middle is left out');
  });

  it("is titled with the request's first words, and opens as a new GitHub issue", () => {
    expect(reportTitle(lastRequests(rows, 1))).toBe('Report: Open my notes and add milk');
    expect(reportTitle([])).toBe('Report: a request');
    const u = new URL(issueUrl('Report: x', 'body text'));
    expect(u.origin + u.pathname).toBe('https://github.com/AmrDab/blob/issues/new');
    expect(u.searchParams.get('title')).toBe('Report: x');
    expect(u.searchParams.get('body')).toBe('body text');
  });

  it('sees an answer that owns up to a mistake, and not one that does not', () => {
    for (const a of ['Sorry about that. One hundred and forty-four.', 'My mistake, it is Canberra.', 'I apologise for the mix-up.', 'You are right, I was wrong.'])
      expect(apologizes(a), a).toBe(true);
    for (const a of ['144', 'Canberra is the capital.', 'No sorrow here.'])
      expect(apologizes(a), a).toBe(false);
  });
});
