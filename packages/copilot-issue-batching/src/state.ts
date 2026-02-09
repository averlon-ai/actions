import type { BatchState } from './types';

/** GitHub API limit: issue/comment body must not exceed this (characters). */
export const GITHUB_ISSUE_BODY_MAX_LENGTH = 65_536;

/** Start of embedded state HTML comment in issue body (used for parsing and length enforcement). */
export const STATE_COMMENT_START = '<!-- averlon-batch-state';
const STATE_COMMENT_END = '-->';
const STATE_VERSION = 1;

const TRUNCATION_NOTE = '\n\n_[Content truncated to meet GitHub issue body limit.]_\n';

/**
 * Embeds batch state in an issue body as a hidden HTML comment.
 * Appends to the given body so existing content is preserved.
 */
export function embedBatchStateInBody(body: string, state: BatchState): string {
  const json = JSON.stringify(state);
  const comment = `\n${STATE_COMMENT_START}\n${json}\n${STATE_COMMENT_END}`;
  return body.trimEnd() + comment;
}

/**
 * Parses batch state from an issue body. Returns null if not found or invalid.
 */
export function parseBatchStateFromBody(body: string): BatchState | null {
  if (!body || typeof body !== 'string') return null;
  const startIdx = body.indexOf(STATE_COMMENT_START);
  if (startIdx === -1) return null;
  const contentStart = startIdx + STATE_COMMENT_START.length;
  const endIdx = body.indexOf(STATE_COMMENT_END, contentStart);
  if (endIdx === -1) return null;
  const raw = body.slice(contentStart, endIdx).trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'v' in parsed &&
      'keys' in parsed &&
      Array.isArray((parsed as BatchState).keys) &&
      'fingerprints' in parsed &&
      typeof (parsed as BatchState).fingerprints === 'object'
    ) {
      return parsed as BatchState;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Ensures body length does not exceed GitHub's limit. Preserves the embedded state
 * comment at the end; truncates only the preceding content and appends a short note.
 * If the state comment alone would exceed the limit, returns the body truncated to
 * maxLength (caller should avoid sending in that case).
 */
export function enforceBodyLengthLimit(
  body: string,
  maxLength: number = GITHUB_ISSUE_BODY_MAX_LENGTH
): string {
  if (body.length <= maxLength) return body;

  const stateStart = body.indexOf(STATE_COMMENT_START);
  if (stateStart < 0) return body.slice(0, maxLength);

  const stateComment = body.slice(stateStart);
  const reserved = stateComment.length + TRUNCATION_NOTE.length;
  if (reserved >= maxLength) return body.slice(0, maxLength);

  const maxLead = maxLength - reserved;
  return body.slice(0, maxLead) + TRUNCATION_NOTE + stateComment;
}

/**
 * Builds BatchState from a batch of items using accessors.
 */
export function buildBatchState<T>(
  batch: T[],
  getKey: (item: T) => string,
  getFingerprint: (item: T) => string
): BatchState {
  const keys = batch.map(getKey);
  const fingerprints: Record<string, string> = {};
  for (const item of batch) {
    fingerprints[getKey(item)] = getFingerprint(item);
  }
  return { v: STATE_VERSION, keys, fingerprints };
}
