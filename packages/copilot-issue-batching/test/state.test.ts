import { describe, it, expect } from 'bun:test';
import {
  embedBatchStateInBody,
  parseBatchStateFromBody,
  buildBatchState,
  enforceBodyLengthLimit,
  GITHUB_ISSUE_BODY_MAX_LENGTH,
  STATE_COMMENT_START,
} from '../src/state';

describe('state', () => {
  it('embeds and parses batch state round-trip', () => {
    const body = '## Hello\n\nSome markdown.';
    const state = {
      v: 1,
      keys: ['a', 'b'],
      fingerprints: { a: 'fp1', b: 'fp2' },
    };
    const withState = embedBatchStateInBody(body, state);
    expect(withState).toContain('## Hello');
    expect(withState).toContain('averlon-batch-state');
    expect(withState).toContain('"keys":["a","b"]');

    const parsed = parseBatchStateFromBody(withState);
    expect(parsed).not.toBeNull();
    expect(parsed?.v).toBe(1);
    expect(parsed?.keys).toEqual(['a', 'b']);
    expect(parsed?.fingerprints).toEqual({ a: 'fp1', b: 'fp2' });
  });

  it('parseBatchStateFromBody returns null when no state', () => {
    expect(parseBatchStateFromBody('')).toBeNull();
    expect(parseBatchStateFromBody('## No state here')).toBeNull();
  });

  it('buildBatchState from items with accessors', () => {
    const items = [
      { id: 'x', sig: 's1' },
      { id: 'y', sig: 's2' },
    ];
    const state = buildBatchState(
      items,
      i => i.id,
      i => i.sig
    );
    expect(state.v).toBe(1);
    expect(state.keys).toEqual(['x', 'y']);
    expect(state.fingerprints).toEqual({ x: 's1', y: 's2' });
  });

  describe('enforceBodyLengthLimit', () => {
    it('returns body unchanged when under limit', () => {
      const body = 'short';
      expect(enforceBodyLengthLimit(body, 100)).toBe(body);
      expect(enforceBodyLengthLimit(body)).toBe(body);
    });

    it('truncates content before state comment when over limit, preserves state', () => {
      const state = { v: 1, keys: ['a'], fingerprints: { a: 'f1' } };
      const longLead = 'x'.repeat(70_000);
      const body = embedBatchStateInBody(longLead, state);
      expect(body.length).toBeGreaterThan(GITHUB_ISSUE_BODY_MAX_LENGTH);

      const result = enforceBodyLengthLimit(body);
      expect(result.length).toBeLessThanOrEqual(GITHUB_ISSUE_BODY_MAX_LENGTH);
      expect(result).toContain(STATE_COMMENT_START);
      expect(result).toContain('"keys":["a"]');
      expect(parseBatchStateFromBody(result)).toEqual(state);
    });

    it('truncates to maxLength when body has no state comment', () => {
      const long = 'y'.repeat(70_000);
      const result = enforceBodyLengthLimit(long, 1000);
      expect(result.length).toBe(1000);
    });
  });
});
