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
  findSourceControlIssue,
  createOrUpdateIssue,
  createPRForIssue,
  updateIssueStatus,
  updatePRStatus,
  closeIssue,
  getRepoAndOrgUrls,
  type LinkedPR,
} from '../../src/source-control-utils';
import type { ApiClient } from '@averlon/shared';
import {
  SourceControlStatus,
  SourceControlIssueType,
  type GetSourceControlIssueResponse,
  type SourceControlIssue,
} from '@averlon/shared';
import { IssueState } from '@averlon/github-copilot-utils';

describe('source-control-utils', () => {
  let mockApiClient: ApiClient;
  let mockGetSourceControlIssue: ReturnType<typeof mock>;
  let mockRegisterSourceControlIssue: ReturnType<typeof mock>;
  let mockUpdateSourceControlIssueStatus: ReturnType<typeof mock>;
  let mockRegisterSourceControlPullRequest: ReturnType<typeof mock>;
  let mockUpdateSourceControlPullRequestStatus: ReturnType<typeof mock>;
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Clear all mocks
    mockInfo.mockClear();
    mockWarning.mockClear();
    mockDebug.mockClear();

    // Create spies
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    debugSpy = spyOn(core, 'debug').mockImplementation(() => {});

    // Setup ApiClient mocks
    mockGetSourceControlIssue = mock(() =>
      Promise.resolve({
        ID: 'test-issue-id-123',
        IssueNumber: 123,
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: SourceControlStatus.Open,
      } as GetSourceControlIssueResponse)
    );

    mockRegisterSourceControlIssue = mock(() =>
      Promise.resolve({
        ID: 'test-issue-id-123',
        IssueNumber: 123,
      } as SourceControlIssue)
    );

    mockUpdateSourceControlIssueStatus = mock(() => Promise.resolve());
    mockRegisterSourceControlPullRequest = mock(() => Promise.resolve());
    mockUpdateSourceControlPullRequestStatus = mock(() => Promise.resolve());

    mockApiClient = {
      getSourceControlIssue: mockGetSourceControlIssue,
      registerSourceControlIssue: mockRegisterSourceControlIssue,
      updateSourceControlIssueStatus: mockUpdateSourceControlIssueStatus,
      registerSourceControlPullRequest: mockRegisterSourceControlPullRequest,
      updateSourceControlPullRequestStatus: mockUpdateSourceControlPullRequestStatus,
    } as unknown as ApiClient;
  });

  afterEach(() => {
    // Clean up
    mockGetSourceControlIssue.mockClear();
    mockRegisterSourceControlIssue.mockClear();
    mockUpdateSourceControlIssueStatus.mockClear();
    mockRegisterSourceControlPullRequest.mockClear();
    mockUpdateSourceControlPullRequestStatus.mockClear();
  });

  describe('getRepoAndOrgUrls', () => {
    it('should construct correct URLs from org and repo', () => {
      const result = getRepoAndOrgUrls('test-org', 'test-repo');

      expect(result.repoUrl).toBe('https://github.com/test-org/test-repo');
      expect(result.orgUrl).toBe('https://github.com/test-org');
    });
  });

  describe('findSourceControlIssue', () => {
    it('should find and return issue when it exists', async () => {
      const result = await findSourceControlIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
      });

      expect(result).not.toBeNull();
      expect(result?.ID).toBe('test-issue-id-123');
      expect(mockGetSourceControlIssue).toHaveBeenCalledWith({
        RepoURL: 'https://github.com/test-org/test-repo',
        IssueNumber: 123,
      });
    });

    it('should return NotFound when issue does not exist (404)', async () => {
      const error = new Error('404 Not Found');
      error.message = '404 Not Found';
      mockGetSourceControlIssue.mockRejectedValue(error);

      const result = await findSourceControlIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
      });

      expect(result).toEqual({ NotFound: true });
    });

    it('should return null for other errors', async () => {
      mockGetSourceControlIssue.mockRejectedValue(new Error('Network error'));

      const result = await findSourceControlIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
      });

      expect(result).toBeNull();
    });

    it('should return null when apiClient is not provided', async () => {
      // @ts-expect-error - Testing behavior when apiClient is missing
      const result = await findSourceControlIssue({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
      });

      expect(result).toBeNull();
    });
  });

  describe('createOrUpdateIssue', () => {
    it('should create/update issue successfully', async () => {
      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        riskSummary: 'Test risk summary',
        type: SourceControlIssueType.Helm,
        labels: ['label1', 'label2'],
        issueIDs: [1, 2, 3],
      });

      expect(result).toBe(true);
      expect(mockRegisterSourceControlIssue).toHaveBeenCalledWith({
        OrgName: 'test-org',
        OrgURL: 'https://github.com/test-org',
        RepoName: 'test-repo',
        RepoURL: 'https://github.com/test-org/test-repo',
        IssueNumber: 123,
        IssueURL: 'https://github.com/test-org/test-repo/issues/123',
        RiskSummary: 'Test risk summary',
        Status: SourceControlStatus.Open,
        Type: SourceControlIssueType.Helm,
        Labels: ['label1', 'label2'],
        IssueIDs: [1, 2, 3],
      });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Creating/updating issue #123'));
    });

    it('should use provided issueUrl when given', async () => {
      await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        issueUrl: 'https://github.com/test-org/test-repo/issues/123/custom',
        riskSummary: 'Test',
        type: SourceControlIssueType.Helm,
      });

      expect(mockRegisterSourceControlIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          IssueURL: 'https://github.com/test-org/test-repo/issues/123/custom',
        })
      );
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await createOrUpdateIssue({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        riskSummary: 'Test',
        type: SourceControlIssueType.Helm,
      });

      expect(result).toBe(false);
      expect(mockRegisterSourceControlIssue).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      mockRegisterSourceControlIssue.mockRejectedValue(new Error('API error'));

      const result = await createOrUpdateIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        riskSummary: 'Test',
        type: SourceControlIssueType.Helm,
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create/update issue #123')
      );
    });
  });

  describe('createPRForIssue', () => {
    const mockLinkedPRs: LinkedPR[] = [
      { number: 1, author: 'test-author', state: 'OPEN' },
      { number: 2, author: 'test-author', state: 'MERGED' },
    ];

    it('should register PRs successfully when issue exists', async () => {
      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: mockLinkedPRs,
      });

      expect(result).toBe(true);
      expect(mockGetSourceControlIssue).toHaveBeenCalled();
      expect(mockRegisterSourceControlPullRequest).toHaveBeenCalledTimes(2);
      expect(mockRegisterSourceControlPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          SourceControlIssueID: 'test-issue-id-123',
          PullRequestNumber: 1,
          PullRequestURL: 'https://github.com/test-org/test-repo/pull/1',
          Status: SourceControlStatus.Open,
        })
      );
      expect(mockRegisterSourceControlPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          SourceControlIssueID: 'test-issue-id-123',
          PullRequestNumber: 2,
          PullRequestURL: 'https://github.com/test-org/test-repo/pull/2',
          Status: SourceControlStatus.Merged,
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
      expect(mockGetSourceControlIssue).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('No PRs to register for issue #123');
    });

    it('should return false when issue not found', async () => {
      mockGetSourceControlIssue.mockResolvedValue({ NotFound: true });

      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        linkedPRs: mockLinkedPRs,
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Issue #999 not found in backend')
      );
      expect(mockRegisterSourceControlPullRequest).not.toHaveBeenCalled();
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
      mockRegisterSourceControlPullRequest.mockRejectedValue(new Error('PR registration failed'));

      const result = await createPRForIssue({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        linkedPRs: [mockLinkedPRs[0]!],
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to register PR #1'));
    });
  });

  describe('updateIssueStatus', () => {
    it('should update issue status successfully', async () => {
      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: SourceControlStatus.Closed,
      });

      expect(result).toBe(true);
      expect(mockGetSourceControlIssue).toHaveBeenCalled();
      expect(mockUpdateSourceControlIssueStatus).toHaveBeenCalledWith({
        IssueID: 'test-issue-id-123',
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: SourceControlStatus.Closed,
      });
    });

    it('should return false when issue not found', async () => {
      mockGetSourceControlIssue.mockResolvedValue({ NotFound: true });

      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        status: SourceControlStatus.Closed,
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Issue #999 not found in backend')
      );
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await updateIssueStatus({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: SourceControlStatus.Closed,
      });

      expect(result).toBe(false);
    });

    it('should handle API errors gracefully', async () => {
      mockUpdateSourceControlIssueStatus.mockRejectedValue(new Error('Update failed'));

      const result = await updateIssueStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        status: SourceControlStatus.Closed,
      });

      expect(result).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update issue #123 status')
      );
    });
  });

  describe('updatePRStatus', () => {
    it('should update PR status successfully', async () => {
      const result = await updatePRStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        pullRequestNumber: 456,
        status: SourceControlStatus.Merged,
      });

      expect(result).toBe(true);
      expect(mockGetSourceControlIssue).toHaveBeenCalled();
      expect(mockUpdateSourceControlPullRequestStatus).toHaveBeenCalledWith({
        SourceControlIssueID: 'test-issue-id-123',
        RepoURL: 'https://github.com/test-org/test-repo',
        PullRequestNumber: 456,
        Status: SourceControlStatus.Merged,
      });
    });

    it('should return false when issue not found', async () => {
      mockGetSourceControlIssue.mockResolvedValue({ NotFound: true });

      const result = await updatePRStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 999,
        pullRequestNumber: 456,
        status: SourceControlStatus.Merged,
      });

      expect(result).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Issue #999 not found in backend')
      );
    });

    it('should return false when apiClient is not provided', async () => {
      const result = await updatePRStatus({
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        pullRequestNumber: 456,
        status: SourceControlStatus.Merged,
      });

      expect(result).toBe(false);
    });

    it('should handle API errors gracefully', async () => {
      mockUpdateSourceControlPullRequestStatus.mockRejectedValue(new Error('Update failed'));

      const result = await updatePRStatus({
        apiClient: mockApiClient,
        orgName: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        pullRequestNumber: 456,
        status: SourceControlStatus.Merged,
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
        type: SourceControlIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
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
      expect(mockRegisterSourceControlIssue).toHaveBeenCalled();
      expect(mockUpdateSourceControlIssueStatus).toHaveBeenCalledWith({
        IssueID: expect.any(String),
        RepoURL: 'https://github.com/test-org/test-repo',
        Status: SourceControlStatus.Closed,
      });
    });

    it('should register PRs when they exist', async () => {
      mockFindPRsLinkedToIssue.mockResolvedValue([
        { number: 1, author: 'test-author', state: 'OPEN' },
      ]);

      // Mock getSourceControlIssue to return issue ID for PR registration
      mockGetSourceControlIssue.mockResolvedValue({
        ID: 'test-issue-id-123',
        IssueNumber: 123,
      } as GetSourceControlIssueResponse);

      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: SourceControlIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
      });

      expect(mockFindPRsLinkedToIssue).toHaveBeenCalledWith(123);
      expect(mockRegisterSourceControlPullRequest).toHaveBeenCalled();
    });

    it('should work without apiClient', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        type: SourceControlIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
      });

      expect(mockCreateComment).toHaveBeenCalled();
      expect(mockUpdateIssue).toHaveBeenCalled();
      // Backend calls should not be made
      expect(mockRegisterSourceControlIssue).not.toHaveBeenCalled();
    });

    it('should use custom log message when provided', async () => {
      await closeIssue({
        octokit: mockOctokit,
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 123,
        message: 'Closing issue',
        apiClient: mockApiClient,
        type: SourceControlIssueType.Helm,
        findPRsLinkedToIssue: mockFindPRsLinkedToIssue,
        logMessage: 'Custom log message',
      });

      expect(infoSpy).toHaveBeenCalledWith('Custom log message');
    });
  });
});
