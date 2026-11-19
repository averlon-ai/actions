import { describe, it, expect, spyOn, mock, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import { GitIssueRiskStatus, GitPullRequestStatus } from '@averlon/shared';
import { deriveRiskStatusAndSummary, registerPrWithSourceControl } from '../../src/github-issue';

describe('deriveRiskStatusAndSummary', () => {
  it('should return Detected when both NewInternetExposures and NewInternetEgressExposures are present', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: ['resource1', 'resource2'],
          NewInternetEgressExposures: ['egress1'],
        },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.Detected);
    expect(result.riskSummary).toContain('New internet exposures');
    expect(result.riskSummary).toContain('New internet egress exposures');
  });

  it('should return Detected when only NewInternetExposures is present', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: ['resource1'],
          NewInternetEgressExposures: [],
        },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.Detected);
    expect(result.riskSummary).toBe('New internet exposures detected');
  });

  it('should return Detected when only NewInternetEgressExposures is present', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: [],
          NewInternetEgressExposures: ['egress1'],
        },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.Detected);
    expect(result.riskSummary).toBe('New internet egress exposures detected');
  });

  it('should return None when both are empty', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: [],
          NewInternetEgressExposures: [],
        },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.None);
  });

  it('should return Detected when AccessAnalysis has risks', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: { NewInternetExposures: [], NewInternetEgressExposures: [] },
      },
      AccessAnalysis: {
        Summary: {
          RiskSummary: JSON.stringify([
            { principalId: 'arn:aws:iam::123:role/test', targetResource: 's3://bucket' },
          ]),
        },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.Detected);
    expect(result.riskSummary).toBe('Access risks detected');
  });

  it('should combine reachability and access risks in summary', () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: ['r1'],
          NewInternetEgressExposures: [],
        },
      },
      AccessAnalysis: {
        Summary: { RiskSummary: JSON.stringify([{ principalId: 'p1' }]) },
      },
    });
    const result = deriveRiskStatusAndSummary(scanResult);
    expect(result.riskStatus).toBe(GitIssueRiskStatus.Detected);
    expect(result.riskSummary).toContain('New internet exposures');
    expect(result.riskSummary).toContain('Access risks');
  });
});

describe('registerPrWithSourceControl', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  const registerGitPullRequest = mock(() => Promise.resolve({ ID: 'pr-id' }));
  const apiClient = { registerGitPullRequest } as any;

  beforeEach(() => {
    registerGitPullRequest.mockClear();
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('should pass GitIssueRiskStatus.Detected when both exposures are present', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: ['r1'],
          NewInternetEgressExposures: ['e1'],
        },
      },
    });
    const mockApiClient = apiClient;

    await registerPrWithSourceControl({
      apiClient: mockApiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        RiskStatus: GitIssueRiskStatus.Detected,
      })
    );
  });

  it('should not register when scan result has no exposures', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: [],
          NewInternetEgressExposures: [],
        },
      },
    });
    const mockApiClient = apiClient;

    const result = await registerPrWithSourceControl({
      apiClient: mockApiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(result).toBe(false);
    expect(registerGitPullRequest).not.toHaveBeenCalled();
  });

  it('should not register when no scan result and no risk summary override', async () => {
    const result = await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      cloudId: 'cloud-1',
    });

    expect(result).toBe(false);
    expect(registerGitPullRequest).not.toHaveBeenCalled();
  });

  it('should return false and not register when scan was skipped', async () => {
    const scanResult = JSON.stringify({ skipped: true });

    const result = await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(result).toBe(false);
    expect(registerGitPullRequest).not.toHaveBeenCalled();
  });

  it('should use prTitle when provided', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: { NewInternetExposures: ['r1'], NewInternetEgressExposures: [] },
      },
    });
    await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 5,
      prUrl: 'https://github.com/org/repo/pull/5',
      prTitle: 'Fix: reduce egress exposure',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ Title: 'Fix: reduce egress exposure' })
    );
  });

  it('should default issueTitle to "Infrastructure Risk Analysis - PR #N" when prTitle absent', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: { NewInternetExposures: ['r1'], NewInternetEgressExposures: [] },
      },
    });
    await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 7,
      prUrl: 'https://github.com/org/repo/pull/7',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ Title: 'Infrastructure Risk Analysis - PR #7' })
    );
  });

  it('should use riskSummaryOverride when provided, ignoring derived summary', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: { NewInternetExposures: ['r1'], NewInternetEgressExposures: [] },
      },
    });

    await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 2,
      prUrl: 'https://github.com/org/repo/pull/2',
      scanResult,
      riskSummary: 'Custom summary',
      cloudId: 'cloud-1',
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ RiskSummary: 'Custom summary' })
    );
  });

  it('should register as InfrastructureRisk type as a PR with no Git issue', async () => {
    const { GitIssueType } = await import('@averlon/shared');
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: { NewInternetExposures: ['r1'], NewInternetEgressExposures: [] },
      },
    });

    await registerPrWithSourceControl({
      apiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 3,
      prUrl: 'https://github.com/org/repo/pull/3',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        Type: GitIssueType.InfrastructureRisk,
        URL: 'https://github.com/org/repo/pull/3',
        Number: 3,
        Status: GitPullRequestStatus.Open,
      })
    );
  });
});
