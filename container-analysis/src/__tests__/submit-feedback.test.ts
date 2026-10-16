import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import { ApiRequestError, configureActionLogging, GitPullRequestStatus } from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
import {
  parseFeedbackFromOutput,
  parseStructuredAgentOutput,
  mapPullRequestToGitStatus,
  syncLabeledContainerPRsToBackend,
  labelAndRegisterAgentPRs,
  submitDefectFeedback,
  logFeedbackSummary,
  FEEDBACK_REQUEST_INTERVAL_MS,
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

  it('parses feedback entries when pull_requests is present', () => {
    const output = JSON.stringify({
      feedback: [{ CodeDefectID: 'cd-001', Status: 3, Feedback: '' }],
      pull_requests: [{ pr_number: 42, pr_url: 'https://github.com/o/r/pull/42' }],
    });
    expect(parseFeedbackFromOutput(output)).toHaveLength(1);
  });
});

describe('parseStructuredAgentOutput', () => {
  it('returns entries and PR metadata in one parse', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pull_requests: [{ pr_number: 12, pr_url: 'https://github.com/o/r/pull/12' }],
      })
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.pull_requests).toEqual([
      { pr_number: 12, pr_url: 'https://github.com/o/r/pull/12' },
    ]);
  });

  it('ignores PRs whose pr_number or pr_url are not the expected types', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pull_requests: [{ pr_number: '12', pr_url: 123 }],
      })
    );
    expect(parsed.pull_requests).toEqual([]);
  });

  it('ignores top-level pr_number and pr_url', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [],
        pr_number: 7,
        pr_url: 'https://github.com/o/r/pull/7',
      })
    );
    expect(parsed.pull_requests).toEqual([]);
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

describe('parseStructuredAgentOutput with several PRs', () => {
  it('returns every PR from pull_requests, deduplicated', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pull_requests: [
          { pr_number: 101, pr_url: 'https://github.com/o/r/pull/101' },
          { pr_number: 102, pr_url: 'https://github.com/o/r/pull/102' },
          { pr_number: 101, pr_url: 'https://github.com/o/r/pull/101' },
          { pr_number: 'x', pr_url: 'bad' },
        ],
      })
    );
    expect(parsed.pull_requests.map(pr => pr.pr_number)).toEqual([101, 102]);
  });

  it('keeps PRs even when the feedback array is malformed', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: 'oops',
        pull_requests: [{ pr_number: 5, pr_url: 'https://github.com/o/r/pull/5' }],
      })
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.pull_requests).toHaveLength(1);
  });
});

describe('labelAndRegisterAgentPRs', () => {
  let createOrUpdateIssueSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createOrUpdateIssueSpy = spyOn(githubActionsUtils, 'createOrUpdateIssue').mockImplementation(
      () => Promise.resolve(true)
    );
  });

  afterEach(() => {
    createOrUpdateIssueSpy.mockRestore();
  });

  it('labels and registers every PR, not just the first', async () => {
    const addLabels = mock(() => Promise.resolve({}));
    const pullsGet = mock((params: { pull_number: number }) =>
      params.pull_number === 202
        ? Promise.reject(new Error('transient'))
        : Promise.resolve({ data: { state: 'open', merged: false } })
    );
    const octokit = {
      rest: { pulls: { get: pullsGet }, issues: { addLabels } },
    } as never;

    const handled = await labelAndRegisterAgentPRs({
      octokit,
      apiClient: {} as never,
      orgName: 'o',
      repo: 'r',
      cloudId: 'c',
      pullRequests: [
        { pr_number: 201, pr_url: 'https://github.com/o/r/pull/201' },
        { pr_number: 202, pr_url: 'https://github.com/o/r/pull/202' },
        { pr_number: 203, pr_url: 'https://github.com/o/r/pull/203' },
      ],
    });

    expect(handled).toEqual([201, 202, 203]);
    // 202 fails before labelling; the others are still labelled and registered.
    expect(addLabels).toHaveBeenCalledTimes(2);
    for (const prNumber of [201, 203]) {
      expect(addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: prNumber, labels: [AVERLON_CONTAINER_LABEL] })
      );
      expect(createOrUpdateIssueSpy).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: prNumber, labels: [AVERLON_CONTAINER_LABEL] })
      );
    }
  });

  it('registers without labelling when there is no GitHub token', async () => {
    const handled = await labelAndRegisterAgentPRs({
      apiClient: {} as never,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 9, pr_url: 'https://github.com/o/r/pull/9' }],
    });
    expect(handled).toEqual([9]);
    expect(createOrUpdateIssueSpy).toHaveBeenCalledTimes(1);
  });
});

describe('submitDefectFeedback', () => {
  it('waits between feedback requests, including Pending ones', async () => {
    const calls: string[] = [];
    const updateCodeDefectFeedback = mock((req: { CodeDefectID: string; Status: number }) => {
      calls.push(`${req.CodeDefectID}:${req.Status}`);
      return Promise.resolve({});
    });
    const waits: number[] = [];

    const result = await submitDefectFeedback({
      apiClient: { updateCodeDefectFeedback } as never,
      entries: [
        { CodeDefectID: 'cd-1', Status: 3, Feedback: '' },
        { CodeDefectID: 'cd-2', Status: 4, Feedback: 'no fix' },
        { CodeDefectID: 'cd-bad', Status: 9, Feedback: '' },
      ],
      allCodeDefectIds: ['cd-1', 'cd-2', 'cd-3'],
      wait: ms => {
        waits.push(ms);
        calls.push('wait');
        return Promise.resolve();
      },
    });

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.savedByStatus).toEqual({ Fixed: 1, NoFix: 1, Pending: 1 });
    expect(calls).toEqual(['cd-1:3', 'wait', 'cd-2:4', 'wait', 'cd-3:1']);
    expect(waits).toEqual([FEEDBACK_REQUEST_INTERVAL_MS, FEEDBACK_REQUEST_INTERVAL_MS]);
  });

  it('counts failures by status and continues with the next defect', async () => {
    const updateCodeDefectFeedback = mock((req: { CodeDefectID: string }) =>
      req.CodeDefectID === 'cd-2'
        ? Promise.resolve({})
        : Promise.reject(
            new ApiRequestError(
              '/pb.GitActions/UpdateCodeDefectFeedback',
              429,
              'Too Many Requests',
              'You have reached maximum request limit.'
            )
          )
    );

    const result = await submitDefectFeedback({
      apiClient: { updateCodeDefectFeedback } as never,
      entries: [
        { CodeDefectID: 'cd-1', Status: 4, Feedback: '' },
        { CodeDefectID: 'cd-2', Status: 3, Feedback: '' },
      ],
      allCodeDefectIds: ['cd-3'],
      wait: () => Promise.resolve(),
    });

    expect(updateCodeDefectFeedback).toHaveBeenCalledTimes(3);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.savedByStatus).toEqual({ Fixed: 1 });
    expect(result.failedByStatus).toEqual({ NoFix: 1, Pending: 1 });
    expect(result.failureLines).toEqual([
      'Feedback for cd-1 (NoFix) not saved: 429 Too Many Requests',
      'Feedback for cd-3 (Pending) not saved: 429 Too Many Requests',
    ]);
  });
});

describe('logFeedbackSummary', () => {
  it('logs unsaved updates in a group titled with counts, then saved counts', () => {
    const logged: string[] = [];
    const infoSpy = spyOn(core, 'info').mockImplementation(m => logged.push(m));
    const startGroupSpy = spyOn(core, 'startGroup').mockImplementation(t =>
      logged.push(`group: ${t}`)
    );
    const endGroupSpy = spyOn(core, 'endGroup').mockImplementation(() => logged.push('endgroup'));
    const warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    warningSpy.mockClear();
    try {
      logFeedbackSummary({
        succeeded: 84,
        failed: 2,
        savedByStatus: { Fixed: 3, NoFix: 70, Pending: 11 },
        failedByStatus: { NoFix: 1, Pending: 1 },
        failureLines: [
          'Feedback for cd-1 (NoFix) not saved: 429 Too Many Requests',
          'Feedback for cd-3 (Pending) not saved: 429 Too Many Requests',
        ],
      });

      expect(logged).toEqual([
        'group: Feedback not saved (NoFix 1, Pending 1)',
        'Feedback for cd-1 (NoFix) not saved: 429 Too Many Requests',
        'Feedback for cd-3 (Pending) not saved: 429 Too Many Requests',
        'endgroup',
        'Feedback saved (Fixed 3, NoFix 70, Pending 11)',
      ]);
      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      startGroupSpy.mockRestore();
      endGroupSpy.mockRestore();
      warningSpy.mockRestore();
    }
  });

  it('logs only the saved line when every update is saved', () => {
    const infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    const startGroupSpy = spyOn(core, 'startGroup').mockImplementation(() => {});
    startGroupSpy.mockClear();
    try {
      logFeedbackSummary({
        succeeded: 2,
        failed: 0,
        savedByStatus: { NoFix: 2 },
        failedByStatus: {},
        failureLines: [],
      });

      expect(infoSpy).toHaveBeenCalledWith('Feedback saved (NoFix 2)');
      expect(startGroupSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      startGroupSpy.mockRestore();
    }
  });
});
