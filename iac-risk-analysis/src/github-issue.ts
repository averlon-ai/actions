import * as core from '@actions/core';
import type { ApiClient } from '@averlon/shared';
import { SourceControlIssueType } from '@averlon/shared';
import { createOrUpdateIssue } from '@averlon/github-actions-utils';
import { hasRisksInResult } from './pr-comment';

const AVERLON_IAC_RISK_LABEL = 'averlon-iac-risk-analysis';

export interface RegisterPrParams {
  apiClient: ApiClient | undefined;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  scanResult?: string;
  riskSummary?: string;
}

/**
 * Register a PR with source control ( a dummy issue created)
 */
export async function registerPrWithSourceControl(params: RegisterPrParams): Promise<boolean> {
  const {
    apiClient,
    owner,
    repo,
    prNumber,
    prUrl,
    scanResult,
    riskSummary: riskSummaryOverride,
  } = params;

  let riskSummary = riskSummaryOverride;
  if (riskSummary === undefined && scanResult !== undefined && scanResult !== '') {
    try {
      riskSummary = hasRisksInResult(scanResult)
        ? 'Infrastructure risk analysis (issues detected)'
        : 'Infrastructure risk analysis (no issues detected)';
    } catch {
      riskSummary = 'Infrastructure risk analysis';
    }
  }
  if (riskSummary === undefined) {
    riskSummary = 'Infrastructure risk analysis';
  }

  const registered = await createOrUpdateIssue({
    apiClient,
    orgName: owner,
    repo,
    issueNumber: prNumber,
    issueUrl: prUrl,
    riskSummary,
    type: SourceControlIssueType.InfrastructureRisk,
    labels: [AVERLON_IAC_RISK_LABEL],
  });

  if (registered) {
    core.info(`✓ Registered PR #${prNumber} with source control (dashboard link: PR)`);
  }
  return registered;
}
