import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { configureActionLogging, GitPullRequestStatus } from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
import {
  parseFeedbackFromOutput,
  parseStructuredAgentOutput,
  mapPullRequestToGitStatus,
  syncLabeledContainerPRsToBackend,
  AVERLON_CONTAINER_LABEL,
} from '../submit-feedback';
import {
  mockClaudeOutputValid,
  mockClaudeOutputMidText,
  mockClaudeOutputNoJson,
  mockClaudeOutputMalformedJson,
  mockClaudeOutputMissingFields,
} from './fixtures';

describe('parseFeedbackFromOutput', () => {
  it('returns empty array for empty string', () => {
    expect(parseFeedbackFromOutput('')).toEqual([]);
  });

  it('parses valid JSON output correctly', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputValid);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ CodeDefectID: 'cd-001', Status: 3, Feedback: '' });
    expect(result[1]).toEqual({
      CodeDefectID: 'cd-002',
      Status: 4,
      Feedback: 'No patch available upstream',
    });
  });

  it('returns empty array when JSON is embedded mid-output (not pure JSON)', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputMidText);
    expect(result).toEqual([]);
  });

  it('returns empty array when output contains no JSON', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputNoJson);
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputMalformedJson);
    expect(result).toEqual([]);
  });

  it('filters out entries missing required fields', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputMissingFields);
    expect(result).toHaveLength(1);
    expect(result[0]?.CodeDefectID).toBe('cd-001');
  });

  it('returns empty array when feedback key is missing from JSON', () => {
    const output = JSON.stringify({ results: [] });
    expect(parseFeedbackFromOutput(output)).toEqual([]);
  });

  it('returns empty array when feedback is not an array', () => {
    const output = JSON.stringify({ feedback: 'not-an-array' });
    expect(parseFeedbackFromOutput(output)).toEqual([]);
  });

  it('parses feedback entries when optional pr fields are present', () => {
    const output = JSON.stringify({
      feedback: [{ CodeDefectID: 'cd-001', Status: 3, Feedback: '' }],
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
    });
    expect(parseFeedbackFromOutput(output)).toHaveLength(1);
  });
});

describe('parseStructuredAgentOutput', () => {
  it('returns entries and PR metadata in one parse', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pr_number: 12,
        pr_url: 'https://github.com/o/r/pull/12',
      })
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.pr_number).toBe(12);
    expect(parsed.pr_url).toBe('https://github.com/o/r/pull/12');
  });

  it('ignores pr_number and pr_url when not the expected types', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pr_number: '12',
        pr_url: 123,
      })
    );
    expect(parsed.pr_number).toBeUndefined();
    expect(parsed.pr_url).toBeUndefined();
  });
});

describe('mapPullRequestToGitStatus', () => {
  it('maps open PRs to Open', () => {
    expect(mapPullRequestToGitStatus({ state: 'open', merged: false })).toBe(
      GitPullRequestStatus.Open
    );
  });

  it('maps merged PRs to Merged', () => {
    expect(mapPullRequestToGitStatus({ state: 'closed', merged: true })).toBe(
      GitPullRequestStatus.Merged
    );
  });

  it('maps closed unmerged PRs to Closed', () => {
    expect(mapPullRequestToGitStatus({ state: 'closed', merged: false })).toBe(
      GitPullRequestStatus.Closed
    );
  });
});

describe('syncLabeledContainerPRsToBackend', () => {
  let listLabeledPullRequestsSpy: ReturnType<typeof spyOn>;
  let createOrUpdateIssueSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configureActionLogging({ verbose: true });
    listLabeledPullRequestsSpy = spyOn(
      githubActionsUtils,
      'listLabeledPullRequests'
    ).mockImplementation(() =>
      Promise.resolve([
        { number: 10, title: 'Current run' },
        { number: 20, title: 'Older PR' },
      ])
    );
    createOrUpdateIssueSpy = spyOn(githubActionsUtils, 'createOrUpdateIssue').mockImplementation(
      () => Promise.resolve(true)
    );
    spyOn(githubActionsUtils, 'getRepoAndOrgUrls').mockImplementation(() => ({
      repoUrl: 'https://github.com/test-org/test-repo',
      orgUrl: 'https://github.com/test-org',
    }));
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    listLabeledPullRequestsSpy.mockRestore();
    createOrUpdateIssueSpy.mockRestore();
  });

  it('lists PRs for the same repo and label, skips touched, and upserts others', async () => {
    const pullsGet = mock((params: { owner: string; repo: string; pull_number: number }) => {
      expect(params.owner).toBe('test-org');
      expect(params.repo).toBe('test-repo');
      if (params.pull_number === 20) {
        return Promise.resolve({
          data: {
            state: 'closed',
            merged: true,
            html_url: 'https://github.com/test-org/test-repo/pull/20',
            title: 'Merged remediation',
          },
        });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const octokit = {
      rest: { pulls: { get: pullsGet } },
    } as never;

    const result = await syncLabeledContainerPRsToBackend({
      octokit,
      apiClient: {} as never,
      orgName: 'test-org',
      repo: 'test-repo',
      cloudId: 'cloud-1',
      touchedPrNumbers: [10],
    });

    expect(listLabeledPullRequestsSpy).toHaveBeenCalledWith(
      octokit,
      'test-org',
      'test-repo',
      AVERLON_CONTAINER_LABEL,
      'all'
    );
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(pullsGet).toHaveBeenCalledTimes(1);
    expect(createOrUpdateIssueSpy).toHaveBeenCalledTimes(1);
    expect(createOrUpdateIssueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 20,
        status: GitPullRequestStatus.Merged,
        issueUrl: 'https://github.com/test-org/test-repo/pull/20',
        issueTitle: 'Merged remediation',
      })
    );
  });

  it('warns and continues when a single PR sync fails', async () => {
    listLabeledPullRequestsSpy.mockImplementation(() =>
      Promise.resolve([{ number: 30, title: 'Bad' }])
    );
    createOrUpdateIssueSpy.mockImplementation(() => Promise.resolve(false));

    const octokit = {
      rest: {
        pulls: {
          get: mock(() =>
            Promise.resolve({
              data: { state: 'open', merged: false, html_url: 'https://github.com/o/r/pull/30' },
            })
          ),
        },
      },
    } as never;

    const result = await syncLabeledContainerPRsToBackend({
      octokit,
      apiClient: {} as never,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      touchedPrNumbers: [],
    });

    expect(result).toEqual({ synced: 0, failed: 1 });
  });
});
