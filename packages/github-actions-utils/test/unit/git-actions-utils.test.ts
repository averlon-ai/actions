import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

// Create mock functions for @actions/core
const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockError = mock(() => {});
const mockDebug = mock(() => {});
const mockGetInput = mock(() => '');
const mockSetOutput = mock(() => {});
const mockSetFailed = mock(() => {});

// Mock @actions/core before importing
mock.module('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
}));

// Mock @actions/github before importing
const mockGetOctokit = mock(() => ({
  rest: {
    issues: {
      createComment: mock(() => Promise.resolve({ data: {} })),
      update: mock(() => Promise.resolve({ data: {} })),
      get: mock(() =>
        Promise.resolve({
          data: {
            number: 123,
            html_url: 'https://github.com/test-org/test-repo/issues/123',
            body: 'Test issue body',
            labels: [{ name: 'label1' }, { name: 'label2' }],
          },
        })
      ),
    },
  },
}));

mock.module('@actions/github', () => ({
  getOctokit: mockGetOctokit,
  context: {
    repo: {
      owner: 'test-org',
      repo: 'test-repo',
    },
  },
}));

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  findGitIssue,
  createOrUpdateIssue,
  createPRForIssue,
  updateIssueStatus,
  updatePRStatus,
  closeIssue,
  getRepoAndOrgUrls,
  type LinkedPR,
} from '../../src/git-actions-utils';
import type { ApiClient } from '@averlon/shared';
import {
  GitPullRequestStatus,
  GitIssueType,
  GitIssueRiskStatus,
  configureActionLogging,
  type GetGitIssueResponse,
  type GitIssue,
} from '@averlon/shared';
import { IssueState } from '@averlon/github-copilot-utils';

describe('git-actions-utils', () => {
  let mockApiClient: ApiClient;
  let mockGetGitIssue: ReturnType<typeof mock>;
  let mockRegisterGitIssue: ReturnType<typeof mock>;
  let mockUpdateGitIssueStatus: ReturnType<typeof mock>;
  let mockRegisterGitPullRequest: ReturnType<typeof mock>;
  let mockUpdateGitPullRequestStatus: ReturnType<typeof mock>;
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configureActionLogging({ verbose: true });
    // Clear all mocks
    mockInfo.mockClear();
    mockWarning.mockClear();
    mockDebug.mockClear();

    // Create spies
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    debugSpy = spyOn(core, 'debug').mockImplementation(() => {});

    // Setup ApiClient mocks
    mockGetGitIssue = mock(() =>
      Promise.resolve({
        ID: 'test-issue-id-123',
        IssueNumber: 123,
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: GitPullRequestStatus.Open,
      } as GetGitIssueResponse)
    );

    mockRegisterGitIssue = mock(() =>
      Promise.resolve({
        ID: 'test-issue-id-123',
        IssueNumber: 123,
      } as GitIssue)
    );

    mockUpdateGitIssueStatus = mock(() => Promise.resolve());
    mockRegisterGitPullRequest = mock(() => Promise.resolve());
    mockUpdateGitPullRequestStatus = mock(() => Promise.resolve());

    mockApiClient = {
      getGitIssue: mockGetGitIssue,
      registerGitIssue: mockRegisterGitIssue,
      updateGitIssueStatus: mockUpdateGitIssueStatus,
      registerGitPullRequest: mockRegisterGitPullRequest,
      updateGitPullRequestStatus: mockUpdateGitPullRequestStatus,
    } as unknown as ApiClient;
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    // Clean up
    mockGetGitIssue.mockClear();
    mockRegisterGitIssue.mockClear();
    mockUpdateGitIssueStatus.mockClear();
    mockRegisterGitPullRequest.mockClear();
    mockUpdateGitPullRequestStatus.mockClear();
  });

  describe('getRepoAndOrgUrls', () => {
    it('should construct correct URLs from org and repo', () => {
      const result = getRepoAndOrgUrls('test-org', 'test-repo');

      expect(result.repoUrl).toBe('https://github.com/test-org/test-repo');
      expect(result.orgUrl).toBe('https://github.com/test-org');
    });
  });

  describe('findGitIssue', () => {
    it('should find and return issue when it exists', async () => {
      const result = await findGitIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        cloudId: 'test-cloud-id',
      });

      expect(result).not.toBeNull();
      expect(result?.ID).toBe('test-issue-id-123');
      expect(mockGetGitIssue).toHaveBeenCalledWith({
        RepoURL: 'https://github.com/test-org/test-repo',
        Number: 123,
        CloudID: 'test-cloud-id',
      });
    });

    it('should return NotFound when issue does not exist (404)', async () => {
      const error = new Error('404 Not Found');
      error.message = '404 Not Found';
      mockGetGitIssue.mockRejectedValue(error);

      const result = await findGitIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        cloudId: 'test-cloud-id',
      });

      expect(result).toEqual({ NotFound: true });
    });

    it('should return null for other errors', async () => {
      mockGetGitIssue.mockRejectedValue(new Error('Network error'));

      const result = await findGitIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBeNull();
    });

    it('should return null when apiClient is not provided', async () => {
      // @ts-expect-error - Testing behavior when apiClient is missing
      const result = await findGitIssue({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
      });

      expect(result).toBeNull();
    });

    it('should find issue when cloudId is not provided', async () => {
      const result = await findGitIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
      });

      expect(result).not.toBeNull();
      expect(result?.ID).toBe('test-issue-id-123');
      expect(mockGetGitIssue).toHaveBeenCalledWith({
        RepoURL: 'https://github.com/test-org/test-repo',
        Number: 123,
        CloudID: undefined,
      });
    });
  });

  describe('createOrUpdateIssue', () => {
    it('should create/update issue successfully', async () => {
      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Test issue title',
        riskSummary: 'Test risk summary',
        type: GitIssueType.Helm,
        labels: ['label1', 'label2'],
        issueIDs: [1, 2, 3],
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockRegisterGitIssue).toHaveBeenCalledWith({
        OrgName: 'test-org',
        OrgURL: 'https://github.com/test-org',
        RepoName: 'test-repo',
        RepoURL: 'https://github.com/test-org/test-repo',
        Number: 123,
        URL: 'https://github.com/test-org/test-repo/issues/123',
        Title: 'Test issue title',
        RiskSummary: 'Test risk summary',
        RiskStatus: GitIssueRiskStatus.None,
        Status: GitPullRequestStatus.Open,
        Type: GitIssueType.Helm,
        Labels: ['label1', 'label2'],
        IssueIDs: ['1', '2', '3'],
        CloudID: 'test-cloud-id',
      });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Creating/updating issue #123'));
    });

    it('should pass GitIssueRiskStatus when provided', async () => {
      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Risk detected',
        riskSummary: 'Risk detected',
        riskStatus: GitIssueRiskStatus.Detected,
        type: GitIssueType.Helm,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockRegisterGitIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          RiskStatus: GitIssueRiskStatus.Detected,
        })
      );
    });

    it('should use provided issueUrl when given', async () => {
      await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Test',
        issueUrl: 'https://github.com/test-org/test-repo/issues/123/custom',
        riskSummary: 'Test',
        type: GitIssueType.Helm,
        cloudId: 'test-cloud-id',
      });

      expect(mockRegisterGitIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          URL: 'https://github.com/test-org/test-repo/issues/123/custom',
        })
      );
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await createOrUpdateIssue({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Test',
        riskSummary: 'Test',
        type: GitIssueType.Helm,
      });

      expect(result).toBe(false);
      expect(mockRegisterGitIssue).not.toHaveBeenCalled();
    });

    it('should create/update issue when cloudId is not provided', async () => {
      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Test',
        riskSummary: 'Test',
        type: GitIssueType.Helm,
      });

      expect(result).toBe(true);
      expect(mockRegisterGitIssue).toHaveBeenCalledWith({
        OrgName: 'test-org',
        OrgURL: 'https://github.com/test-org',
        RepoName: 'test-repo',
        RepoURL: 'https://github.com/test-org/test-repo',
        Number: 123,
        URL: 'https://github.com/test-org/test-repo/issues/123',
        Title: 'Test',
        RiskSummary: 'Test',
        RiskStatus: GitIssueRiskStatus.None,
        Status: GitPullRequestStatus.Open,
        Type: GitIssueType.Helm,
        CloudID: '',
      });
    });

    it('should handle API errors gracefully', async () => {
      mockRegisterGitIssue.mockRejectedValue(new Error('API error'));

      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: 'Test',
        riskSummary: 'Test',
        type: GitIssueType.Helm,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create/update issue #123')
      );
    });

    it('should use fallback "Issue #N" when issueTitle is empty', async () => {
      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueTitle: '',
        riskSummary: 'Test',
        type: GitIssueType.Helm,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockRegisterGitIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          Title: 'Issue #123',
        })
      );
    });
  });

  describe('createPRForIssue', () => {
    const mockLinkedPRs: LinkedPR[] = [
      { number: 1, author: 'test-author', state: 'OPEN' },
      { number: 2, author: 'test-author', state: 'MERGED' },
    ];

    it('should register PRs successfully without prior Get lookup', async () => {
      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: mockLinkedPRs,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockGetGitIssue).not.toHaveBeenCalled();
      expect(mockRegisterGitPullRequest).toHaveBeenCalledTimes(2);
      expect(mockRegisterGitPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          CloudID: 'test-cloud-id',
          RepoURL: 'https://github.com/test-org/test-repo',
          IssueNumber: 123,
          Number: 1,
          URL: 'https://github.com/test-org/test-repo/pull/1',
          Status: GitPullRequestStatus.Open,
        })
      );
      expect(mockRegisterGitPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          CloudID: 'test-cloud-id',
          RepoURL: 'https://github.com/test-org/test-repo',
          IssueNumber: 123,
          Number: 2,
          URL: 'https://github.com/test-org/test-repo/pull/2',
          Status: GitPullRequestStatus.Merged,
        })
      );
    });

    it('should return true when no PRs to register', async () => {
      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: [],
      });

      expect(result).toBe(true);
      expect(mockGetGitIssue).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('No PRs to register for issue #123');
    });

    it('should register PRs when cloudId is not provided', async () => {
      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        linkedPRs: mockLinkedPRs,
      });

      expect(result).toBe(true);
      expect(mockRegisterGitPullRequest).toHaveBeenCalled();
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await createPRForIssue({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: mockLinkedPRs,
      });

      expect(result).toBe(false);
    });

    it('should handle PR registration errors gracefully', async () => {
      mockRegisterGitPullRequest.mockRejectedValue(new Error('PR registration failed'));

      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: [mockLinkedPRs[0]!],
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to register PR #1'));
    });
  });

  describe('updateIssueStatus', () => {
    it('should update issue status successfully without prior Get lookup', async () => {
      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: GitPullRequestStatus.Closed,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockGetGitIssue).not.toHaveBeenCalled();
      expect(mockUpdateGitIssueStatus).toHaveBeenCalledWith({
        Number: 123,
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: GitPullRequestStatus.Closed,
        CloudID: 'test-cloud-id',
      });
    });

    it('should update issue status when cloudId is not provided', async () => {
      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        status: GitPullRequestStatus.Closed,
      });

      expect(result).toBe(true);
      expect(mockUpdateGitIssueStatus).toHaveBeenCalledWith({
        Number: 999,
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: GitPullRequestStatus.Closed,
        CloudID: '',
      });
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await updateIssueStatus({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: GitPullRequestStatus.Closed,
      });

      expect(result).toBe(false);
    });

    it('should handle API errors gracefully', async () => {
      mockUpdateGitIssueStatus.mockRejectedValue(new Error('Update failed'));

      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: GitPullRequestStatus.Closed,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update issue #123 status')
      );
    });
  });

  describe('updatePRStatus', () => {
    it('should update PR status successfully without prior Get lookup', async () => {
      const result = await updatePRStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        pullRequestNumber: 456,
        status: GitPullRequestStatus.Merged,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(true);
      expect(mockGetGitIssue).not.toHaveBeenCalled();
      expect(mockUpdateGitPullRequestStatus).toHaveBeenCalledWith({
        IssueNumber: 123,
        RepoURL: 'https://github.com/test-org/test-repo',
        Number: 456,
        Status: GitPullRequestStatus.Merged,
      });
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await updatePRStatus({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        pullRequestNumber: 456,
        status: GitPullRequestStatus.Merged,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(false);
      expect(mockUpdateGitPullRequestStatus).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      mockUpdateGitPullRequestStatus.mockRejectedValue(new Error('Update failed'));

      const result = await updatePRStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        pullRequestNumber: 456,
        status: GitPullRequestStatus.Merged,
        cloudId: 'test-cloud-id',
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update PR #456 status')
      );
    });
  });

  describe('closeIssue', () => {
    let mockOctokit: ReturnType<typeof github.getOctokit>;
    let mockCreateComment: ReturnType<typeof mock>;
    let mockUpdateIssue: ReturnType<typeof mock>;
    let mockGetIssue: ReturnType<typeof mock>;
    let mockFindPRsLinkedToIssue: ReturnType<typeof mock>;

    beforeEach(() => {
      mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      mockUpdateIssue = mock(() => Promise.resolve({ data: {} }));
      mockGetIssue = mock(() =>
        Promise.resolve({
          data: {
            number: 123,
            title: 'Test issue title',
            html_url: 'https://github.com/test-org/test-repo/issues/123',
            body: 'Test issue body',
            labels: [{ name: 'label1' }],
          },
        })
      );
      mockFindPRsLinkedToIssue = mock(() => Promise.resolve([]));

      mockOctokit = {
        rest: {
          issues: {
            createComment: mockCreateComment,
            update: mockUpdateIssue,
            get: mockGetIssue,
          },
        },
      } as unknown as ReturnType<typeof github.getOctokit>;
    });

    it('should close issue on GitHub and update backend', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
        cloudId: 'test-cloud-id',
      });

      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'test-repo',
        issue_number: 123,
        body: 'Closing issue',
      });
      expect(mockUpdateIssue).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'test-repo',
        issue_number: 123,
        state: IssueState.CLOSED,
      });
      expect(mockRegisterGitIssue).toHaveBeenCalled();
      expect(mockUpdateGitIssueStatus).toHaveBeenCalledWith({
        Number: 123,
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: GitPullRequestStatus.Closed,
        CloudID: 'test-cloud-id',
      });
    });

    it('should register PRs when they exist', async () => {
      mockFindPRsLinkedToIssue.mockResolvedValue([
        { number: 1, author: 'test-author', state: 'OPEN' },
      ]);

      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
        cloudId: 'test-cloud-id',
      });

      expect(mockFindPRsLinkedToIssue).toHaveBeenCalledWith(123);
      expect(mockRegisterGitPullRequest).toHaveBeenCalled();
    });

    it('should work without apiClient', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
      });

      expect(mockCreateComment).toHaveBeenCalled();
      expect(mockUpdateIssue).toHaveBeenCalled();
      // Backend calls should not be made
      expect(mockRegisterGitIssue).not.toHaveBeenCalled();
    });

    it('should sync backend when cloudId is not provided but apiClient is', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
      });

      expect(mockCreateComment).toHaveBeenCalled();
      expect(mockUpdateIssue).toHaveBeenCalled();
      expect(mockRegisterGitIssue).toHaveBeenCalled();
      expect(mockUpdateGitIssueStatus).toHaveBeenCalled();
    });

    it('should use fallback "Issue #N" when issue has no title', async () => {
      mockGetIssue.mockResolvedValueOnce({
        data: {
          number: 123,
          title: '',
          html_url: 'https://github.com/test-org/test-repo/issues/123',
          body: 'Test body',
          labels: [],
        },
      });

      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing',
        apiClient: mockApiClient,
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
        cloudId: 'test-cloud-id',
      });

      expect(mockRegisterGitIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          Title: 'Issue #123',
        })
      );
    });

    it('should use custom log message when provided', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: GitIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
        logMessage: 'Custom log message',
      });

      expect(infoSpy).toHaveBeenCalledWith('Custom log message');
    });
  });
});
