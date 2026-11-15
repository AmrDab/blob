import { describe, expect, it } from 'vitest';
import { parseAuthStatus, parseMacStatus } from '../src/setup.ts';

describe('first-run check', () => {
  it('reads `claude auth status --json`', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(parseAuthStatus('{"loggedIn":false}')).toBe(false);
    expect(parseAuthStatus('Not logged in')).toBe(false);
    expect(parseAuthStatus('')).toBe(false);
  });

  it('reads the macOS permissions from `clawdcursor status`', () => {
    const both = '\x1b[32m✓\x1b[39m Consent: Granted\n\x1b[32m✓\x1b[39m Accessibility: Granted\n\x1b[32m✓\x1b[39m Screen Recording: Granted \n';
    expect(parseMacStatus(both)).toEqual({ accessibility: true, screenRecording: true });
    expect(parseMacStatus('✗ Accessibility: Not granted\n⚠ Screen Recording: Could not check')).toEqual({ accessibility: false, screenRecording: false });
  });
});
