import * as core from '@actions/core';
import { createApiClient, CodeDefectStatus } from '@averlon/shared';

interface AgentFeedbackEntry {
  CodeDefectID: string;
  Status: number;
  Feedback: string;
}

interface StructuredOutput {
  feedback: AgentFeedbackEntry[];
}

function parseFeedbackFromOutput(output: string): AgentFeedbackEntry[] {
  if (!output) return [];

  try {
    const parsed: StructuredOutput = JSON.parse(output);
    if (!parsed.feedback || !Array.isArray(parsed.feedback)) {
      core.warning('Structured output missing "feedback" array');
      return [];
    }
    return parsed.feedback.filter(e => e.CodeDefectID && typeof e.Status === 'number');
  } catch (err) {
    core.warning(
      `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
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

  const entries = parseFeedbackFromOutput(codingAgentOutput);
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
