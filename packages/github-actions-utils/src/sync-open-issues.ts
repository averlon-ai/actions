/**
 * Bulk sync of labeled GitHub issues to the GitActions backend (issue status + PR linking).
 */

import type { ApiClient } from '@averlon/shared';
import { GitIssueType, GitPullRequestStatus } from '@averlon/shared';
import { listLabeledIssues, normalizeRepoScope, type IssuesListOctokit } from './github-issue-list';
import * as gitActionsUtils from './git-actions-utils';
import type { LinkedPR } from './git-actions-utils';
import { logDebug, logVerbose, logInfo, logWarn } from './log-utils';

export interface SyncOpenLabeledIssuesToBackendParams {
  octokit: IssuesListOctokit;
  orgName: string;
  repo: string;
  label: string;
  issueLabels: string[];
  type: GitIssueType;
  apiClient?: ApiClient;
  cloudId?: string;
  touchedIssueNumbers: Iterable<number>;
  findPRsLinkedToIssue: (issueNumber: number) => Promise<LinkedPR[]>;
}

function githubIssueStateToGitStatus(state: 'open' | 'closed'): GitPullRequestStatus {
  return state === 'closed' ? GitPullRequestStatus.Closed : GitPullRequestStatus.Open;
}

/**
 * Upserts issue status and links PRs for all labeled issues (open and closed), excluding
 * issues already handled in the current workflow run.
 */
export async function syncOpenLabeledIssuesToBackend(
  params: SyncOpenLabeledIssuesToBackendParams
): Promise<void> {
  const {
    octokit,
    orgName,
    repo,
    label,
    issueLabels,
    type,
    apiClient,
    cloudId,
    touchedIssueNumbers,
    findPRsLinkedToIssue,
  } = params;

  if (!apiClient) {
    logDebug('apiClient required for labeled-issue backend sync; skipping');
    return;
  }

  const { owner, repo: repoName } = normalizeRepoScope(orgName, repo);
  const touched = new Set(touchedIssueNumbers);
  const labeledIssues = await listLabeledIssues(octokit, owner, repoName, label, 'all');
  const toSync = labeledIssues.filter(issue => !touched.has(issue.number));

  const openCount = labeledIssues.filter(i => i.state === 'open').length;
  const closedCount = labeledIssues.length - openCount;

  if (toSync.length === 0) {
    logVerbose(
      `No additional labeled issues to sync (${labeledIssues.length} total: ${openCount} open, ${closedCount} closed; ${touched.size} touched this run)`
    );
    return;
  }

  logVerbose(
    `Syncing ${toSync.length} labeled issue(s) to backend (${openCount} open, ${closedCount} closed; ${touched.size} excluded as touched this run)`
  );

  let syncedCount = 0;
  let failedCount = 0;

  for (const {
    number: issueNumber,
    title: issueTitle,
    state: githubState,
    labels: githubLabels,
  } of toSync) {
    try {
      const issueStatus = githubIssueStateToGitStatus(githubState);
      const labels = githubLabels.length > 0 ? githubLabels : issueLabels;

      const issueOk = await gitActionsUtils.createOrUpdateIssue({
        apiClient,
        orgName: owner,
        repo: repoName,
        issueNumber,
        issueTitle,
        riskSummary: '',
        type,
        labels,
        cloudId: cloudId || '',
        status: issueStatus,
      });
      if (!issueOk) {
        failedCount += 1;
        logWarn(`Failed to sync labeled issue #${issueNumber} to backend: issue upsert failed`);
        continue;
      }

      const linkedPRs = await findPRsLinkedToIssue(issueNumber);
      if (linkedPRs.length > 0) {
        const prOk = await gitActionsUtils.createPRForIssue({
          apiClient,
          orgName: owner,
          repo: repoName,
          issueNumber,
          linkedPRs,
          cloudId: cloudId || '',
        });
        if (!prOk) {
          failedCount += 1;
          logWarn(
            `Failed to sync linked PR(s) for labeled issue #${issueNumber} to backend: PR registration failed`
          );
          continue;
        }
      }
      syncedCount += 1;
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to sync labeled issue #${issueNumber} to backend: ${message}`);
    }
  }

  logInfo(
    `Labeled issue backend sync complete: ${syncedCount} issue(s) upserted${failedCount > 0 ? `, ${failedCount} failed` : ''}`
  );
}
