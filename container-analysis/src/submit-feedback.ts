import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  createApiClient,
  CodeDefectStatus,
  GitIssueRiskStatus,
  GitIssueType,
  GitPullRequestStatus,
  type ApiClient,
} from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
import {
  configureActionLogging,
  logInfo,
  logVerbose,
  logWarn,
} from '@averlon/github-actions-utils';
import { AVERLON_CONTAINER_LABEL } from './constants';

export { AVERLON_CONTAINER_LABEL };

interface AgentFeedbackEntry {
  CodeDefectID: string;
  Status: number;
  Feedback: string;
}

interface StructuredOutput {
  feedback: AgentFeedbackEntry[];
  pr_number?: number;
  pr_url?: string;
}

export interface ParsedStructuredOutput {
  entries: AgentFeedbackEntry[];
  pr_number?: number;
  pr_url?: string;
}

/** Map GitHub pull state to backend Git status (PR is the issue for container). */
export function mapPullRequestToGitStatus(pull: {
  state: string;
  merged?: boolean | null;
}): GitPullRequestStatus {
  if (pull.merged) {
    return GitPullRequestStatus.Merged;
  }
  if (pull.state === 'closed') {
    return GitPullRequestStatus.Closed;
  }
  return GitPullRequestStatus.Open;
}

export interface SyncLabeledContainerPRsParams {
  octokit: ReturnType<typeof github.getOctokit>;
  apiClient: ApiClient;
  orgName: string;
  repo: string;
  cloudId: string;
  touchedPrNumbers: Iterable<number>;
}

/**
 * Add the container label to a PR so later runs find it via the labeled listing.
 * GitHub creates the label on demand.
 */
export async function ensureContainerLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [AVERLON_CONTAINER_LABEL],
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to label PR #${prNumber} with ${AVERLON_CONTAINER_LABEL}: ${message}`);
    return false;
  }
}

/**
 * Upsert labeled container remediation PRs to the backend (PR number = issue number).
 * Skips PRs already handled in the current workflow run.
 */
export async function syncLabeledContainerPRsToBackend(
  params: SyncLabeledContainerPRsParams
): Promise<{ synced: number; failed: number }> {
  const { octokit, apiClient, orgName, repo, cloudId, touchedPrNumbers } = params;
  const { owner, repo: repoName } = githubActionsUtils.normalizeRepoScope(orgName, repo);
  const touched = new Set(touchedPrNumbers);
  const labeledPrs = await githubActionsUtils.listLabeledPullRequests(
    octokit,
    owner,
    repoName,
    AVERLON_CONTAINER_LABEL,
    'all'
  );
  const toSync = labeledPrs.filter(pr => !touched.has(pr.number));

  if (toSync.length === 0) {
    logVerbose(
      `No additional labeled container PRs to sync (${labeledPrs.length} labeled; ${touched.size} touched this run)`
    );
    return { synced: 0, failed: 0 };
  }

  logVerbose(
    `Syncing ${toSync.length} labeled container PR(s) to backend (${labeledPrs.length} total; ${touched.size} excluded as touched this run)`
  );

  const { repoUrl } = githubActionsUtils.getRepoAndOrgUrls(owner, repoName);
  let synced = 0;
  let failed = 0;

  for (const listed of toSync) {
    try {
      const { data: pull } = await octokit.rest.pulls.get({
        owner,
        repo: repoName,
        pull_number: listed.number,
      });
      const status = mapPullRequestToGitStatus(pull);
      const issueUrl = pull.html_url ?? `${repoUrl}/pull/${listed.number}`;
      const issueTitle =
        (pull.title?.trim() ?? '') ||
        listed.title ||
        `Container Remediation - PR #${listed.number}`;

      const ok = await githubActionsUtils.createOrUpdateIssue({
        apiClient,
        orgName: owner,
        repo: repoName,
        issueNumber: listed.number,
        issueTitle,
        issueUrl,
        riskSummary: '',
        riskStatus: GitIssueRiskStatus.None,
        type: GitIssueType.Container,
        labels: [AVERLON_CONTAINER_LABEL],
        cloudId: cloudId || '',
        status,
      });

      if (ok) {
        synced += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to sync labeled container PR #${listed.number} to backend: ${message}`);
    }
  }

  logInfo(
    `Labeled container PR backend sync complete: ${synced} PR(s) upserted${failed > 0 ? `, ${failed} failed` : ''}`
  );
  return { synced, failed };
}

export async function registerContainerRemediationPR(params: {
  apiClient: ApiClient;
  orgName: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  cloudId: string;
  status?: GitPullRequestStatus;
}): Promise<boolean> {
  const { apiClient, orgName, repo, prNumber, prUrl, cloudId, status } = params;
  return githubActionsUtils.createOrUpdateIssue({
    apiClient,
    orgName,
    repo,
    issueNumber: prNumber,
    issueTitle: `Container Remediation - PR #${prNumber}`,
    issueUrl: prUrl,
    riskStatus: GitIssueRiskStatus.None,
    riskSummary: '',
    type: GitIssueType.Container,
    labels: [AVERLON_CONTAINER_LABEL],
    cloudId: cloudId || '',
    status: status ?? GitPullRequestStatus.Open,
  });
}

export function parseStructuredAgentOutput(output: string): ParsedStructuredOutput {
  if (!output) {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(output) as StructuredOutput;
    if (!parsed.feedback || !Array.isArray(parsed.feedback)) {
      logWarn('Structured output missing "feedback" array');
      return { entries: [] };
    }
    const entries = parsed.feedback.filter(e => e.CodeDefectID && typeof e.Status === 'number');
    const out: ParsedStructuredOutput = { entries };
    if (typeof parsed.pr_number === 'number') {
      out.pr_number = parsed.pr_number;
    }
    if (typeof parsed.pr_url === 'string') {
      out.pr_url = parsed.pr_url;
    }
    return out;
  } catch (err) {
    logWarn(
      `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`
    );
    return { entries: [] };
  }
}

function parseFeedbackFromOutput(output: string): AgentFeedbackEntry[] {
  return parseStructuredAgentOutput(output).entries;
}

function parseGitHubRepository(repository: string): { owner: string; repo: string } {
  const repoMatch = /^([^/]+)\/([^/]+)$/.exec(repository.trim());
  return {
    owner: repoMatch?.[1] ?? '',
    repo: repoMatch?.[2] ?? '',
  };
}

async function main(): Promise<void> {
  const apiKey = process.env['AVERLON_API_KEY'];
  const apiSecret = process.env['AVERLON_API_SECRET'];
  const baseUrl = process.env['AVERLON_BASE_URL'] || 'https://wfe.prod.averlon.io/';
  const codingAgentOutput = process.env['CODING_AGENT_OUTPUT'] || '';

  if (!apiKey || !apiSecret) {
    throw new Error('AVERLON_API_KEY and AVERLON_API_SECRET are required');
  }

  core.setSecret(apiKey);
  core.setSecret(apiSecret);

  const allCodeDefectIdsRaw = process.env['ALL_CODE_DEFECT_IDS'] || '';
  const allCodeDefectIds = allCodeDefectIdsRaw
    ? allCodeDefectIdsRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  const {
    entries,
    pr_number: prNumber,
    pr_url: prUrl,
  } = parseStructuredAgentOutput(codingAgentOutput);
  logVerbose(`Found ${entries.length} feedback entries from Claude output`);

  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });
  let succeeded = 0;
  let failed = 0;

  const reportedIds = new Set<string>();

  for (const entry of entries) {
    const status = entry.Status as CodeDefectStatus;
    if (status !== CodeDefectStatus.Fixed && status !== CodeDefectStatus.NoFix) {
      logWarn(
        `Skipping CodeDefect ${entry.CodeDefectID}: invalid status ${entry.Status} (expected 3=Fixed or 4=NoFix)`
      );
      continue;
    }

    reportedIds.add(entry.CodeDefectID);

    try {
      await apiClient.updateCodeDefectFeedback({
        CodeDefectID: entry.CodeDefectID,
        Status: status,
        Feedback: entry.Feedback || '',
      });
      const statusLabel = status === CodeDefectStatus.Fixed ? 'Fixed' : 'NoFix';
      logVerbose(
        `Submitted feedback for ${entry.CodeDefectID}: ${statusLabel}${entry.Feedback ? ` — ${entry.Feedback}` : ''}`
      );
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(
        `Failed to submit feedback for ${entry.CodeDefectID} (Status: ${entry.Status}): ${msg}`
      );
      failed++;
    }
  }

  const missingIds = allCodeDefectIds.filter(id => !reportedIds.has(id));
  if (missingIds.length > 0) {
    for (const id of missingIds) {
      try {
        await apiClient.updateCodeDefectFeedback({
          CodeDefectID: id,
          Status: CodeDefectStatus.Pending,
          Feedback: 'Coding Agent did not report on this defect',
        });
        logWarn(`Submitted feedback for ${id}: Pending`);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(
          `Failed to submit Pending feedback for ${id} (Status: ${CodeDefectStatus.Pending}): ${msg}`
        );
        failed++;
      }
    }
  }

  logInfo(`Feedback submission complete: ${succeeded} succeeded, ${failed} failed`);

  const cloudId = process.env['AVERLON_CLOUD_ID'] || '';
  const githubRepository = process.env['GITHUB_REPOSITORY'] || '';
  const { owner, repo } = parseGitHubRepository(githubRepository);
  const githubToken = process.env['GITHUB_TOKEN'] || '';

  const touchedPrNumbers: number[] = [];

  if (prNumber && prUrl && owner && repo) {
    touchedPrNumbers.push(prNumber);
    const { owner: scopedOwner, repo: scopedRepo } = githubActionsUtils.normalizeRepoScope(
      owner,
      repo
    );
    try {
      let prStatus: GitPullRequestStatus | undefined;
      if (githubToken) {
        const octokit = github.getOctokit(githubToken);
        const { data: pull } = await octokit.rest.pulls.get({
          owner: scopedOwner,
          repo: scopedRepo,
          pull_number: prNumber,
        });
        prStatus = mapPullRequestToGitStatus(pull);
        await ensureContainerLabel(octokit, scopedOwner, scopedRepo, prNumber);
      }

      const registered = await registerContainerRemediationPR({
        apiClient,
        orgName: scopedOwner,
        repo: scopedRepo,
        prNumber,
        prUrl,
        cloudId,
        status: prStatus,
      });

      if (registered) {
        logInfo(`Registered PR #${prNumber} with Averlon source control`);
      } else {
        logWarn(`Failed to register PR #${prNumber} with source control`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Failed to register PR #${prNumber} with source control: ${msg}`);
    }
  }

  if (githubToken && owner && repo) {
    try {
      const { owner: scopedOwner, repo: scopedRepo } = githubActionsUtils.normalizeRepoScope(
        owner,
        repo
      );
      const octokit = github.getOctokit(githubToken);
      await syncLabeledContainerPRsToBackend({
        octokit,
        apiClient,
        orgName: scopedOwner,
        repo: scopedRepo,
        cloudId,
        touchedPrNumbers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Labeled container PR bulk sync failed: ${msg}`);
    }
  } else if (owner && repo) {
    logWarn(
      'GITHUB_TOKEN not available; skipping labeled container PR bulk sync (provide github-token input or workflow GITHUB_TOKEN)'
    );
  }
}

async function run(): Promise<void> {
  const verbose = process.env['INPUT_VERBOSE']?.toLowerCase() === 'true';
  configureActionLogging({ verbose });

  try {
    logInfo('Starting agent feedback submission...');
    await main();
    logInfo('Feedback submission completed');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Feedback submission failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred during feedback submission');
    }
  }
}

export { run, parseFeedbackFromOutput };

if (require.main === module) {
  run();
}
