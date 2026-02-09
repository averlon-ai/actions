import * as core from '@actions/core';
import type { ExistingState, ExistingIssueState, SyncBatchedIssuesOptions } from './types';
import {
  parseBatchStateFromBody,
  embedBatchStateInBody,
  buildBatchState,
  GITHUB_ISSUE_BODY_MAX_LENGTH,
  STATE_COMMENT_START,
} from './state';
import { computeBatches } from './batching';
import { selectItemsNeedingUpdateSplit } from './diff';

const OPEN_STATE = 'open';

/**
 * Fetches all open issues with the given label and parses embedded state from each body.
 * Returns aggregated state for diffing and matching batches.
 */
export async function getExistingState(
  octokit: SyncBatchedIssuesOptions<unknown>['octokit'],
  owner: string,
  repo: string,
  label: string
): Promise<ExistingState> {
  const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
  const issues: ExistingIssueState[] = [];

  const { data: list } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: OPEN_STATE,
    labels: label,
    per_page: 100,
  });

  for (const issue of list) {
    const body = issue.body ?? '';
    const state = parseBatchStateFromBody(body);
    if (!state) continue;

    const existing: ExistingIssueState = {
      issueNumber: issue.number,
      keys: state.keys,
      fingerprints: state.fingerprints,
    };
    issues.push(existing);

    for (const key of state.keys) {
      const fp = state.fingerprints[key];
      if (fp !== undefined) {
        byKey.set(key, { fingerprint: fp, issueNumber: issue.number });
      }
    }
  }

  return { byKey, issues };
}

function keySet(keys: string[]): string {
  return [...keys].sort().join('\0');
}

function findExistingIssueForBatch(
  batchKeys: string[],
  existing: ExistingState
): ExistingIssueState | null {
  const batchSet = keySet(batchKeys);
  for (const issue of existing.issues) {
    if (keySet(issue.keys) === batchSet) return issue;
  }
  return null;
}

/**
 * Syncs items to GitHub issues: creates or updates batched issues, with state
 * stored in the issue body (no Gist). Only items that are new or changed
 * (by fingerprint) are considered; then they are batched and each batch
 * is either created as a new issue or updates an existing issue with the
 * same set of keys.
 * @returns Issue numbers that were created or updated (for e.g. Copilot assignment)
 */
export async function syncBatchedIssues<T>(
  options: SyncBatchedIssuesOptions<T>
): Promise<number[]> {
  const {
    octokit,
    owner,
    repo,
    label,
    items,
    accessors,
    config,
    generateTitle,
    generateBody,
    labels: createLabels,
    existingState: existingStateOption,
    newIssuesInSeparateBatches,
  } = options;

  const touchedIssueNumbers: number[] = [];

  if (items.length === 0) {
    core.info('No items to sync');
    return touchedIssueNumbers;
  }

  const existing = existingStateOption ?? (await getExistingState(octokit, owner, repo, label));
  const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);

  const toSync = [...newItems, ...changedItems];

  if (toSync.length === 0) {
    core.info('All items already up to date; no batches to create or update');
    return touchedIssueNumbers;
  }

  let batches: T[][];
  /** Index in batches at which "create-only" batches start (never update existing issue). */
  let createOnlyStartIndex: number;
  if (newIssuesInSeparateBatches && changedItems.length > 0) {
    const newBatches = computeBatches(newItems, accessors, config);
    const changedBatches = computeBatches(changedItems, accessors, config);
    batches = [...newBatches, ...changedBatches];
    createOnlyStartIndex = newBatches.length;
    core.info(
      `Syncing ${toSync.length} item(s) in ${batches.length} batch(es) (${newItems.length} new, ${changedItems.length} with new issues in new batch(es), create-only)`
    );
  } else {
    batches = computeBatches(toSync, accessors, config);
    createOnlyStartIndex = batches.length; // no create-only batches
    core.info(
      `Syncing ${toSync.length} item(s) in ${batches.length} batch(es) (max ${config.maxItemsPerBatch} per batch)`
    );
  }

  const { getKey, getFingerprint } = accessors;
  const labelsToUse = createLabels && createLabels.length > 0 ? createLabels : [label];

  /** Build body for a chunk (for length check / create). */
  function buildBodyForChunk(chunk: T[], issueIndex: number, totalIssues: number): string {
    const batchState = buildBatchState(chunk, getKey, getFingerprint);
    const body = generateBody(chunk, issueIndex, totalIssues);
    return embedBatchStateInBody(body, batchState);
  }

  /** Largest prefix length k (1..chunk.length) such that body for chunk.slice(0, k) fits. Returns 0 if none. */
  function maxPrefixThatFits(chunk: T[], issueIndex: number, totalIssues: number): number {
    for (let k = chunk.length; k >= 1; k--) {
      const sub = chunk.slice(0, k);
      const body = buildBodyForChunk(sub, issueIndex, totalIssues);
      if (body.length <= GITHUB_ISSUE_BODY_MAX_LENGTH) return k;
    }
    return 0;
  }

  // Pass 1: Resolve overflow. When a batch's body is too long, take largest prefix that fits,
  // create one issue for it, and push the rest to the next batch. Track createOnly for "new issues" batches.
  type ChunkWithState = {
    chunk: T[];
    state: ReturnType<typeof buildBatchState>;
    createOnly?: boolean;
  };
  const chunksToCreate: ChunkWithState[] = [];
  let overflow: T[] = [];
  let overflowCreateOnly = false;

  for (let i = 0; i < batches.length; i++) {
    const batch = (batches[i] ?? []) as T[];
    const batchCreateOnly = i >= createOnlyStartIndex;
    if (batch.length === 0 && overflow.length === 0) continue;
    const chunk = [...overflow, ...batch];
    const chunkCreateOnly = overflowCreateOnly || batchCreateOnly;
    overflow = [];
    overflowCreateOnly = false;
    if (chunk.length === 0) continue;

    const batchState = buildBatchState(chunk, getKey, getFingerprint);
    const stateComment = '\n' + STATE_COMMENT_START + '\n' + JSON.stringify(batchState) + '\n-->';
    if (stateComment.length >= GITHUB_ISSUE_BODY_MAX_LENGTH) {
      core.error(
        `Batch state exceeds GitHub issue body limit (${GITHUB_ISSUE_BODY_MAX_LENGTH}); skipping.`
      );
      continue;
    }

    const body = buildBodyForChunk(chunk, 0, 1);
    if (body.length <= GITHUB_ISSUE_BODY_MAX_LENGTH) {
      chunksToCreate.push({ chunk, state: batchState, createOnly: chunkCreateOnly });
      continue;
    }

    const k = maxPrefixThatFits(chunk, 0, 1);
    if (k === 0) {
      core.error(
        `Single item body exceeds GitHub issue body limit (${GITHUB_ISSUE_BODY_MAX_LENGTH}); skipping.`
      );
      continue;
    }
    core.info(
      `Body too long (${body.length} > ${GITHUB_ISSUE_BODY_MAX_LENGTH}); using ${k} of ${chunk.length} items, pushing ${chunk.length - k} to next batch`
    );
    chunksToCreate.push({
      chunk: chunk.slice(0, k),
      state: buildBatchState(chunk.slice(0, k), getKey, getFingerprint),
      createOnly: chunkCreateOnly,
    });
    overflow = chunk.slice(k);
    overflowCreateOnly = chunkCreateOnly;
  }

  if (overflow.length > 0) {
    const k = maxPrefixThatFits(overflow, 0, 1);
    if (k === 0) {
      core.error(`Remaining ${overflow.length} item(s) exceed body limit; skipping.`);
    } else {
      chunksToCreate.push({
        chunk: overflow.slice(0, k),
        state: buildBatchState(overflow.slice(0, k), getKey, getFingerprint),
        createOnly: overflowCreateOnly,
      });
      if (k < overflow.length) {
        core.warning(
          `Dropping ${overflow.length - k} item(s) that would exceed body limit after final batch.`
        );
      }
    }
  }

  const totalIssues = chunksToCreate.length;
  if (totalIssues === 0) return touchedIssueNumbers;

  // Pass 2: Create/update one issue per chunk. createOnly chunks always create (never update existing).
  for (let j = 0; j < totalIssues; j++) {
    const item = chunksToCreate[j];
    if (!item) continue;
    const { chunk, state, createOnly } = item;
    const batchKeys = state.keys;
    const title = generateTitle(chunk, j, totalIssues);
    const body = buildBodyForChunk(chunk, j, totalIssues);

    try {
      const existingIssue = !createOnly ? findExistingIssueForBatch(batchKeys, existing) : null;
      if (existingIssue) {
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number: existingIssue.issueNumber,
          title,
          body,
        });
        touchedIssueNumbers.push(existingIssue.issueNumber);
        core.info(
          `Updated issue #${existingIssue.issueNumber} (Batch ${j + 1} of ${totalIssues}, ${chunk.length} item(s))`
        );
        const idx = existing.issues.findIndex(is => is.issueNumber === existingIssue.issueNumber);
        if (idx >= 0) {
          existing.issues[idx] = {
            issueNumber: existingIssue.issueNumber,
            keys: batchKeys,
            fingerprints: state.fingerprints,
          };
        }
        for (const key of batchKeys) {
          const fp = state.fingerprints[key];
          if (fp !== undefined) {
            existing.byKey.set(key, {
              fingerprint: fp,
              issueNumber: existingIssue.issueNumber,
            });
          }
        }
      } else {
        const { data: issue } = await octokit.rest.issues.create({
          owner,
          repo,
          title,
          body,
          labels: labelsToUse,
        });
        touchedIssueNumbers.push(issue.number);
        core.info(
          `Created issue #${issue.number} (Batch ${j + 1} of ${totalIssues}, ${chunk.length} item(s))`
        );
        existing.issues.push({
          issueNumber: issue.number,
          keys: batchKeys,
          fingerprints: state.fingerprints,
        });
        for (const key of batchKeys) {
          const fp = state.fingerprints[key];
          if (fp !== undefined) {
            existing.byKey.set(key, {
              fingerprint: fp,
              issueNumber: issue.number,
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.error(
        `Failed to create/update issue for Batch ${j + 1} of ${totalIssues} (${chunk.length} item(s)): ${msg}`
      );
    }
  }

  return touchedIssueNumbers;
}
