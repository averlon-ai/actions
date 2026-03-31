import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import { RiskStatus } from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
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
    expect(result.riskStatus).toBe(RiskStatus.Detected);
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
    expect(result.riskStatus).toBe(RiskStatus.Detected);
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
    expect(result.riskStatus).toBe(RiskStatus.Detected);
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
    expect(result.riskStatus).toBe(RiskStatus.None);
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
    expect(result.riskStatus).toBe(RiskStatus.Detected);
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
    expect(result.riskStatus).toBe(RiskStatus.Detected);
    expect(result.riskSummary).toContain('New internet exposures');
    expect(result.riskSummary).toContain('Access risks');
  });
});

describe('registerPrWithSourceControl', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let createOrUpdateIssueSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createOrUpdateIssueSpy = spyOn(githubActionsUtils, 'createOrUpdateIssue').mockResolvedValue(
      true
    );
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    createOrUpdateIssueSpy.mockRestore();
  });

  it('should pass RiskStatus.Detected when both exposures are present', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: ['r1'],
          NewInternetEgressExposures: ['e1'],
        },
      },
    });
    const mockApiClient = {} as any;

    await registerPrWithSourceControl({
      apiClient: mockApiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(createOrUpdateIssueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        riskStatus: RiskStatus.Detected,
      })
    );
  });

  it('should pass RiskStatus.None when scan result has no exposures', async () => {
    const scanResult = JSON.stringify({
      ReachabilityAnalysis: {
        Summary: {
          NewInternetExposures: [],
          NewInternetEgressExposures: [],
        },
      },
    });
    const mockApiClient = {} as any;

    await registerPrWithSourceControl({
      apiClient: mockApiClient,
      owner: 'org',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      scanResult,
      cloudId: 'cloud-1',
    });

    expect(createOrUpdateIssueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        riskStatus: RiskStatus.None,
      })
    );
  });
});
