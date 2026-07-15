/**
 * Listing GitHub issues by label (for source-control bulk sync).
 */

export type GitHubIssueState = 'open' | 'closed';

export interface ListedLabeledIssue {
  number: number;
  title: string;
  state: GitHubIssueState;
  labels: string[];
}

export interface ListedLabeledPullRequest {
  number: number;
  title: string;
}

export type ListForRepoLabel = { name?: string | null } | string;

export type ListForRepoIssue = {
  number: number;
  title: string | null;
  state?: string;
  labels?: ListForRepoLabel[];
  pull_request?: unknown;
};

export type ListForRepoState = 'open' | 'closed' | 'all';

export type ListForRepoParams = {
  owner: string;
  repo: string;
  state: ListForRepoState;
  labels: string;
  per_page: number;
  page?: number;
};

export interface IssuesListOctokit {
  paginate: (
    method: (params: ListForRepoParams) => Promise<{ data: ListForRepoIssue[] }>,
    params: Omit<ListForRepoParams, 'page'>
  ) => Promise<ListForRepoIssue[]>;
  rest: {
    issues: {
      listForRepo: (params: ListForRepoParams) => Promise<{ data: ListForRepoIssue[] }>;
    };
  };
}

const PER_PAGE = 100;

/** Trim and validate owner/repo for GitHub list calls. */
export function normalizeRepoScope(owner: string, repo: string): { owner: string; repo: string } {
  const normalizedOwner = owner?.trim() ?? '';
  const normalizedRepo = repo?.trim() ?? '';
  if (!normalizedOwner || !normalizedRepo) {
    throw new Error('GitHub owner and repo are required for labeled issue/PR listing');
  }
  return { owner: normalizedOwner, repo: normalizedRepo };
}

/** Trim and validate label name for GitHub list calls. */
export function normalizeLabel(label: string): string {
  const trimmed = label?.trim() ?? '';
  if (!trimmed) {
    throw new Error('GitHub label is required for labeled issue/PR listing');
  }
  return trimmed;
}

export function extractLabelNames(labels: ListForRepoLabel[] | undefined): string[] {
  if (!labels?.length) {
    return [];
  }
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === 'string' && label.trim()) {
      names.push(label.trim());
    } else if (label && typeof label === 'object' && label.name?.trim()) {
      names.push(label.name.trim());
    }
  }
  return names;
}

/** True when issue label metadata includes the required label (defense after listForRepo). */
export function issueIncludesLabel(
  issue: { labels?: ListForRepoLabel[] },
  requiredLabel: string
): boolean {
  const names = extractLabelNames(issue.labels);
  if (names.length === 0) {
    return true;
  }
  return names.includes(requiredLabel);
}

/** Build listForRepo params scoped to one repo and one label. */
export function buildListForRepoParams(options: {
  owner: string;
  repo: string;
  label: string;
  state: ListForRepoState;
}): ListForRepoParams {
  const { owner, repo } = normalizeRepoScope(options.owner, options.repo);
  const label = normalizeLabel(options.label);
  return {
    owner,
    repo,
    state: options.state,
    labels: label,
    per_page: PER_PAGE,
  };
}

function normalizeIssueState(state: string | undefined): GitHubIssueState {
  return state === 'closed' ? 'closed' : 'open';
}

function toListedLabeledIssues(
  issues: ListForRepoIssue[],
  requiredLabel: string
): ListedLabeledIssue[] {
  const results: ListedLabeledIssue[] = [];
  for (const issue of issues) {
    if (issue.pull_request) {
      continue;
    }
    if (!issueIncludesLabel(issue, requiredLabel)) {
      continue;
    }
    results.push({
      number: issue.number,
      title: (issue.title?.trim() ?? '') || `Issue #${issue.number}`,
      state: normalizeIssueState(issue.state),
      labels: extractLabelNames(issue.labels),
    });
  }
  return results;
}

function toListedLabeledPullRequests(
  issues: ListForRepoIssue[],
  requiredLabel: string
): ListedLabeledPullRequest[] {
  const results: ListedLabeledPullRequest[] = [];
  for (const issue of issues) {
    if (!issue.pull_request) {
      continue;
    }
    if (!issueIncludesLabel(issue, requiredLabel)) {
      continue;
    }
    results.push({
      number: issue.number,
      title: (issue.title?.trim() ?? '') || `PR #${issue.number}`,
    });
  }
  return results;
}

/**
 * Returns all issues in a repo with the given label and state filter (via Octokit paginate).
 * Use `state: 'all'` to include open and closed. Pull requests in the issues list are excluded.
 */
export async function listLabeledIssues(
  octokit: IssuesListOctokit,
  owner: string,
  repo: string,
  label: string,
  state: ListForRepoState = 'all'
): Promise<ListedLabeledIssue[]> {
  const listParams = buildListForRepoParams({ owner, repo, label, state });
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, listParams);

  return toListedLabeledIssues(issues, listParams.labels);
}

/**
 * Returns pull requests in a repo with the given label (issues API includes PRs).
 * Request and response are scoped to the same owner, repo, and label.
 */
export async function listLabeledPullRequests(
  octokit: IssuesListOctokit,
  owner: string,
  repo: string,
  label: string,
  state: ListForRepoState = 'all'
): Promise<ListedLabeledPullRequest[]> {
  const listParams = buildListForRepoParams({ owner, repo, label, state });
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, listParams);

  return toListedLabeledPullRequests(issues, listParams.labels);
}

/** @deprecated Use listLabeledIssues with state `'open'`. */
export async function listOpenLabeledIssues(
  octokit: IssuesListOctokit,
  owner: string,
  repo: string,
  label: string
): Promise<Array<{ number: number; title: string }>> {
  const issues = await listLabeledIssues(octokit, owner, repo, label, 'open');
  return issues.map(({ number, title }) => ({ number, title }));
}
