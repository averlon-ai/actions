# @averlon/copilot-issue-batching

Generic batching and state-in-body sync for GitHub issues. Used by Averlon actions (e.g. IaC misconfig, K8s analysis) to create or update batched Copilot issues **only when needed**, without using Gists.

## Design

- **Generic over item type `T`**: You provide `getKey`, `getFingerprint`, and optionally `getWeight`. No built-in "resource" or "issue" concepts.
- **State in issue body**: Each issue body includes a hidden HTML comment with JSON state (keys + fingerprints). On the next run we list issues, parse state, and decide what to create or update.
- **Only when needed**: We diff current items against existing state (by key + fingerprint). We **only** create or update issues for items that are new or changed. If everything is already up to date, no API writes are made.
- **Batching**: Items are sorted by key and chunked by `maxItemsPerBatch` and optionally `maxWeightPerBatch` (when `getWeight` is provided).
- **Overflow handling**: If a batch’s body would exceed GitHub’s 65,536-character limit, we take the largest prefix that fits and push the rest to the next batch, so you get multiple issues (e.g. "Batch 1 of N", "Batch 2 of N") without skipping content.

## How issue uniqueness works

- **One issue per set of keys**: A GitHub issue is identified by the **set of item keys** in its batch (stored in the body). Two batches with the same set of keys are treated as the same issue (we update it); a new set of keys gets a new issue.
- **When we update**: For an existing issue (matching key set), we update it only if any key’s **fingerprint** changed (content changed). Same keys + same fingerprints → no write.
- **No Gist**: All state lives in the issue body; there is no external store.

## Usage

### Basic: let the package fetch existing state

```ts
import { syncBatchedIssues } from '@averlon/copilot-issue-batching';
import { getOctokit } from '@actions/github';

const octokit = getOctokit(process.env.GITHUB_TOKEN!);
await syncBatchedIssues({
  octokit,
  owner: 'my-org',
  repo: 'my-repo',
  label: 'averlon-my-action',
  items: myItems,
  accessors: {
    getKey: item => item.id,
    getFingerprint: item => item.contentSignature,
    getWeight: item => item.subItemCount,
  },
  config: { maxItemsPerBatch: 10, maxWeightPerBatch: 200 },
  generateTitle: (batch, i, total) => `Batch ${i + 1} of ${total}`,
  generateBody: (batch, i, total) => `## Batch ${i + 1}\n\n...`,
});
```

### Recommended: check first, then sync only when needed (one list call)

To avoid an extra `listForRepo` when nothing needs syncing, fetch existing state once and only call `syncBatchedIssues` when there are items to sync:

```ts
import {
  getExistingState,
  selectItemsNeedingUpdate,
  syncBatchedIssues,
  type OctokitLike,
} from '@averlon/copilot-issue-batching';

const existing = await getExistingState(octokit, owner, repo, label);
const toSync = selectItemsNeedingUpdate(items, accessors, existing);

if (toSync.length === 0) {
  console.log('No batches to create or update (already up to date)');
  return;
}

await syncBatchedIssues({
  octokit,
  owner,
  repo,
  label,
  items,
  accessors,
  config: { maxItemsPerBatch: 10, maxWeightPerBatch: 200 },
  existingState: existing, // skip second listForRepo
  generateTitle: (batch, i, total) => `Batch ${i + 1} of ${total}`,
  generateBody: (batch, i, total) => `...`,
});
```

## API

| Symbol                                                        | Description                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **syncBatchedIssues(options)**                                | Full sync: (optionally) fetch existing state, diff, batch, then create or update issues. Returns issue numbers touched. |
| **getExistingState(octokit, owner, repo, label)**             | List open issues with the label and parse embedded state from each body.                                                |
| **selectItemsNeedingUpdate(items, accessors, existingState)** | Items that are new (key not in state) or changed (same key, different fingerprint).                                     |
| **computeBatches(items, accessors, config)**                  | Chunk items into batches by `maxItemsPerBatch` / `maxWeightPerBatch` (no API calls).                                    |
| **embedBatchStateInBody(body, state)**                        | Append the state as a hidden HTML comment to the body.                                                                  |
| **parseBatchStateFromBody(body)**                             | Parse state from the body comment; returns `null` if missing or invalid.                                                |
| **buildBatchState(batch, getKey, getFingerprint)**            | Build `BatchState` from a batch of items.                                                                               |
| **enforceBodyLengthLimit(body, maxLength)**                   | Truncate body before the state comment if over `maxLength`; preserves state.                                            |
| **GITHUB_ISSUE_BODY_MAX_LENGTH**                              | `65_536` (GitHub’s limit).                                                                                              |

### SyncBatchedIssuesOptions

- **existingState** (optional): Pre-fetched state from `getExistingState`. When set, `syncBatchedIssues` does not call `listForRepo` and uses this for diffing. Use this when you already fetched state to decide “do we need to sync?” so you only do one list call.
- **newIssuesInSeparateBatches** (optional): When `true`, items with **changed fingerprint** (same key, new findings) are batched together using the same `maxItemsPerBatch` / `maxWeightPerBatch`; a **new issue is always created** for those batches and existing issues are **never updated**. New-key items are batched normally and can still update an existing issue when the key set matches.

## GitHub issue body limit

Issue body is limited to **65,536 characters** by the GitHub API. The package **never** sends a body over this limit:

- **Overflow resolution**: When a batch’s body would exceed the limit, we take the **largest prefix of items that fits**, create one issue for that chunk, and **push the remaining items to the next batch**. Titles stay consistent (e.g. "Batch 1 of N", "Batch 2 of N").
- If a **single item’s** body would still exceed the limit, that chunk is skipped and an error is logged.
- If the embedded state comment alone would exceed the limit (extremely rare), that chunk is skipped.

## Limitations

- **Pagination**: `listForRepo` uses `per_page: 100`. If there are more than 100 open issues with the label, existing state is incomplete and duplicate issues may be created.
- **Concurrency**: Two runs at once can both see “no existing issue” and both create; consider serializing or using a lock if you run frequently.
- **State comment**: If the issue body is edited and the state comment is removed or corrupted, that issue is no longer recognized and a new issue may be created for the same keys.
- **Open + label**: Only **open** issues with the given **label** are considered; closed or relabeled issues are ignored and may be “replaced” by a new issue with the same keys.
