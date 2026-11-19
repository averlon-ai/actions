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
  type TicketRequest,
} from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
import {
  configureActionLogging,
  logInfo,
  logVerbose,
  logWarn,
} from '@averlon/github-actions-utils';
import { readAllCodeDefectIds } from './code-defect-ids';
import { DEFAULT_BASE_URL } from './constants';
import { parseTicketOptions } from './ticket-options';

/** Averlon returns 400 when a ticket request is invalid or the org has no single issue tracker. */
const HTTP_BAD_REQUEST = 400;

/** How an action labels the PRs of its agent and registers them with Averlon. */
export interface AgentPrRegistration {
  /** Name of the PRs in logs, e.g. "container". */
  name: string;
  /** Label that marks the agent PRs, so later runs find them. */
  label: string;
  /** Git issue type of the registered PRs. */
  type: GitIssueType;
  /** Title of a PR without a title, before " - PR #<number>". */
  titlePrefix: string;
}

interface AgentFeedbackEntry {
  CodeDefectID: string;
  Status: number;
  Feedback: string;
  /** URL of the PR that fixed the defect, for a Fixed entry. */
  pr_url?: string;
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

/** Map GitHub pull state to backend Git status (the PR is the issue). */
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

export interface SyncLabeledAgentPRsParams {
  octokit: ReturnType<typeof github.getOctokit>;
  apiClient: ApiClient;
  registration: AgentPrRegistration;
  orgName: string;
  repo: string;
  cloudId: string;
  touchedPrNumbers: Iterable<number>;
}

/**
 * Add the label to a PR so later runs find it via the labeled listing.
 * GitHub creates the label on demand.
 */
export async function ensurePrLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  label: string
): Promise<boolean> {
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [label],
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to label PR #${prNumber} with ${label}: ${message}`);
    return false;
  }
}

/**
 * Upsert labeled agent PRs to the backend (PR number = issue number).
 * Skips PRs already handled in the current workflow run.
 */
export async function syncLabeledAgentPRsToBackend(
  params: SyncLabeledAgentPRsParams
): Promise<{ synced: number; failed: number }> {
  const { octokit, apiClient, registration, orgName, repo, cloudId, touchedPrNumbers } = params;
  const { name, label } = registration;
  const { owner, repo: repoName } = githubActionsUtils.normalizeRepoScope(orgName, repo);
  const touched = new Set(touchedPrNumbers);
  const labeledPrs = await githubActionsUtils.listLabeledPullRequests(
    octokit,
    owner,
    repoName,
    label,
    'all'
  );
  const toSync = labeledPrs.filter(pr => !touched.has(pr.number));

  if (toSync.length === 0) {
    logVerbose(
      `No additional labeled ${name} PRs to sync (${labeledPrs.length} labeled; ${touched.size} touched this run)`
    );
    return { synced: 0, failed: 0 };
  }

  logVerbose(
    `Syncing ${toSync.length} labeled ${name} PR(s) to backend (${labeledPrs.length} total; ${touched.size} excluded as touched this run)`
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
      const id = await registerAgentPR({
        apiClient,
        registration,
        orgName: owner,
        repo: repoName,
        prNumber: listed.number,
        prUrl: pull.html_url ?? `${repoUrl}/pull/${listed.number}`,
        title: (pull.title?.trim() ?? '') || listed.title,
        cloudId,
        status: mapPullRequestToGitStatus(pull),
      });

      if (id) {
        synced += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to sync labeled ${name} PR #${listed.number} to backend: ${message}`);
    }
  }

  logInfo(
    `Labeled ${name} PR backend sync complete: ${synced} PR(s) upserted${failed > 0 ? `, ${failed} failed` : ''}`
  );
  return { synced, failed };
}

/**
 * Register an agent PR as a PR with no Git issue. Returns the ID of the PR row,
 * or undefined when it could not be registered (the reason is logged).
 */
export async function registerAgentPR(params: {
  apiClient: ApiClient;
  registration: AgentPrRegistration;
  orgName: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  /** PR title; defaults to "<titlePrefix> - PR #<number>". */
  title?: string | undefined;
  cloudId: string;
  status?: GitPullRequestStatus | undefined;
  /** Ask Averlon to create a ticket for the PR; only PRs of this run pass it. */
  ticket?: TicketRequest | undefined;
}): Promise<string | undefined> {
  const {
    apiClient,
    registration,
    orgName,
    repo,
    prNumber,
    prUrl,
    title,
    cloudId,
    status,
    ticket,
  } = params;
  const { repoUrl, orgUrl } = githubActionsUtils.getRepoAndOrgUrls(orgName, repo);
  const register = (withTicket: TicketRequest | undefined) =>
    apiClient.registerGitPullRequest({
      CloudID: cloudId || '',
      OrgName: orgName,
      OrgURL: orgUrl,
      RepoName: repo,
      RepoURL: repoUrl,
      Number: prNumber,
      URL: prUrl,
      Title: title || `${registration.titlePrefix} - PR #${prNumber}`,
      Type: registration.type,
      Labels: [registration.label],
      RiskStatus: GitIssueRiskStatus.None,
      Status: status ?? GitPullRequestStatus.Open,
      ...(withTicket ? { Ticket: withTicket } : {}),
    });
  try {
    let pr;
    try {
      pr = await register(ticket);
    } catch (error) {
      // Averlon rejects the whole registration when the ticket cannot be created,
      // e.g. no Jira or Linear integration; register the PR without the ticket.
      if (!ticket || !(error instanceof ApiRequestError) || error.status !== HTTP_BAD_REQUEST) {
        throw error;
      }
      logWarn(`No ticket for PR #${prNumber}: ${error.message}`);
      pr = await register(undefined);
    }
    if (!pr?.ID) {
      logWarn(`Registered PR #${prNumber}, but the response has no PR ID`);
      return undefined;
    }
    return pr.ID;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to register PR #${prNumber}: ${message}`);
    return undefined;
  }
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
      entries = parsed.feedback
        .filter(e => e.CodeDefectID && typeof e.Status === 'number')
        .map(e => ({
          CodeDefectID: e.CodeDefectID,
          Status: e.Status,
          Feedback: e.Feedback,
          ...(typeof e.pr_url === 'string' && e.pr_url !== '' ? { pr_url: e.pr_url } : {}),
        }));
    }
    return { entries, pull_requests: pullRequests };
  } catch (err) {
    logWarn(
      `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`
    );
    return { entries: [], pull_requests: [] };
  }
}

export interface RegisteredAgentPRs {
  /** PR numbers handled in this run, for the bulk sync to skip. */
  handled: number[];
  /** ID of each registered PR row, by PR number. */
  prIdByNumber: Map<number, string>;
}

/**
 * Label every PR the agent opened and register it with Averlon. One run can
 * open several PRs (e.g. a runtime upgrade and a dependency upgrade); each one
 * needs the label so later runs find it. A failure on one PR does not stop the
 * others.
 */
export async function labelAndRegisterAgentPRs(params: {
  octokit?: ReturnType<typeof github.getOctokit> | undefined;
  apiClient: ApiClient;
  registration: AgentPrRegistration;
  orgName: string;
  repo: string;
  cloudId: string;
  pullRequests: AgentPullRequest[];
  /** Ticket options; set to ask Averlon for a ticket for each PR. */
  ticket?: TicketRequest | undefined;
}): Promise<RegisteredAgentPRs> {
  const { octokit, apiClient, registration, orgName, repo, cloudId, pullRequests, ticket } = params;
  const handled: number[] = [];
  const prIdByNumber = new Map<number, string>();
  for (const { pr_number: prNumber, pr_url: prUrl } of pullRequests) {
    handled.push(prNumber);
    try {
      let prStatus: GitPullRequestStatus | undefined;
      let prTitle: string | undefined;
      if (octokit) {
        const { data: pull } = await octokit.rest.pulls.get({
          owner: orgName,
          repo,
          pull_number: prNumber,
        });
        prStatus = mapPullRequestToGitStatus(pull);
        // Register the PR with its GitHub title, as the bulk sync does, and
        // not only "<titlePrefix> - PR #<number>".
        prTitle = pull.title?.trim() || undefined;
        await ensurePrLabel(octokit, orgName, repo, prNumber, registration.label);
      }

      const id = await registerAgentPR({
        apiClient,
        registration,
        orgName,
        repo,
        prNumber,
        prUrl,
        title: prTitle,
        cloudId,
        status: prStatus,
        // the ticket summary is the GitHub PR title; Averlon adds the type name in front
        ticket: ticket && prTitle ? { ...ticket, Summary: prTitle } : ticket,
      });

      if (id) {
        prIdByNumber.set(prNumber, id);
        logInfo(`Registered PR #${prNumber} with Averlon source control`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Failed to register PR #${prNumber} with source control: ${msg}`);
    }
  }
  return { handled, prIdByNumber };
}

/**
 * Number of the PR in a GitHub PR URL: .../pull/<n>, or an API .../pulls/<n>
 * URL, with any path, query or fragment after the number. Undefined when the
 * URL has no PR number.
 */
function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pulls?\/(\d+)(?=[/?#]|$)/.exec(url.trim());
  const prNumber = match ? Number(match[1]) : NaN;
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : undefined;
}

/**
 * ID of the PR that fixed a Fixed entry: the PR named by its pr_url, matched
 * by the PR number in the URL (one run works in one repository), so another
 * form of the same URL also matches. With no pr_url, an entry with empty
 * feedback (a PR changed code) goes to the only PR of the run; a rebuild-only
 * fix has feedback and gets no PR.
 */
export function prIdForEntry(
  entry: AgentFeedbackEntry,
  prIdByNumber: Map<number, string>
): string | undefined {
  if (entry.Status !== CodeDefectStatus.Fixed) {
    return undefined;
  }
  if (entry.pr_url) {
    const prNumber = prNumberFromUrl(entry.pr_url);
    const id = prNumber === undefined ? undefined : prIdByNumber.get(prNumber);
    if (!id) {
      logWarn(
        `CodeDefect ${entry.CodeDefectID}: ${entry.pr_url} is not a PR registered in this run; the feedback has no PR link`
      );
    }
    return id;
  }
  if (prIdByNumber.size === 1 && !entry.Feedback) {
    return prIdByNumber.values().next().value;
  }
  return undefined;
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
  prId?: string | undefined;
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
  /** ID of each PR registered in this run, by PR number; links Fixed defects to their PR. */
  prIdByNumber?: Map<number, string>;
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<FeedbackSubmissionResult> {
  const {
    apiClient,
    entries,
    allCodeDefectIds,
    prIdByNumber = new Map<number, string>(),
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
    updates.push({
      id: entry.CodeDefectID,
      status,
      feedback: entry.Feedback || '',
      prId: prIdForEntry(entry, prIdByNumber),
    });
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
        ...(update.prId ? { GitPullRequestID: update.prId } : {}),
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

async function main(registration: AgentPrRegistration): Promise<void> {
  const apiKey = process.env['AVERLON_API_KEY'];
  const apiSecret = process.env['AVERLON_API_SECRET'];
  const baseUrl = process.env['AVERLON_BASE_URL'] || DEFAULT_BASE_URL;
  const codingAgentOutput = process.env['CODING_AGENT_OUTPUT'] || '';

  if (!apiKey || !apiSecret) {
    throw new Error('AVERLON_API_KEY and AVERLON_API_SECRET are required');
  }

  core.setSecret(apiKey);
  core.setSecret(apiSecret);

  const allCodeDefectIds = readAllCodeDefectIds();

  const { entries, pull_requests: pullRequests } = parseStructuredAgentOutput(codingAgentOutput);
  logInfo(
    `Found ${entries.length} feedback entries and ${pullRequests.length} PR(s) in agent output`
  );

  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });
  const cloudId = process.env['AVERLON_CLOUD_ID'] || '';
  const githubRepository = process.env['GITHUB_REPOSITORY'] || '';
  const { owner, repo } = parseGitHubRepository(githubRepository);
  const githubToken = process.env['GITHUB_TOKEN'] || '';

  // Register the PRs first: the feedback of a Fixed defect names the ID of its PR.
  let registered: RegisteredAgentPRs = { handled: [], prIdByNumber: new Map() };
  if (pullRequests.length > 0 && owner && repo) {
    const { owner: scopedOwner, repo: scopedRepo } = githubActionsUtils.normalizeRepoScope(
      owner,
      repo
    );
    registered = await labelAndRegisterAgentPRs({
      octokit: githubToken ? github.getOctokit(githubToken) : undefined,
      apiClient,
      registration,
      orgName: scopedOwner,
      repo: scopedRepo,
      cloudId,
      pullRequests,
      ticket: parseTicketOptions(),
    });
  }

  logFeedbackSummary(
    await submitDefectFeedback({
      apiClient,
      entries,
      allCodeDefectIds,
      prIdByNumber: registered.prIdByNumber,
    })
  );

  if (githubToken && owner && repo) {
    try {
      const { owner: scopedOwner, repo: scopedRepo } = githubActionsUtils.normalizeRepoScope(
        owner,
        repo
      );
      const octokit = github.getOctokit(githubToken);
      await syncLabeledAgentPRsToBackend({
        octokit,
        apiClient,
        registration,
        orgName: scopedOwner,
        repo: scopedRepo,
        cloudId,
        touchedPrNumbers: registered.handled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Labeled ${registration.name} PR bulk sync failed: ${msg}`);
    }
  } else if (owner && repo) {
    logWarn(
      `GITHUB_TOKEN not available; skipping labeled ${registration.name} PR bulk sync (provide github-token input or workflow GITHUB_TOKEN)`
    );
  }
}

/** Run the Submit Agent Feedback step of an action. */
export async function runSubmitFeedback(registration: AgentPrRegistration): Promise<void> {
  const verbose = process.env['INPUT_VERBOSE']?.toLowerCase() === 'true';
  configureActionLogging({ verbose });

  try {
    logInfo('Starting agent feedback submission...');
    await main(registration);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Feedback submission failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred during feedback submission');
    }
  }
}
