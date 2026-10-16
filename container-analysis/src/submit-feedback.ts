import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  ApiRequestError,
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

export interface AgentPullRequest {
  pr_number: number;
  pr_url: string;
}

interface StructuredOutput {
  feedback: AgentFeedbackEntry[];
  pull_requests?: unknown;
}

export interface ParsedStructuredOutput {
  entries: AgentFeedbackEntry[];
  /** Every PR the agent reported, deduplicated by number, in reported order. */
  pull_requests: AgentPullRequest[];
}

function isAgentPullRequest(value: unknown): value is AgentPullRequest {
  const pr = value as Partial<AgentPullRequest> | null;
  return (
    typeof pr === 'object' &&
    pr !== null &&
    typeof pr.pr_number === 'number' &&
    Number.isInteger(pr.pr_number) &&
    pr.pr_number > 0 &&
    typeof pr.pr_url === 'string' &&
    pr.pr_url !== ''
  );
}

/** Collect the reported PRs, without duplicates. */
function collectPullRequests(parsed: StructuredOutput): AgentPullRequest[] {
  const candidates: unknown[] = Array.isArray(parsed.pull_requests) ? parsed.pull_requests : [];
  const seen = new Set<number>();
  const prs: AgentPullRequest[] = [];
  for (const candidate of candidates) {
    if (isAgentPullRequest(candidate) && !seen.has(candidate.pr_number)) {
      seen.add(candidate.pr_number);
      prs.push({ pr_number: candidate.pr_number, pr_url: candidate.pr_url });
    }
  }
  return prs;
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
    return { entries: [], pull_requests: [] };
  }
  try {
    const parsed = JSON.parse(output) as StructuredOutput;
    // PRs are kept even when feedback is malformed: they exist on GitHub
    // either way and still need the label.
    const pullRequests = collectPullRequests(parsed);
    let entries: AgentFeedbackEntry[] = [];
    if (!parsed.feedback || !Array.isArray(parsed.feedback)) {
      logWarn('Structured output missing "feedback" array');
    } else {
      entries = parsed.feedback.filter(e => e.CodeDefectID && typeof e.Status === 'number');
    }
    return { entries, pull_requests: pullRequests };
  } catch (err) {
    logWarn(
      `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`
    );
    return { entries: [], pull_requests: [] };
  }
}

function parseFeedbackFromOutput(output: string): AgentFeedbackEntry[] {
  return parseStructuredAgentOutput(output).entries;
}

/**
 * Label every PR the agent opened and register it with Averlon. One run can
 * open several PRs (e.g. a runtime upgrade and a dependency upgrade); each one
 * needs the label so later runs find it. A failure on one PR does not stop the
 * others. Returns the PR numbers handled, for the bulk sync to skip.
 */
export async function labelAndRegisterAgentPRs(params: {
  octokit?: ReturnType<typeof github.getOctokit>;
  apiClient: ApiClient;
  orgName: string;
  repo: string;
  cloudId: string;
  pullRequests: AgentPullRequest[];
}): Promise<number[]> {
  const { octokit, apiClient, orgName, repo, cloudId, pullRequests } = params;
  const handled: number[] = [];
  for (const { pr_number: prNumber, pr_url: prUrl } of pullRequests) {
    handled.push(prNumber);
    try {
      let prStatus: GitPullRequestStatus | undefined;
      if (octokit) {
        const { data: pull } = await octokit.rest.pulls.get({
          owner: orgName,
          repo,
          pull_number: prNumber,
        });
        prStatus = mapPullRequestToGitStatus(pull);
        await ensureContainerLabel(octokit, orgName, repo, prNumber);
      }

      const registered = await registerContainerRemediationPR({
        apiClient,
        orgName,
        repo,
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
  return handled;
}

/** Wait between feedback requests so a run with many defects stays under the API rate limit. */
export const FEEDBACK_REQUEST_INTERVAL_MS = 200;

export interface FeedbackSubmissionResult {
  succeeded: number;
  failed: number;
  /** Saved updates by status name, e.g. { NoFix: 70 }. */
  savedByStatus: Record<string, number>;
  /** Updates not saved, by status name. */
  failedByStatus: Record<string, number>;
  /** One line per update not saved, e.g. "Feedback for 123 (NoFix) not saved: 429 Too Many Requests". */
  failureLines: string[];
}

interface FeedbackUpdate {
  id: string;
  status: CodeDefectStatus;
  feedback: string;
}

function statusName(status: CodeDefectStatus): string {
  return CodeDefectStatus[status] ?? String(status);
}

/** Short error text for logs: the HTTP status for API errors, the message otherwise. */
function describeFeedbackError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return `${err.status} ${err.statusText}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${key} ${count}`)
    .join(', ');
}

/**
 * Send the agent's feedback for each defect, and Pending for each defect the
 * agent did not report on. Requests go one at a time with a short wait between them.
 * The caller logs the result with logFeedbackSummary.
 */
export async function submitDefectFeedback(params: {
  apiClient: ApiClient;
  entries: AgentFeedbackEntry[];
  allCodeDefectIds: string[];
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<FeedbackSubmissionResult> {
  const {
    apiClient,
    entries,
    allCodeDefectIds,
    intervalMs = FEEDBACK_REQUEST_INTERVAL_MS,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = params;

  const updates: FeedbackUpdate[] = [];
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
    updates.push({ id: entry.CodeDefectID, status, feedback: entry.Feedback || '' });
  }
  for (const id of allCodeDefectIds) {
    if (!reportedIds.has(id)) {
      updates.push({
        id,
        status: CodeDefectStatus.Pending,
        feedback: 'Coding Agent did not report on this defect',
      });
    }
  }

  const result: FeedbackSubmissionResult = {
    succeeded: 0,
    failed: 0,
    savedByStatus: {},
    failedByStatus: {},
    failureLines: [],
  };

  for (const [index, update] of updates.entries()) {
    if (index > 0 && intervalMs > 0) {
      await wait(intervalMs);
    }
    const name = statusName(update.status);
    try {
      await apiClient.updateCodeDefectFeedback({
        CodeDefectID: update.id,
        Status: update.status,
        Feedback: update.feedback,
      });
      logVerbose(
        `Feedback for ${update.id} (${name}) saved${update.feedback ? ` — ${update.feedback}` : ''}`
      );
      result.succeeded++;
      increment(result.savedByStatus, name);
    } catch (err) {
      const reason = describeFeedbackError(err);
      result.failureLines.push(`Feedback for ${update.id} (${name}) not saved: ${reason}`);
      result.failed++;
      increment(result.failedByStatus, name);
    }
  }

  return result;
}

/**
 * Log updates not saved as a collapsed group with counts by status in the title,
 * then the saved counts by status.
 */
export function logFeedbackSummary(result: FeedbackSubmissionResult): void {
  if (result.failed > 0) {
    core.startGroup(`Feedback not saved (${formatCounts(result.failedByStatus)})`);
    for (const line of result.failureLines) {
      logInfo(line);
    }
    core.endGroup();
  }
  logInfo(`Feedback saved (${result.succeeded > 0 ? formatCounts(result.savedByStatus) : '0'})`);
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

  const { entries, pull_requests: pullRequests } = parseStructuredAgentOutput(codingAgentOutput);
  logInfo(
    `Found ${entries.length} feedback entries and ${pullRequests.length} PR(s) in agent output`
  );

  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });
  logFeedbackSummary(
    await submitDefectFeedback({
      apiClient,
      entries,
      allCodeDefectIds,
    })
  );

  const cloudId = process.env['AVERLON_CLOUD_ID'] || '';
  const githubRepository = process.env['GITHUB_REPOSITORY'] || '';
  const { owner, repo } = parseGitHubRepository(githubRepository);
  const githubToken = process.env['GITHUB_TOKEN'] || '';

  const touchedPrNumbers: number[] = [];

  if (pullRequests.length > 0 && owner && repo) {
    const { owner: scopedOwner, repo: scopedRepo } = githubActionsUtils.normalizeRepoScope(
      owner,
      repo
    );
    touchedPrNumbers.push(
      ...(await labelAndRegisterAgentPRs({
        octokit: githubToken ? github.getOctokit(githubToken) : undefined,
        apiClient,
        orgName: scopedOwner,
        repo: scopedRepo,
        cloudId,
        pullRequests,
      }))
    );
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
