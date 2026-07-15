export type ListForRepoIssue = {
  number: number;
  body: string | null;
  labels?: Array<{ name?: string | null } | string>;
  pull_request?: unknown;
};

/** Minimal Octokit shape needed for listing/creating/updating issues */
export interface OctokitLike {
  rest: {
    issues: {
      listForRepo: (opts: {
        owner: string;
        repo: string;
        state: string;
        labels?: string;
        per_page: number;
      }) => Promise<{ data: ListForRepoIssue[] }>;
      create: (opts: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        labels?: string[] | readonly string[];
      }) => Promise<{ data: { number: number } }>;
      update: (opts: {
        owner: string;
        repo: string;
        issue_number: number;
        title?: string;
        body?: string;
      }) => Promise<unknown>;
    };
  };
}

/**
 * Generic accessors for batchable items. Consumer provides these; the package
 * never sees domain types like "resource" or "issue".
 */
export interface BatchAccessors<T> {
  /** Stable unique id for deduplication and matching across runs */
  getKey: (item: T) => string;
  /** Content signature to detect "same key, content changed" */
  getFingerprint: (item: T) => string;
  /** Optional: for size-aware batching (e.g. sub-item count). Defaults to 1. */
  getWeight?: (item: T) => number;
}

/**
 * Batching configuration. All limits are applied by the package.
 */
export interface BatchConfig {
  /** Max items in one batch (one GitHub issue) */
  maxItemsPerBatch: number;
  /** If provided with getWeight, sum(weight) per batch must not exceed this */
  maxWeightPerBatch?: number;
}

/**
 * State stored in each issue body (in an HTML comment). Used to detect
 * existing batches and whether content changed.
 */
export interface BatchState {
  /** Schema version for future migrations */
  v: number;
  /** Keys of items in this batch (order preserved for stability) */
  keys: string[];
  /** Fingerprint per key */
  fingerprints: Record<string, string>;
}

/**
 * Parsed state for one existing issue.
 */
export interface ExistingIssueState {
  issueNumber: number;
  keys: string[];
  fingerprints: Record<string, string>;
}

/**
 * Aggregated state from all open issues with the given label.
 * byKey: for each key, what fingerprint and which issue number (last seen wins if key appears in multiple).
 * issues: full list for matching "same batch" (same set of keys).
 */
export interface ExistingState {
  byKey: Map<string, { fingerprint: string; issueNumber: number }>;
  issues: ExistingIssueState[];
}

/**
 * Options for syncing batches to GitHub issues.
 */
export interface SyncBatchedIssuesOptions<T> {
  /** GitHub REST API client (e.g. from getOctokit()) */
  octokit: OctokitLike;
  owner: string;
  repo: string;
  /** Label used to find/create issues (e.g. 'averlon-iac-misconfiguration-analysis') */
  label: string;
  /** Current items to sync (consumer filters beforehand if needed) */
  items: T[];
  accessors: BatchAccessors<T>;
  config: BatchConfig;
  /** Generate issue title for a batch */
  generateTitle: (batch: T[], batchIndex: number, totalBatches: number) => string;
  /** Generate issue body for a batch (without embedded state; we append state) */
  generateBody: (batch: T[], batchIndex: number, totalBatches: number) => string;
  /** Optional: full list of labels for new issues. If omitted, [label] is used. */
  labels?: string[];
  /** Optional: pre-fetched existing state. When set, skips listForRepo and uses this for diffing. */
  existingState?: ExistingState;
  /**
   * When true, items with changed fingerprint (same key, new issues) are batched together using
   * the same config (e.g. max 10 per batch); a new issue is always created for those batches and
   * existing issues are never updated. New-key items are batched normally and can update existing
   * issues when the key set matches.
   */
  newIssuesInSeparateBatches?: boolean;
}
