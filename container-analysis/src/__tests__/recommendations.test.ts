import { describe, it, expect } from 'bun:test';
import { parseFilters } from '../recommendations';

describe('parseFilters', () => {
  it('returns 0 for undefined input', () => {
    expect(parseFilters(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseFilters('')).toBe(0);
  });

  it('returns 0 for unknown filter names', () => {
    expect(parseFilters('Unknown,Bogus')).toBe(0);
  });

  it('parses a single known filter', () => {
    expect(parseFilters('Critical')).toBe(0x2);
  });

  it('parses multiple known filters into combined bitmask', () => {
    // Critical=0x2, High=0x4 → 0x6
    expect(parseFilters('Critical,High')).toBe(0x6);
  });

  it('parses Recommended,Critical,HighRCE (default filter)', () => {
    // Recommended=0x20, Critical=0x2, HighRCE=0x8 → 0x2a
    expect(parseFilters('Recommended,Critical,HighRCE')).toBe(0x20 | 0x2 | 0x8);
  });

  it('trims whitespace around filter names', () => {
    expect(parseFilters(' Critical , High ')).toBe(0x6);
  });

  it('ignores unknown names mixed with known names', () => {
    expect(parseFilters('Critical,Bogus,High')).toBe(0x6);
  });

  it('handles all known filter names', () => {
    const all =
      'RecommendedOrExploited,Critical,High,HighRCE,MediumApplication,Recommended,Exploited,Medium,Low,LowApplication';
    const expected = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200;
    expect(parseFilters(all)).toBe(expected);
  });
});
