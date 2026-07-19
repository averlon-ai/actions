/**
 * Utilities for Git issue and PR registration with backend (pb.GitActions)
 */

import * as github from '@actions/github';
import type { ApiClient } from '@averlon/shared';
import {
  GitPullRequestStatus,
  GitIssueType,
  GitIssueRiskStatus,
  type RegisterGitIssueRequest,
  type GetGitIssueResponse,
} from '@averlon/shared';
import { IssueState } from '@averlon/github-copilot-utils';
import { logDebug, logVerbose, logInfo, logWarn } from './log-utils';

/**
 * Linked PR information
 */
export interface LinkedPR {
  number: number;
  author: string;
  state: string;
}

/**
 * Parameters for finding a Git issue
 */
export interface FindGitIssueParams {
  apiClient: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  cloudId?: string | undefined;
}

/**
 * Find a Git issue in the backend.
 * Returns the issue response (with NotFound flag) or null if there's an error.
 */
export async function findGitIssue(
  params: FindGitIssueParams
): Promise<GetGitIssueResponse | null> {
  const { apiClient, orgName, repo, issueNumber, cloudId } = params;
  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    const request = {
      RepoURL: repoUrl,
      Number: issueNumber,
      CloudID: cloudId,
    };

    const findResponse = await apiClient.getGitIssue(request);

    return findResponse;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFound =
      errorMessage.includes('404') ||
      errorMessage.includes('not_found') ||
      errorMessage.includes('Not Found');

    if (isNotFound) {
      return { NotFound: true };
    }
    logDebug(`Error finding issue #${issueNumber}: ${errorMessage}`);
    return null;
  }
}

/**
 * Parameters for creating or updating an issue
 */
export interface CreateOrUpdateIssueParams {
  apiClient?: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl?: string;
  riskSummary: string;
  riskStatus?: GitIssueRiskStatus;
  type: GitIssueType;
  labels?: string[];
  issueIDs?: number[];
  cloudId?: string | undefined;
  /** GitHub/backend issue status; defaults to Open. */
  status?: GitPullRequestStatus;
}

/**
 * Create or update issue in backend (upsert).
 * Returns true if successful, false otherwise. Handles apiClient check internally.
 */
export async function createOrUpdateIssue(params: CreateOrUpdateIssueParams): Promise<boolean> {
  const {
    apiClient,
    orgName,
    repo,
    issueNumber,
    issueTitle,
    issueUrl,
    riskSummary,
    riskStatus,
    type,
    labels,
    issueIDs,
    cloudId,
    status,
  } = params;

  if (!apiClient) {
    return false;
  }

  const issueStatus = status ?? GitPullRequestStatus.Open;
  const trimmedTitle = (issueTitle?.trim() ?? '') || `Issue #${issueNumber}`;

  const finalIssueUrl =
    issueUrl ||
    (() => {
      const { repoUrl } = getRepoAndOrgUrls(orgName, repo);
      return `${repoUrl}/issues/${issueNumber}`;
    })();

  try {
    const { repoUrl, orgUrl } = getRepoAndOrgUrls(orgName, repo);
    logVerbose(`Creating/updating issue #${issueNumber} in backend (${GitIssueType[type]})`);

    const registerRequest: RegisterGitIssueRequest = {
      OrgName: orgName,
      OrgURL: orgUrl,
      RepoName: repo,
      RepoURL: repoUrl,
      Number: issueNumber,
      URL: finalIssueUrl,
      Title: trimmedTitle,
      RiskSummary: riskSummary,
      RiskStatus: riskStatus ?? GitIssueRiskStatus.None,
      Status: issueStatus,
      Type: type,
      CloudID: cloudId ?? '',
    };

    if (labels && labels.length > 0) {
      registerRequest.Labels = labels;
    }

    if (issueIDs && issueIDs.length > 0) {
      registerRequest.IssueIDs = issueIDs.map(String);
    }

    await apiClient.registerGitIssue(registerRequest);

    logVerbose(
      `✓ Created/updated issue #${issueNumber} in backend${issueIDs && issueIDs.length > 0 ? ` (${issueIDs.length} related issue ID(s))` : ''}`
    );
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to create/update issue #${issueNumber}: ${errorMessage}`);
    return false;
  }
}

/**
 * Parameters for creating/registering PRs for an issue
 */
export interface CreatePRForIssueParams {
  apiClient?: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  linkedPRs: LinkedPR[];
  cloudId?: string | undefined;
}

/**
 * Register PRs for an issue in the backend.
 * Uses RepoURL + IssueNumber — no prior Get lookup required.
 */
export async function createPRForIssue(params: CreatePRForIssueParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, linkedPRs, cloudId } = params;

  if (!apiClient) {
    return false;
  }

  if (linkedPRs.length === 0) {
    logDebug(`No PRs to register for issue #${issueNumber}`);
    return true;
  }

  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    logVerbose(`Registering ${linkedPRs.length} PR(s) for issue #${issueNumber}...`);

    let successCount = 0;
    for (const pr of linkedPRs) {
      const prUrl = `${repoUrl}/pull/${pr.number}`;

      let prStatus: GitPullRequestStatus;
      if (pr.state === 'MERGED') {
        prStatus = GitPullRequestStatus.Merged;
      } else if (pr.state === 'CLOSED') {
        prStatus = GitPullRequestStatus.Closed;
      } else {
        prStatus = GitPullRequestStatus.Open;
      }

      try {
        logDebug(`Registering PR #${pr.number} (${pr.state}) for issue #${issueNumber}...`);
        await apiClient.registerGitPullRequest({
          CloudID: cloudId ?? '',
          RepoURL: repoUrl,
          IssueNumber: issueNumber,
          Number: pr.number,
          URL: prUrl,
          Status: prStatus,
          Author: pr.author,
        });
        logVerbose(
          `✓ Registered PR #${pr.number} for issue #${issueNumber} with status ${GitPullRequestStatus[prStatus]}`
        );
        successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logWarn(`✗ Failed to register PR #${pr.number} for issue #${issueNumber}: ${errorMessage}`);
      }
    }

    return successCount > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn(`✗ Failed to register PRs for issue #${issueNumber}: ${errorMessage}`);
    return false;
  }
}

/**
 * Parameters for updating an issue status
 */
export interface UpdateIssueStatusParams {
  apiClient?: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  status: GitPullRequestStatus;
  cloudId?: string | undefined;
}

/**
 * Update the status of a Git issue in backend.
 * Uses Number + RepoURL — no prior Get lookup required.
 */
export async function updateIssueStatus(params: UpdateIssueStatusParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, status, cloudId } = params;

  if (!apiClient) {
    return false;
  }

  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    const statusName = GitPullRequestStatus[status] || 'Unknown';
    logVerbose(`Updating issue #${issueNumber} status to ${statusName} in backend...`);
    await apiClient.updateGitIssueStatus({
      CloudID: cloudId ?? '',
      Number: issueNumber,
      RepoURL: repoUrl,
      Status: status,
    });

    logVerbose(`✓ Updated issue #${issueNumber} status to ${statusName} in backend`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn(`✗ Failed to update issue #${issueNumber} status in backend: ${errorMessage}`);
    return false;
  }
}

/**
 * Parameters for updating a PR status
 */
export interface UpdatePRStatusParams {
  apiClient?: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  pullRequestNumber: number;
  status: GitPullRequestStatus;
  cloudId?: string | undefined;
}

/**
 * Update the status of a Git pull request in backend.
 * Uses IssueNumber + RepoURL + Number — no prior Get lookup required.
 */
export async function updatePRStatus(params: UpdatePRStatusParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, pullRequestNumber, status } = params;

  if (!apiClient) {
    return false;
  }

  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    const statusName = GitPullRequestStatus[status] || 'Unknown';
    logVerbose(
      `Updating PR #${pullRequestNumber} status to ${statusName} in backend (for issue #${issueNumber})...`
    );

    await apiClient.updateGitPullRequestStatus({
      IssueNumber: issueNumber,
      RepoURL: repoUrl,
      Number: pullRequestNumber,
      Status: status,
    });

    logVerbose(`✓ Updated PR #${pullRequestNumber} status to ${statusName} in backend`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn(`✗ Failed to update PR #${pullRequestNumber} status in backend: ${errorMessage}`);
    return false;
  }
}

/**
 * Parameters for closing an issue
 */
export interface CloseIssueParams {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  issueNumber: number;
  message: string;
  apiClient?: ApiClient;
  type: GitIssueType;
  findPRsLinkedToIssue: (issueNumber: number) => Promise<LinkedPR[]>;
  logMessage?: string;
  cloudId?: string | undefined;
}

/**
 * Close an issue on GitHub and update backend status.
 */
export async function closeIssue(params: CloseIssueParams): Promise<void> {
  const {
    octokit,
    owner,
    repo,
    issueNumber,
    message,
    apiClient,
    type,
    findPRsLinkedToIssue,
    logMessage,
    cloudId,
  } = params;

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: message,
  });
  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: IssueState.CLOSED,
  });

  if (logMessage) {
    logInfo(logMessage);
  } else {
    logInfo(`Closed issue #${issueNumber}`);
  }

  if (!apiClient) {
    logDebug('apiClient required for backend sync; skipping');
    return;
  }

  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const issueTitle = (issue.title?.trim() ?? '') || `Issue #${issueNumber}`;

  const createParams: CreateOrUpdateIssueParams = {
    apiClient,
    orgName: owner,
    repo,
    issueNumber,
    issueTitle,
    issueUrl: issue.html_url,
    riskSummary: issue.body || '',
    type,
    cloudId: cloudId ?? '',
  };
  const labels = issue.labels
    ?.map((l: { name?: string } | string) => (typeof l === 'string' ? l : l.name || ''))
    .filter(Boolean) as string[];
  if (labels && labels.length > 0) {
    createParams.labels = labels;
  }
  await createOrUpdateIssue(createParams);

  await updateIssueStatus({
    apiClient,
    orgName: owner,
    repo,
    issueNumber,
    status: GitPullRequestStatus.Closed,
    cloudId: cloudId ?? '',
  });

  const linkedPRs = await findPRsLinkedToIssue(issueNumber);
  if (linkedPRs.length > 0) {
    await createPRForIssue({
      apiClient,
      orgName: owner,
      repo,
      issueNumber,
      linkedPRs,
      cloudId: cloudId ?? '',
    });
  }
}

/**
 * Get repository and organization URLs from GitHub environment
 */
export function getRepoAndOrgUrls(
  owner: string,
  repo: string
): { repoUrl: string; orgUrl: string } {
  const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(/\/+$/, '');
  const repoUrl = `${serverUrl}/${owner}/${repo}`;
  const orgUrl = `${serverUrl}/${owner}`;
  return { repoUrl, orgUrl };
}
