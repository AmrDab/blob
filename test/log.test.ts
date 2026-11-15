import { describe, expect, it } from 'vitest';
import { formatLog, formatRow, logFileName } from '../src/log.ts';

const t = new Date(2026, 10, 14, 9, 5, 7).getTime();   // local time, as the log writes it

describe('log', () => {
  it('formats a request, each call with its outcome line, and the answer', () => {
    expect(formatLog([
      { t, kind: 'request', text: 'open notepad' },
      { t, kind: 'call', tool: 'system', action: 'open_app', outcome: 'confirmed', line: '[confirmed]' },
      { t, kind: 'call', tool: 'Read', outcome: 'ok', line: 'hello' },
      { t, kind: 'answer', text: 'Notepad is open.' },
    ])).toBe([
      '09:05:07  › open notepad',
      '09:05:07    system · open_app  [confirmed]',
      '09:05:07    Read  hello',
      '09:05:07  = Notepad is open.',
    ].join('\n'));
  });

  it('names one file per local day', () => {
    expect(logFileName(t)).toBe('2026-11-14.log');
    expect(logFileName(new Date(2027, 0, 2, 23, 59).getTime())).toBe('2027-01-02.log');
    expect(formatRow({ t, kind: 'answer', text: 'x' })).toBe('09:05:07  = x');
  });
});
