/**
 * Utilities for source control issue and PR registration with backend
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import type { ApiClient } from '@averlon/shared';
import {
  SourceControlStatus,
  SourceControlIssueType,
  RiskStatus,
  type RegisterSourceControlIssueRequest,
  type GetSourceControlIssueResponse,
} from '@averlon/shared';
import { IssueState } from '@averlon/github-copilot-utils';

/**
 * Linked PR information
 */
export interface LinkedPR {
  number: number;
  author: string;
  state: string;
}

/**
 * Helper to extract issue ID from response (handles both nested and top-level structures)
 */
function getIssueIDFromResponse(
  response: GetSourceControlIssueResponse | null
): string | undefined {
  if (!response) return undefined;
  // API returns issue data directly at the top level
  return response.ID;
}

/**
 * Parameters for finding a source control issue
 */
export interface FindSourceControlIssueParams {
  apiClient: ApiClient;
  orgName: string;
  repo: string;
  issueNumber: number;
  cloudId?: string;
}

/**
 * Find a source control issue in the backend.
 * Returns the issue response (with NotFound flag) or null if there's an error.
 */
export async function findSourceControlIssue(
  params: FindSourceControlIssueParams
): Promise<GetSourceControlIssueResponse | null> {
  const { apiClient, orgName, repo, issueNumber, cloudId } = params;
  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  if (!cloudId) {
    core.debug('CloudID required for getSourceControlIssue; skipping');
    return null;
  }

  try {
    const request = {
      RepoURL: repoUrl,
      IssueNumber: issueNumber,
      CloudID: cloudId,
    };

    const findResponse = await apiClient.getSourceControlIssue(request);

    return findResponse;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Check if error is 404 Not Found
    const isNotFound =
      errorMessage.includes('404') ||
      errorMessage.includes('not_found') ||
      errorMessage.includes('Not Found');

    if (isNotFound) {
      return { NotFound: true };
    }
    // For other errors, log and return null
    core.debug(`Error finding issue #${issueNumber}: ${errorMessage}`);
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
  issueTitle: string; // Required - GitHub issue/PR title for backend registration
  issueUrl?: string; // Optional - will be constructed from orgName/repo/issueNumber if not provided
  riskSummary: string;
  riskStatus?: RiskStatus;
  type: SourceControlIssueType;
  labels?: string[];
  issueIDs?: number[];
  cloudId?: string;
}

/**
 * Create or update issue in backend (upsert).
 * Returns true if successful, false otherwise. Handles apiClient check internally.
 * Constructs issueUrl from orgName/repo/issueNumber if not provided.
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
  } = params;

  if (!apiClient) {
    return false;
  }

  if (!cloudId) {
    core.debug('CloudID required for registerSourceControlIssue; skipping');
    return false;
  }

  // Use fallback when title is missing; backend requires non-empty IssueTitle
  const trimmedTitle = (issueTitle?.trim() ?? '') || `Issue #${issueNumber}`;

  // Construct issueUrl if not provided
  const finalIssueUrl =
    issueUrl ||
    (() => {
      const { repoUrl } = getRepoAndOrgUrls(orgName, repo);
      return `${repoUrl}/issues/${issueNumber}`;
    })();

  // Create or update the issue (upsert)
  try {
    const { repoUrl, orgUrl } = getRepoAndOrgUrls(orgName, repo);
    core.info(
      `Creating/updating issue #${issueNumber} in backend (${SourceControlIssueType[type]})`
    );

    const registerRequest: RegisterSourceControlIssueRequest = {
      OrgName: orgName,
      OrgURL: orgUrl,
      RepoName: repo,
      RepoURL: repoUrl,
      IssueNumber: issueNumber,
      IssueURL: finalIssueUrl,
      IssueTitle: trimmedTitle,
      RiskSummary: riskSummary,
      RiskStatus: riskStatus ?? RiskStatus.None,
      Status: SourceControlStatus.Open,
      Type: type,
      CloudID: cloudId,
    };

    if (labels && labels.length > 0) {
      registerRequest.Labels = labels;
    }

    if (issueIDs && issueIDs.length > 0) {
      registerRequest.IssueIDs = issueIDs;
    }

    await apiClient.registerSourceControlIssue(registerRequest);

    core.info(
      `✓ Created/updated issue #${issueNumber} in backend${issueIDs && issueIDs.length > 0 ? ` (${issueIDs.length} related issue ID(s))` : ''}`
    );
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to create/update issue #${issueNumber}: ${errorMessage}`);
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
  cloudId?: string;
}

/**
 * Register PRs for an issue in the backend.
 * Returns true if successful, false otherwise. Handles apiClient check internally.
 */
export async function createPRForIssue(params: CreatePRForIssueParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, linkedPRs, cloudId } = params;

  if (!apiClient) {
    return false;
  }

  if (linkedPRs.length === 0) {
    core.debug(`No PRs to register for issue #${issueNumber}`);
    return true;
  }

  try {
    const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

    if (!cloudId) {
      core.debug('CloudID required for PR registration; skipping');
      return false;
    }

    // Get issue to obtain IssueID
    const findResponse = await findSourceControlIssue({
      apiClient,
      orgName,
      repo,
      issueNumber,
      cloudId,
    });

    // Extract issue ID (handles both response structures)
    const issueID = getIssueIDFromResponse(findResponse);

    if (!findResponse || findResponse.NotFound || !issueID) {
      core.warning(
        `Issue #${issueNumber} not found in backend, skipping PR registration. Request: orgName=${orgName}, repo=${repo}, issueNumber=${issueNumber}, repoUrl=${repoUrl}. Response: NotFound=${findResponse?.NotFound}, IssueID=${issueID}`
      );
      return false;
    }

    core.info(`Registering ${linkedPRs.length} PR(s) for issue #${issueNumber}...`);

    // Register each PR
    let successCount = 0;
    for (const pr of linkedPRs) {
      const prUrl = `${repoUrl}/pull/${pr.number}`;

      // Map GitHub PR state to SourceControlStatus
      let prStatus: SourceControlStatus;
      if (pr.state === 'MERGED') {
        prStatus = SourceControlStatus.Merged;
      } else if (pr.state === 'CLOSED') {
        prStatus = SourceControlStatus.Closed;
      } else {
        prStatus = SourceControlStatus.Open;
      }

      try {
        core.debug(`Registering PR #${pr.number} (${pr.state}) for issue #${issueNumber}...`);
        await apiClient.registerSourceControlPullRequest({
          SourceControlIssueID: issueID,
          PullRequestNumber: pr.number,
          PullRequestURL: prUrl,
          Status: prStatus,
          Author: pr.author,
          CloudID: cloudId,
        });
        core.info(
          `✓ Registered PR #${pr.number} for issue #${issueNumber} with status ${SourceControlStatus[prStatus]}`
        );
        successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        core.warning(
          `✗ Failed to register PR #${pr.number} for issue #${issueNumber}: ${errorMessage}`
        );
      }
    }

    return successCount > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`✗ Failed to register PRs for issue #${issueNumber}: ${errorMessage}`);
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
  status: SourceControlStatus;
  cloudId?: string;
}

/**
 * Update the status of a source control issue in backend.
 * Issue must exist in backend before calling this function.
 * Returns true if successful, false otherwise. Handles apiClient check internally.
 */
export async function updateIssueStatus(params: UpdateIssueStatusParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, status, cloudId } = params;

  if (!apiClient) {
    return false;
  }

  if (!cloudId) {
    core.debug('CloudID required for updateIssueStatus; skipping');
    return false;
  }

  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    const statusName = SourceControlStatus[status] || 'Unknown';

    // Check if issue exists
    const findResponse = await findSourceControlIssue({
      apiClient,
      orgName,
      repo,
      issueNumber,
      cloudId,
    });

    // Extract issue ID (handles both response structures)
    const issueID = getIssueIDFromResponse(findResponse);

    if (!findResponse || findResponse.NotFound || !issueID) {
      core.warning(
        `Issue #${issueNumber} not found in backend, cannot update status. Create the issue first.`
      );
      return false;
    }

    // Issue exists, update its status
    core.info(`Updating issue #${issueNumber} status to ${statusName} in backend...`);
    await apiClient.updateSourceControlIssueStatus({
      IssueID: issueID,
      RepoURL: repoUrl,
      Status: status,
      CloudID: cloudId,
    });

    core.info(`✓ Updated issue #${issueNumber} status to ${statusName} in backend`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`✗ Failed to update issue #${issueNumber} status in backend: ${errorMessage}`);
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
  status: SourceControlStatus;
  cloudId?: string;
}

/**
 * Update the status of a source control pull request in backend.
 * Returns true if successful, false otherwise. Handles apiClient check internally.
 */
export async function updatePRStatus(params: UpdatePRStatusParams): Promise<boolean> {
  const { apiClient, orgName, repo, issueNumber, pullRequestNumber, status, cloudId } = params;

  if (!apiClient) {
    return false;
  }

  const { repoUrl } = getRepoAndOrgUrls(orgName, repo);

  try {
    const statusName = SourceControlStatus[status] || 'Unknown';
    core.info(
      `Updating PR #${pullRequestNumber} status to ${statusName} in backend (for issue #${issueNumber})...`
    );

    if (!cloudId) {
      core.debug('CloudID required for updatePRStatus; skipping');
      return false;
    }

    // Get the issue to get the IssueID
    const findResponse = await findSourceControlIssue({
      apiClient,
      orgName,
      repo,
      issueNumber,
      cloudId,
    });

    // Extract issue ID (handles both response structures)
    const issueID = getIssueIDFromResponse(findResponse);

    if (!findResponse || findResponse.NotFound || !issueID) {
      core.debug(`Issue #${issueNumber} not found in backend, skipping PR status update`);
      return false;
    }

    await apiClient.updateSourceControlPullRequestStatus({
      SourceControlIssueID: issueID,
      RepoURL: repoUrl,
      PullRequestNumber: pullRequestNumber,
      Status: status,
    });

    core.info(`✓ Updated PR #${pullRequestNumber} status to ${statusName} in backend`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`✗ Failed to update PR #${pullRequestNumber} status in backend: ${errorMessage}`);
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
  type: SourceControlIssueType;
  findPRsLinkedToIssue: (issueNumber: number) => Promise<LinkedPR[]>;
  logMessage?: string; // Optional custom log message
  cloudId?: string;
}

/**
 * Close an issue on GitHub and update backend status.
 * Creates/updates the issue in backend if needed, then closes it and registers PRs.
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

  // Add comment and close issue on GitHub
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
    core.info(logMessage);
  } else {
    core.info(`Closed issue #${issueNumber}`);
  }

  // Backend sync requires CloudID; skip when not provided
  if (!cloudId || !apiClient) {
    core.debug('CloudID and apiClient required for backend sync; skipping');
    return;
  }

  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  // Use fallback when title is missing; backend requires non-empty IssueTitle
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
    cloudId,
  };
  const labels = issue.labels
    ?.map((l: { name?: string } | string) => (typeof l === 'string' ? l : l.name || ''))
    .filter(Boolean) as string[];
  if (labels && labels.length > 0) {
    createParams.labels = labels;
  }
  await createOrUpdateIssue(createParams);

  const updateParams: UpdateIssueStatusParams = {
    apiClient,
    orgName: owner,
    repo,
    issueNumber,
    status: SourceControlStatus.Closed,
    cloudId,
  };
  await updateIssueStatus(updateParams);

  const linkedPRs = await findPRsLinkedToIssue(issueNumber);
  if (linkedPRs.length > 0) {
    await createPRForIssue({
      apiClient,
      orgName: owner,
      repo,
      issueNumber,
      linkedPRs,
      cloudId,
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
