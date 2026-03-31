import * as core from '@actions/core';
import type { ApiClient, AnalyzeTerraformResult } from '@averlon/shared';
import { RiskStatus, SourceControlIssueType } from '@averlon/shared';
import { createOrUpdateIssue } from '@averlon/github-actions-utils';
import { hasAccessRisksInParsed, getReachabilityExposureTypes } from './pr-comment';

const AVERLON_IAC_RISK_LABEL = 'averlon-iac-risk-analysis';

/**
 * Derives RiskStatus and RiskSummary from scan result.
 * RiskStatus = Detected when NewInternetExposures, NewInternetEgressExposures, or AccessAnalysis risks are present.
 */
export function deriveRiskStatusAndSummary(scanResult: string): {
  riskStatus: RiskStatus;
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
        riskStatus: RiskStatus.Detected,
        riskSummary,
      };
    }
  } catch {
    // Fall through to default
  }

  return {
    riskStatus: RiskStatus.None,
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
  let riskStatus: RiskStatus | undefined;

  if (scanResult !== undefined && scanResult !== '') {
    const derived = deriveRiskStatusAndSummary(scanResult);
    if (riskSummary === undefined) {
      riskSummary = derived.riskSummary;
    }
    riskStatus = derived.riskStatus;
  }
  if (riskSummary === undefined) {
    riskSummary = 'Infrastructure risk analysis';
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
    type: SourceControlIssueType.InfrastructureRisk,
    labels: [AVERLON_IAC_RISK_LABEL],
    cloudId,
  });

  if (registered) {
    core.info(`✓ Registered PR #${prNumber} with source control (dashboard link: PR)`);
  }
  return registered;
}
