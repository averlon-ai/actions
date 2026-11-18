import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import * as core from '@actions/core';
import {
  ApiRequestError,
  configureActionLogging,
  GitIssueType,
  GitPullRequestStatus,
} from '@averlon/shared';
import * as githubActionsUtils from '@averlon/github-actions-utils';
import {
  parseStructuredAgentOutput,
  mapPullRequestToGitStatus,
  syncLabeledAgentPRsToBackend,
  labelAndRegisterAgentPRs,
  submitDefectFeedback,
  prIdForEntry,
  logFeedbackSummary,
  FEEDBACK_REQUEST_INTERVAL_MS,
  type AgentPrRegistration,
} from '../../src/submit-feedback';
import {
  mockClaudeOutputValid,
  mockClaudeOutputMidText,
  mockClaudeOutputNoJson,
  mockClaudeOutputMalformedJson,
  mockClaudeOutputMissingFields,
} from './fixtures';

const registration: AgentPrRegistration = {
  name: 'test',
  label: 'averlon-test-remediation',
  type: GitIssueType.IaC,
  titlePrefix: 'Test Remediation',
};

describe('parseStructuredAgentOutput feedback entries', () => {
  it('returns empty array for empty string', () => {
    expect(parseStructuredAgentOutput('').entries).toEqual([]);
  });

  it('parses valid JSON output correctly', () => {
    const result = parseStructuredAgentOutput(mockClaudeOutputValid).entries;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ CodeDefectID: 'cd-001', Status: 3, Feedback: '' });
    expect(result[1]).toEqual({
      CodeDefectID: 'cd-002',
      Status: 4,
      Feedback: 'No patch available upstream',
    });
  });

  it('returns empty array when JSON is embedded mid-output (not pure JSON)', () => {
    const result = parseStructuredAgentOutput(mockClaudeOutputMidText).entries;
    expect(result).toEqual([]);
  });

  it('returns empty array when output contains no JSON', () => {
    const result = parseStructuredAgentOutput(mockClaudeOutputNoJson).entries;
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const result = parseStructuredAgentOutput(mockClaudeOutputMalformedJson).entries;
    expect(result).toEqual([]);
  });

  it('filters out entries missing required fields', () => {
    const result = parseStructuredAgentOutput(mockClaudeOutputMissingFields).entries;
    expect(result).toHaveLength(1);
    expect(result[0]?.CodeDefectID).toBe('cd-001');
  });

  it('returns empty array when feedback key is missing from JSON', () => {
    const output = JSON.stringify({ results: [] });
    expect(parseStructuredAgentOutput(output).entries).toEqual([]);
  });

  it('returns empty array when feedback is not an array', () => {
    const output = JSON.stringify({ feedback: 'not-an-array' });
    expect(parseStructuredAgentOutput(output).entries).toEqual([]);
  });

  it('parses feedback entries when pull_requests is present', () => {
    const output = JSON.stringify({
      feedback: [{ CodeDefectID: 'cd-001', Status: 3, Feedback: '' }],
      pull_requests: [{ pr_number: 42, pr_url: 'https://github.com/o/r/pull/42' }],
    });
    expect(parseStructuredAgentOutput(output).entries).toHaveLength(1);
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

describe('syncLabeledAgentPRsToBackend', () => {
  let listLabeledPullRequestsSpy: ReturnType<typeof spyOn>;
  let getRepoAndOrgUrlsSpy: ReturnType<typeof spyOn>;

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
    getRepoAndOrgUrlsSpy = spyOn(githubActionsUtils, 'getRepoAndOrgUrls').mockImplementation(
      () => ({
        repoUrl: 'https://github.com/test-org/test-repo',
        orgUrl: 'https://github.com/test-org',
      })
    );
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    listLabeledPullRequestsSpy.mockRestore();
    getRepoAndOrgUrlsSpy.mockRestore();
  });

  it('lists PRs for the same repo and label, skips touched, and upserts others', async () => {
    const registerGitPullRequest = mock(() => Promise.resolve({ ID: 'pr-20' }));
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

    const result = await syncLabeledAgentPRsToBackend({
      octokit,
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'test-org',
      repo: 'test-repo',
      cloudId: 'cloud-1',
      touchedPrNumbers: [10],
    });

    expect(listLabeledPullRequestsSpy).toHaveBeenCalledWith(
      octokit,
      'test-org',
      'test-repo',
      registration.label,
      'all'
    );
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(pullsGet).toHaveBeenCalledTimes(1);
    expect(registerGitPullRequest).toHaveBeenCalledTimes(1);
    expect(registerGitPullRequest).toHaveBeenCalledWith({
      CloudID: 'cloud-1',
      OrgName: 'test-org',
      OrgURL: 'https://github.com/test-org',
      RepoName: 'test-repo',
      RepoURL: 'https://github.com/test-org/test-repo',
      Number: 20,
      URL: 'https://github.com/test-org/test-repo/pull/20',
      Title: 'Merged remediation',
      Type: registration.type,
      Labels: [registration.label],
      RiskStatus: 0,
      Status: GitPullRequestStatus.Merged,
    });
  });

  it('warns and continues when a single PR sync fails', async () => {
    listLabeledPullRequestsSpy.mockImplementation(() =>
      Promise.resolve([{ number: 30, title: 'Bad' }])
    );
    const registerGitPullRequest = mock(() => Promise.reject(new Error('backend down')));

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

    const result = await syncLabeledAgentPRsToBackend({
      octokit,
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      touchedPrNumbers: [],
    });

    expect(result).toEqual({ synced: 0, failed: 1 });
  });
});

describe('parseStructuredAgentOutput pr_url', () => {
  it('keeps a string pr_url on a feedback entry and drops other values', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [
          { CodeDefectID: 'a', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r/pull/1' },
          { CodeDefectID: 'b', Status: 3, Feedback: '', pr_url: 5 },
          { CodeDefectID: 'c', Status: 4, Feedback: 'x' },
        ],
      })
    );
    expect(parsed.entries).toEqual([
      { CodeDefectID: 'a', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r/pull/1' },
      { CodeDefectID: 'b', Status: 3, Feedback: '' },
      { CodeDefectID: 'c', Status: 4, Feedback: 'x' },
    ]);
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
  const registerGitPullRequest = mock((req: { Number: number }) =>
    Promise.resolve({ ID: `id-${req.Number}` })
  );

  beforeEach(() => {
    registerGitPullRequest.mockClear();
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

    const { handled, prIdByNumber } = await labelAndRegisterAgentPRs({
      octokit,
      apiClient: { registerGitPullRequest } as never,
      registration,
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
        expect.objectContaining({ issue_number: prNumber, labels: [registration.label] })
      );
      expect(registerGitPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          Number: prNumber,
          URL: `https://github.com/o/r/pull/${prNumber}`,
          RepoURL: 'https://github.com/o/r',
          Title: `Test Remediation - PR #${prNumber}`,
          Type: registration.type,
          Labels: [registration.label],
        })
      );
    }
    expect(registerGitPullRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ GitIssueID: expect.anything() })
    );
    expect(prIdByNumber).toEqual(
      new Map([
        [201, 'id-201'],
        [203, 'id-203'],
      ])
    );
  });

  it('registers each PR with its GitHub title, or the prefix title when it has none', async () => {
    const titles: Record<number, string> = {
      301: 'fix(go): upgrade Go to 1.26.11 to fix 15 stdlib CVEs',
      302: '   ',
    };
    const pullsGet = mock((params: { pull_number: number }) =>
      Promise.resolve({
        data: { state: 'open', merged: false, title: titles[params.pull_number] },
      })
    );
    const octokit = {
      rest: { pulls: { get: pullsGet }, issues: { addLabels: mock(() => Promise.resolve({})) } },
    } as never;

    await labelAndRegisterAgentPRs({
      octokit,
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: 'c',
      pullRequests: [
        { pr_number: 301, pr_url: 'https://github.com/o/r/pull/301' },
        { pr_number: 302, pr_url: 'https://github.com/o/r/pull/302' },
      ],
    });

    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        Number: 301,
        Title: 'fix(go): upgrade Go to 1.26.11 to fix 15 stdlib CVEs',
      })
    );
    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ Number: 302, Title: 'Test Remediation - PR #302' })
    );
  });

  it('leaves a PR out of the IDs when the backend has no ID for it', async () => {
    const failing = mock(() => Promise.reject(new Error('backend down')));
    const { handled, prIdByNumber } = await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest: failing } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 7, pr_url: 'https://github.com/o/r/pull/7' }],
    });
    expect(handled).toEqual([7]);
    expect(prIdByNumber.size).toBe(0);
  });

  it('registers without labelling when there is no GitHub token', async () => {
    const { handled } = await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 9, pr_url: 'https://github.com/o/r/pull/9' }],
    });
    expect(handled).toEqual([9]);
    expect(registerGitPullRequest).toHaveBeenCalledTimes(1);
    // No GitHub token: the PR is not fetched, so it gets the prefix title.
    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ Number: 9, Title: 'Test Remediation - PR #9' })
    );
  });

  it('sends the ticket options with every PR when a ticket is requested', async () => {
    const ticket = { Labels: ['security'], Priority: 'High' };
    await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [
        { pr_number: 1, pr_url: 'https://github.com/o/r/pull/1' },
        { pr_number: 2, pr_url: 'https://github.com/o/r/pull/2' },
      ],
      ticket,
    });
    expect(registerGitPullRequest).toHaveBeenCalledTimes(2);
    for (const prNumber of [1, 2]) {
      expect(registerGitPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ Number: prNumber, Ticket: ticket })
      );
    }
  });

  it('uses the GitHub PR title as the ticket summary', async () => {
    const octokit = {
      rest: {
        pulls: {
          get: mock(() =>
            Promise.resolve({
              data: { state: 'open', merged: false, title: ' Bump zlib in api image ' },
            })
          ),
        },
        issues: { addLabels: mock(() => Promise.resolve({})) },
      },
    } as never;
    const ticket = { Prefix: 'siri' };
    await labelAndRegisterAgentPRs({
      octokit,
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 6, pr_url: 'https://github.com/o/r/pull/6' }],
      ticket,
    });
    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        Number: 6,
        Ticket: { Prefix: 'siri', Summary: 'Bump zlib in api image' },
      })
    );
    expect(ticket).toEqual({ Prefix: 'siri' });
  });

  it('sends no ticket summary when the PR title cannot be read', async () => {
    await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 8, pr_url: 'https://github.com/o/r/pull/8' }],
      ticket: { Priority: 'High' },
    });
    expect(registerGitPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ Number: 8, Ticket: { Priority: 'High' } })
    );
  });

  it('sends no Ticket field when no ticket is requested', async () => {
    await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 3, pr_url: 'https://github.com/o/r/pull/3' }],
    });
    const [request] = registerGitPullRequest.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request).not.toHaveProperty('Ticket');
  });

  it('registers the PR without the ticket when Averlon rejects the ticket', async () => {
    const rejected = new ApiRequestError(
      '/v1/git/pr',
      400,
      'Bad Request',
      'No Jira or Linear integration is enabled for this organization'
    );
    const register = mock((req: { Ticket?: unknown; Number: number }) =>
      req.Ticket ? Promise.reject(rejected) : Promise.resolve({ ID: `id-${req.Number}` })
    );
    const { prIdByNumber } = await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest: register } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 4, pr_url: 'https://github.com/o/r/pull/4' }],
      ticket: { Priority: 'High' },
    });
    expect(register).toHaveBeenCalledTimes(2);
    const [, retry] = register.mock.calls as unknown as [
      [Record<string, unknown>],
      [Record<string, unknown>],
    ];
    expect(retry[0]).not.toHaveProperty('Ticket');
    expect(prIdByNumber).toEqual(new Map([[4, 'id-4']]));
  });

  it('does not retry without the ticket on an error that is not a 400', async () => {
    const down = new ApiRequestError('/v1/git/pr', 503, 'Service Unavailable', 'down');
    const register = mock(() => Promise.reject(down));
    const { prIdByNumber } = await labelAndRegisterAgentPRs({
      apiClient: { registerGitPullRequest: register } as never,
      registration,
      orgName: 'o',
      repo: 'r',
      cloudId: '',
      pullRequests: [{ pr_number: 5, pr_url: 'https://github.com/o/r/pull/5' }],
      ticket: {},
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(prIdByNumber.size).toBe(0);
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

describe('submitDefectFeedback with PR IDs', () => {
  it('sends the PR ID only with Fixed defects that name a registered PR', async () => {
    const requests: Record<string, unknown>[] = [];
    const updateCodeDefectFeedback = mock((req: Record<string, unknown>) => {
      requests.push(req);
      return Promise.resolve({});
    });

    await submitDefectFeedback({
      apiClient: { updateCodeDefectFeedback } as never,
      entries: [
        { CodeDefectID: 'cd-1', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r/pull/1/' },
        { CodeDefectID: 'cd-2', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r/pull/2' },
        { CodeDefectID: 'cd-3', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r/pull/9' },
        {
          CodeDefectID: 'cd-4',
          Status: 4,
          Feedback: 'no fix',
          pr_url: 'https://github.com/o/r/pull/1',
        },
      ],
      allCodeDefectIds: ['cd-5'],
      prIdByNumber: new Map([
        [1, 'id-1'],
        [2, 'id-2'],
      ]),
      wait: () => Promise.resolve(),
    });

    expect(requests).toEqual([
      { CodeDefectID: 'cd-1', Status: 3, Feedback: '', GitPullRequestID: 'id-1' },
      { CodeDefectID: 'cd-2', Status: 3, Feedback: '', GitPullRequestID: 'id-2' },
      { CodeDefectID: 'cd-3', Status: 3, Feedback: '' },
      { CodeDefectID: 'cd-4', Status: 4, Feedback: 'no fix' },
      { CodeDefectID: 'cd-5', Status: 1, Feedback: 'Coding Agent did not report on this defect' },
    ]);
  });
});

describe('prIdForEntry', () => {
  const one = new Map([[1, 'id-1']]);
  const two = new Map([
    [1, 'id-1'],
    [2, 'id-2'],
  ]);
  const cases: {
    name: string;
    entry: { CodeDefectID: string; Status: number; Feedback: string; pr_url?: string };
    prs: Map<number, string>;
    want: string | undefined;
  }[] = [
    {
      name: 'named PR, matched by its number',
      entry: {
        CodeDefectID: 'a',
        Status: 3,
        Feedback: '',
        pr_url: 'https://github.com/o/r/pull/2',
      },
      prs: two,
      want: 'id-2',
    },
    ...[
      'HTTPS://github.com/o/r/pull/2/',
      'https://github.com/o/r/pull/2/files',
      'https://github.com/o/r/pull/2#discussion_r1',
      'https://github.com/o/r/pull/2?w=1',
      'http://www.github.com/o/r/pull/2',
      'https://api.github.com/repos/o/r/pulls/2',
    ].map(prUrl => ({
      name: `another form of the PR URL: ${prUrl}`,
      entry: { CodeDefectID: 'a', Status: 3, Feedback: '', pr_url: prUrl },
      prs: two,
      want: 'id-2',
    })),
    {
      name: 'a PR number that only starts with a registered number',
      entry: {
        CodeDefectID: 'a',
        Status: 3,
        Feedback: '',
        pr_url: 'https://github.com/o/r/pull/20',
      },
      prs: two,
      want: undefined,
    },
    {
      name: 'a pr_url with no PR number',
      entry: { CodeDefectID: 'a', Status: 3, Feedback: '', pr_url: 'https://github.com/o/r' },
      prs: one,
      want: undefined,
    },
    {
      name: 'named PR that was not registered',
      entry: {
        CodeDefectID: 'a',
        Status: 3,
        Feedback: '',
        pr_url: 'https://github.com/o/r/pull/3',
      },
      prs: two,
      want: undefined,
    },
    {
      name: 'no pr_url and the only PR of the run',
      entry: { CodeDefectID: 'a', Status: 3, Feedback: '' },
      prs: one,
      want: 'id-1',
    },
    {
      name: 'no pr_url and several PRs',
      entry: { CodeDefectID: 'a', Status: 3, Feedback: '' },
      prs: two,
      want: undefined,
    },
    {
      name: 'fixed by a rebuild',
      entry: { CodeDefectID: 'a', Status: 3, Feedback: 'Rebuild would fix it' },
      prs: one,
      want: undefined,
    },
    {
      name: 'NoFix',
      entry: {
        CodeDefectID: 'a',
        Status: 4,
        Feedback: '',
        pr_url: 'https://github.com/o/r/pull/1',
      },
      prs: one,
      want: undefined,
    },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      expect(prIdForEntry(tc.entry, tc.prs)).toBe(tc.want);
    });
  }
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
