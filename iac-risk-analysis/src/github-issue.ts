import * as core from '@actions/core';
import type { ApiClient, AnalyzeTerraformResult } from '@averlon/shared';
import { GitIssueRiskStatus, GitIssueType } from '@averlon/shared';
import { createOrUpdateIssue } from '@averlon/github-actions-utils';
import { hasAccessRisksInParsed, getReachabilityExposureTypes } from './pr-comment';

const AVERLON_IAC_RISK_LABEL = 'averlon-iac-risk-analysis';

/**
 * Derives GitIssueRiskStatus and RiskSummary from scan result.
 * GitIssueRiskStatus = Detected when NewInternetExposures, NewInternetEgressExposures, or AccessAnalysis risks are present.
 */
export function deriveRiskStatusAndSummary(scanResult: string): {
  riskStatus: GitIssueRiskStatus;
  riskSummary: string;
} {
  try {
    const parsed = JSON.parse(scanResult) as AnalyzeTerraformResult;
    const { hasInternetExposures, hasEgressExposures } = getReachabilityExposureTypes(parsed);
    const hasAccessRisks = hasAccessRisksInParsed(parsed);
    const hasExposures = hasInternetExposures || hasEgressExposures || hasAccessRisks;

    if (hasExposures) {
      const parts: string[] = [];
      if (hasInternetExposures) parts.push('New internet exposures');
      if (hasEgressExposures) parts.push('New internet egress exposures');
      if (hasAccessRisks) parts.push('Access risks');
      const riskSummary = parts.join(' and ') + ' detected';
      return {
        riskStatus: GitIssueRiskStatus.Detected,
        riskSummary,
      };
    }
  } catch {
    // Fall through to default
  }

  return {
    riskStatus: GitIssueRiskStatus.None,
    riskSummary: '',
  };
}

export interface RegisterPrParams {
  apiClient: ApiClient | undefined;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  scanResult?: string;
  riskSummary?: string;
  cloudId?: string;
}

/**
 * Register a PR with source control ( a dummy issue created)
 * Does not create/update an issue when scan was skipped (e.g. identical base/head plans).
 */
export async function registerPrWithSourceControl(params: RegisterPrParams): Promise<boolean> {
  const {
    apiClient,
    owner,
    repo,
    prNumber,
    prUrl,
    prTitle,
    scanResult,
    riskSummary: riskSummaryOverride,
    cloudId,
  } = params;

  if (scanResult !== undefined && scanResult !== '') {
    try {
      const parsed = JSON.parse(scanResult) as { skipped?: boolean };
      if (parsed.skipped === true) {
        core.debug('Scan was skipped; not creating/updating source control issue.');
        return false;
      }
    } catch {
      // Not JSON or other parse error; continue and register as usual
    }
  }

  let riskSummary = riskSummaryOverride;
  let riskStatus: GitIssueRiskStatus | undefined;

  if (scanResult !== undefined && scanResult !== '') {
    const derived = deriveRiskStatusAndSummary(scanResult);
    if (riskSummary === undefined) {
      riskSummary = derived.riskSummary;
    }
    riskStatus = derived.riskStatus;
  }

  const hasRisk =
    riskStatus === GitIssueRiskStatus.Detected ||
    (riskSummaryOverride !== undefined && riskSummaryOverride.trim().length > 0);

  if (!hasRisk) {
    core.debug(
      'No infrastructure risk detected; skipping source control registration for this PR.'
    );
    return false;
  }

  if (riskSummary === undefined || riskSummary.trim().length === 0) {
    riskSummary = 'Infrastructure risk detected';
  }
  if (riskStatus === undefined) {
    riskStatus = GitIssueRiskStatus.Detected;
  }

  const issueTitle = prTitle ?? `Infrastructure Risk Analysis - PR #${prNumber}`;

  const registered = await createOrUpdateIssue({
    apiClient,
    orgName: owner,
    repo,
    issueNumber: prNumber,
    issueTitle,
    issueUrl: prUrl,
    riskSummary,
    riskStatus,
    type: GitIssueType.InfrastructureRisk,
    labels: [AVERLON_IAC_RISK_LABEL],
    cloudId: cloudId || '',
  });

  if (registered) {
    core.info(`✓ Registered PR #${prNumber} with source control (dashboard link: PR)`);
  }
  return registered;
}
