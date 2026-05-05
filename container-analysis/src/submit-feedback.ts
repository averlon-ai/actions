import * as core from '@actions/core';
import {
  createApiClient,
  CodeDefectStatus,
  RiskStatus,
  SourceControlIssueType,
} from '@averlon/shared';
import { createOrUpdateIssue } from '@averlon/github-actions-utils';

const AVERLON_CONTAINER_LABEL = 'averlon-container-analysis';

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

export function parseStructuredAgentOutput(output: string): ParsedStructuredOutput {
  if (!output) {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(output) as StructuredOutput;
    if (!parsed.feedback || !Array.isArray(parsed.feedback)) {
      core.warning('Structured output missing "feedback" array');
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
    core.warning(
      `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`
    );
    return { entries: [] };
  }
}

function parseFeedbackFromOutput(output: string): AgentFeedbackEntry[] {
  return parseStructuredAgentOutput(output).entries;
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
  core.info(`Found ${entries.length} feedback entries from Claude output`);

  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });
  let succeeded = 0;
  let failed = 0;

  // Track which defect IDs Claude reported on
  const reportedIds = new Set<string>();

  for (const entry of entries) {
    const status = entry.Status as CodeDefectStatus;
    if (status !== CodeDefectStatus.Fixed && status !== CodeDefectStatus.NoFix) {
      core.warning(
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
      core.info(
        `Submitted feedback for ${entry.CodeDefectID}: ${statusLabel}${entry.Feedback ? ` — ${entry.Feedback}` : ''}`
      );
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(
        `Failed to submit feedback for ${entry.CodeDefectID} (Status: ${entry.Status}): ${msg}`
      );
      failed++;
    }
  }

  // Submit Pending status for any defect IDs that Agent didn't report on
  const missingIds = allCodeDefectIds.filter(id => !reportedIds.has(id));
  if (missingIds.length > 0) {
    for (const id of missingIds) {
      try {
        await apiClient.updateCodeDefectFeedback({
          CodeDefectID: id,
          Status: CodeDefectStatus.Pending,
          Feedback: 'Coding Agent did not report on this defect',
        });
        core.warning(`Submitted feedback for ${id}: Pending`);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(
          `Failed to submit Pending feedback for ${id} (Status: ${CodeDefectStatus.Pending}): ${msg}`
        );
        failed++;
      }
    }
  }

  core.info(`Feedback submission complete: ${succeeded} succeeded, ${failed} failed`);

  const cloudId = process.env['AVERLON_CLOUD_ID'] || '';
  const githubRepository = process.env['GITHUB_REPOSITORY'] || '';
  const repoMatch = /^([^/]+)\/([^/]+)$/.exec(githubRepository.trim());
  const owner = repoMatch?.[1] ?? '';
  const repo = repoMatch?.[2] ?? '';

  if (cloudId && prNumber && prUrl && owner && repo) {
    try {
      const apiClientForSC = createApiClient({ apiKey, apiSecret, baseUrl });
      await createOrUpdateIssue({
        apiClient: apiClientForSC,
        orgName: owner,
        repo,
        issueNumber: prNumber,
        issueTitle: `Container Remediation - PR #${prNumber}`,
        issueUrl: prUrl,
        riskStatus: RiskStatus.None,
        riskSummary: '',
        type: SourceControlIssueType.Container,
        labels: [AVERLON_CONTAINER_LABEL],
        cloudId,
      });
      core.info(`Registered PR #${prNumber} with Averlon source control`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to register PR #${prNumber} with source control: ${msg}`);
    }
  }
}

async function run(): Promise<void> {
  try {
    core.info('Starting agent feedback submission...');
    await main();
    core.info('Feedback submission completed');
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
