import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import { configureActionLogging } from '@averlon/shared';
import { GitIssueType, GitPullRequestStatus } from '@averlon/shared';
import * as gitActionsUtils from '../../src/git-actions-utils';
import { withIssuesPaginateFromListForRepo } from '../helpers/octokit-paginate';
import { syncOpenLabeledIssuesToBackend } from '../../src/sync-open-issues';

const mockCreateOrUpdateIssue = mock(() => Promise.resolve(true));
const mockCreatePRForIssue = mock(() => Promise.resolve(true));

describe('syncOpenLabeledIssuesToBackend', () => {
  const findPRsLinkedToIssue = mock(() => Promise.resolve([]));
  let mockListForRepo: ReturnType<typeof mock>;
  let warningSpy: ReturnType<typeof spyOn>;
  let createOrUpdateIssueSpy: ReturnType<typeof spyOn>;
  let createPRForIssueSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configureActionLogging({ verbose: true });
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    createOrUpdateIssueSpy = spyOn(gitActionsUtils, 'createOrUpdateIssue').mockImplementation(
      mockCreateOrUpdateIssue
    );
    createPRForIssueSpy = spyOn(gitActionsUtils, 'createPRForIssue').mockImplementation(
      mockCreatePRForIssue
    );
    mockCreateOrUpdateIssue.mockClear();
    mockCreatePRForIssue.mockClear();
    findPRsLinkedToIssue.mockClear();
    mockListForRepo = mock(() =>
      Promise.resolve({
        data: [
          {
            number: 10,
            title: 'Open A',
            state: 'open',
            labels: [{ name: 'averlon-created' }, { name: 'averlon-k8s-analysis' }],
          },
          {
            number: 20,
            title: 'Open B',
            state: 'open',
            labels: [
              { name: 'averlon-created' },
              { name: 'averlon-k8s-analysis' },
              { name: 'custom-label' },
            ],
          },
        ],
      })
    );
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    warningSpy?.mockRestore();
    createOrUpdateIssueSpy?.mockRestore();
    createPRForIssueSpy?.mockRestore();
  });

  const baseParams = () => ({
    octokit: withIssuesPaginateFromListForRepo(mockListForRepo),
    orgName: 'org',
    repo: 'repo',
    label: 'averlon-k8s-analysis',
    issueLabels: ['averlon-created', 'averlon-k8s-analysis'],
    type: GitIssueType.Helm,
    findPRsLinkedToIssue,
  });

  it('skips when apiClient is missing', async () => {
    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      touchedIssueNumbers: [],
    });

    expect(mockListForRepo).not.toHaveBeenCalled();
  });

  it('syncs open issues excluding touched numbers', async () => {
    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      cloudId: 'cloud-1',
      touchedIssueNumbers: [10],
    });

    expect(mockCreateOrUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateOrUpdateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 20,
        issueTitle: 'Open B',
        cloudId: 'cloud-1',
        type: GitIssueType.Helm,
        labels: ['averlon-created', 'averlon-k8s-analysis', 'custom-label'],
      })
    );
  });

  it('registers linked PRs when present', async () => {
    findPRsLinkedToIssue.mockResolvedValue([{ number: 99, author: 'copilot', state: 'OPEN' }]);
    mockListForRepo.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            number: 10,
            title: 'Open A',
            state: 'open',
            labels: [
              { name: 'averlon-created' },
              { name: 'averlon-iac-misconfiguration-analysis' },
            ],
          },
          {
            number: 20,
            title: 'Open B',
            state: 'open',
            labels: [
              { name: 'averlon-created' },
              { name: 'averlon-iac-misconfiguration-analysis' },
            ],
          },
        ],
      })
    );

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      label: 'averlon-iac-misconfiguration-analysis',
      type: GitIssueType.IaC,
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(mockCreatePRForIssue).toHaveBeenCalledTimes(2);
    expect(mockCreatePRForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 10,
        linkedPRs: [{ number: 99, author: 'copilot', state: 'OPEN' }],
      })
    );
  });

  it('falls back to issueLabels when GitHub returns no labels on the issue', async () => {
    mockListForRepo.mockImplementation(() =>
      Promise.resolve({
        data: [{ number: 99, title: 'No labels', state: 'open', labels: [] }],
      })
    );

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(mockCreateOrUpdateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 99,
        labels: ['averlon-created', 'averlon-k8s-analysis'],
      })
    );
  });

  it('upserts closed issues with Closed status and still registers PRs', async () => {
    mockListForRepo.mockResolvedValue({
      data: [
        {
          number: 30,
          title: 'Closed GI',
          state: 'closed',
          labels: [{ name: 'averlon-created' }, { name: 'averlon-k8s-analysis' }],
        },
      ],
    });
    findPRsLinkedToIssue.mockResolvedValue([{ number: 88, author: 'copilot', state: 'MERGED' }]);

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(mockCreateOrUpdateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 30,
        status: GitPullRequestStatus.Closed,
        labels: ['averlon-created', 'averlon-k8s-analysis'],
      })
    );
    expect(mockCreatePRForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 30,
        linkedPRs: [{ number: 88, author: 'copilot', state: 'MERGED' }],
      })
    );
  });

  it('warns and continues when one issue fails', async () => {
    mockCreateOrUpdateIssue
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce(true);

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(warningSpy).toHaveBeenCalled();
    expect(mockCreateOrUpdateIssue).toHaveBeenCalledTimes(2);
  });

  it('counts failure when createOrUpdateIssue returns false', async () => {
    mockCreateOrUpdateIssue.mockResolvedValue(false);

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(warningSpy).toHaveBeenCalled();
    expect(mockCreatePRForIssue).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateIssue).toHaveBeenCalledTimes(2);
  });

  it('counts failure when createPRForIssue returns false', async () => {
    mockCreateOrUpdateIssue.mockResolvedValue(true);
    findPRsLinkedToIssue.mockResolvedValue([{ number: 99, author: 'copilot', state: 'OPEN' }]);
    mockCreatePRForIssue.mockResolvedValue(false);

    await syncOpenLabeledIssuesToBackend({
      ...baseParams(),
      apiClient: {} as never,
      touchedIssueNumbers: [],
    });

    expect(warningSpy).toHaveBeenCalled();
    expect(String(warningSpy.mock.calls[0]?.[0])).toContain('PR registration failed');
  });
});
