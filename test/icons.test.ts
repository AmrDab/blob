import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICONS } from '../src/shared.ts';

describe('icons', () => {
  it('every shortcut icon has a drawing', () => {
    const src = readFileSync(new URL('../src/ui/icons.tsx', import.meta.url), 'utf8');
    for (const i of ICONS) expect(src).toMatch(new RegExp(`\n  ${i}: '`));
  });
});
