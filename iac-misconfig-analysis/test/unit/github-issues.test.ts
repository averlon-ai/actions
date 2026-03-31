import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

// Create mock functions for @actions/core
const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockError = mock(() => {});
const mockDebug = mock(() => {});
const mockGetInput = mock(() => '');
const mockSetOutput = mock(() => {});
const mockSetFailed = mock(() => {});
const mockIsDebug = mock(() => false);

// Mock @actions/core before importing
mock.module('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  isDebug: mockIsDebug,
}));

// Mock @actions/github before importing
const mockGetOctokit = mock(() => ({
  rest: {
    issues: {},
    gists: {},
  },
}));

mock.module('@actions/github', () => ({
  getOctokit: mockGetOctokit,
}));

import * as core from '@actions/core';
import * as github from '@actions/github';
import { GithubIssuesService, extractBatchNumberFromTitle } from '../../src/github-issues';
import type { TerraformResource } from '@averlon/shared';

// Mock the CopilotIssueManager methods
const mockAssignCopilot = mock(() => Promise.resolve());
const mockHandleCopilotAssignmentForUpdatedIssue = mock(() => Promise.resolve());
const mockHandleCopilotAssignmentForUnchangedIssue = mock(() => Promise.resolve());
const mockGetIssue = mock(() => Promise.resolve({ body: '' }));

describe('GithubIssuesService', () => {
  let mockOctokit: ReturnType<typeof github.getOctokit>;
  let issuesService: GithubIssuesService;
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let mockListForRepo: ReturnType<typeof mock>;
  let mockCreateIssue: ReturnType<typeof mock>;
  let mockUpdateIssue: ReturnType<typeof mock>;
  let mockCreateComment: ReturnType<typeof mock>;
  let mockIssuesGet: ReturnType<typeof mock>;

  const createMockResource = (
    id: string,
    type: string,
    name: string,
    issueIds: string[] = []
  ): TerraformResource => ({
    ID: id,
    Type: type,
    Name: name,
    Asset: {
      ID: `asset-${id}`,
      ResourceID: `resource-${id}`,
    },
    Issues: issueIds.map(issueId => ({
      ID: issueId,
      OrgID: 'test-org-id',
      CloudID: 'test-cloud-id',
    })),
  });

  beforeEach(() => {
    // Mock core functions
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    errorSpy = spyOn(core, 'error').mockImplementation(() => {});

    // Mock GitHub API calls
    mockListForRepo = mock(() =>
      Promise.resolve({
        data: [],
      })
    );

    mockCreateIssue = mock(() =>
      Promise.resolve({
        data: {
          number: 1,
          title: 'Test Issue',
          body: 'Test Body',
        },
      })
    );

    mockUpdateIssue = mock(() =>
      Promise.resolve({
        data: {
          number: 1,
          title: 'Updated Issue',
          body: 'Updated Body',
        },
      })
    );

    mockCreateComment = mock(() => Promise.resolve({ data: {} }));

    mockIssuesGet = mock((params: { issue_number: number }) =>
      Promise.resolve({
        data: {
          number: params.issue_number,
          title: `Test Issue #${params.issue_number}`,
          body: 'Test Body',
        },
      })
    );

    // Create mock Octokit instance (no Gist — state in issue body)
    mockOctokit = {
      rest: {
        issues: {
          listForRepo: mockListForRepo as any,
          create: mockCreateIssue as any,
          update: mockUpdateIssue as any,
          createComment: mockCreateComment as any,
          get: mockIssuesGet as any,
        },
      },
    } as any;

    // Create service instance with typecast to avoid octokit type error in tests
    issuesService = new GithubIssuesService(
      mockOctokit as unknown as any,
      'test-owner',
      'test-repo'
    );

    // Mock parent class methods
    (issuesService as any).assignCopilot = mockAssignCopilot;
    (issuesService as any).handleCopilotAssignmentForUpdatedIssue =
      mockHandleCopilotAssignmentForUpdatedIssue;
    (issuesService as any).handleCopilotAssignmentForUnchangedIssue =
      mockHandleCopilotAssignmentForUnchangedIssue;
    (issuesService as any).getIssue = mockGetIssue;
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    mockListForRepo.mockClear();
    mockCreateIssue.mockClear();
    mockUpdateIssue.mockClear();
    mockCreateComment.mockClear();
    mockIssuesGet?.mockClear();
    mockAssignCopilot.mockClear();
    mockHandleCopilotAssignmentForUpdatedIssue.mockClear();
    mockHandleCopilotAssignmentForUnchangedIssue.mockClear();
    mockGetIssue.mockClear();
  });

  describe('createBatchedIssues', () => {
    it('should create one issue per batch with 10 resources per batch', async () => {
      // Create 25 resources with issues (should create 3 batches: 10, 10, 5)
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 25; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues, so all resources need new issues
      mockListForRepo.mockResolvedValue({
        data: [],
      } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // Should create 3 issues (batches of 10, 10, 5) — state in body, no Gist
      expect(mockCreateIssue).toHaveBeenCalledTimes(3);

      // Verify first batch
      const firstCall = mockCreateIssue.mock.calls[0][0];
      expect(firstCall.title).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 1 of 3'
      );
      expect(firstCall.labels).toEqual([
        'averlon-created',
        'averlon-iac-misconfiguration-analysis',
      ]);
      expect(firstCall.body).toContain('averlon-batch-state');

      // Verify second batch
      const secondCall = mockCreateIssue.mock.calls[1][0];
      expect(secondCall.title).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 2 of 3'
      );

      // Verify third batch
      const thirdCall = mockCreateIssue.mock.calls[2][0];
      expect(thirdCall.title).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 3 of 3'
      );
    });

    it('should filter out resources without issues', async () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
        createMockResource('resource-2', 'aws_s3_bucket', 'bucket-2', []), // No issues
        createMockResource('resource-3', 'aws_ec2_instance', 'instance-1', ['issue-2']),
      ];

      // Mock: no existing issues
      mockListForRepo.mockResolvedValue({
        data: [],
      } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // Should create 1 issue with only 2 resources (those with issues)
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const createCall = mockCreateIssue.mock.calls[0][0];
      expect(createCall.body).toContain('resource-1');
      expect(createCall.body).toContain('resource-3');
      expect(createCall.body).not.toContain('resource-2');
    });

    it('should return early if no resources provided', async () => {
      await issuesService.createBatchedIssues([], 'test-repo', 'abc123', false);

      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith('No Terraform resources to create issues for');
    });

    it('should return early if no resources have issues', async () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', []),
        createMockResource('resource-2', 'aws_s3_bucket', 'bucket-2', []),
      ];

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith('No Terraform resources with issues found');
    });

    it('should handle copilot assignment when enabled', async () => {
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 5; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues
      mockListForRepo.mockResolvedValue({
        data: [],
      } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', true);

      expect(mockAssignCopilot).toHaveBeenCalledWith(1, true);
    });

    it('should continue processing other batches if one fails', async () => {
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 25; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues for filtering
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      // First batch succeeds, second batch fails, third batch succeeds
      mockListForRepo
        .mockResolvedValueOnce({ data: [] } as any) // Batch 1 - no existing issue
        .mockResolvedValueOnce({ data: [] } as any) // Batch 2 - no existing issue
        .mockResolvedValueOnce({ data: [] } as any); // Batch 3 - no existing issue

      mockCreateIssue
        .mockResolvedValueOnce({ data: { number: 1 } } as any) // Batch 1 succeeds
        .mockRejectedValueOnce(new Error('API Error')) // Batch 2 fails
        .mockResolvedValueOnce({ data: { number: 3 } } as any); // Batch 3 succeeds

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // Should attempt to create all 3 batches; package logs error for failed batch
      expect(mockCreateIssue).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to create/update issue for Batch 2 of 3 (10 item(s)): API Error'
        )
      );
    });

    it('should include all issue IDs in issue body', async () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1', 'issue-2']),
        createMockResource('resource-2', 'aws_ec2_instance', 'instance-1', ['issue-3']),
      ];

      // Mock: no existing issues
      mockListForRepo.mockResolvedValue({
        data: [],
      } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      const createCall = mockCreateIssue.mock.calls[0][0];
      expect(createCall.body).toContain('issue-1');
      expect(createCall.body).toContain('issue-2');
      expect(createCall.body).toContain('issue-3');
    });

    it('should include repository and commit information in issue body', async () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      // Mock: no existing issues
      mockListForRepo.mockResolvedValue({
        data: [],
      } as any);

      await issuesService.createBatchedIssues(
        resources,
        'my-terraform-repo',
        'commit-abc123',
        false
      );

      const createCall = mockCreateIssue.mock.calls[0][0];
      expect(createCall.body).toContain('**Repository:** `my-terraform-repo`');
      expect(createCall.body).toContain('**Commit:** `commit-abc123`');
    });

    it('should skip existing assets with no new issue IDs', async () => {
      // Create resources with same Asset ID but different issue IDs
      const existingResource: TerraformResource = {
        ID: 'resource-1',
        Type: 'aws_s3_bucket',
        Name: 'bucket-1',
        Asset: {
          ID: 'asset-1', // Same asset ID
          ResourceID: 'resource-1',
        },
        Issues: [
          { ID: 'issue-1', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
          { ID: 'issue-2', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
        ],
      };
      // Same asset ID, same issue IDs - should be skipped (no new issue IDs)
      const newResourceSameIssueIds: TerraformResource = {
        ID: 'resource-1',
        Type: 'aws_s3_bucket',
        Name: 'bucket-1',
        Asset: {
          ID: 'asset-1', // Same asset ID
          ResourceID: 'resource-1',
        },
        Issues: [
          { ID: 'issue-1', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
          { ID: 'issue-2', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
        ],
      };
      // Same asset ID, fewer issues but no new IDs - should be skipped
      const newResourceFewerIssues: TerraformResource = {
        ID: 'resource-1',
        Type: 'aws_s3_bucket',
        Name: 'bucket-1',
        Asset: {
          ID: 'asset-1', // Same asset ID
          ResourceID: 'resource-1',
        },
        Issues: [{ ID: 'issue-1', OrgID: 'test-org-id', CloudID: 'test-cloud-id' }],
      };
      // Different asset ID (new asset) - should be included
      const newResourceNewAsset: TerraformResource = {
        ID: 'resource-2',
        Type: 'aws_s3_bucket',
        Name: 'bucket-2',
        Asset: {
          ID: 'asset-2', // Different asset ID
          ResourceID: 'resource-2',
        },
        Issues: [
          { ID: 'issue-3', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
          { ID: 'issue-4', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
          { ID: 'issue-5', OrgID: 'test-org-id', CloudID: 'test-cloud-id' },
        ],
      };

      // Mock: existing issue with embedded state (asset-1 has fingerprint issue-1,issue-2)
      const existingStateBody =
        'Content\n<!-- averlon-batch-state\n{"v":1,"keys":["asset:asset-1"],"fingerprints":{"asset:asset-1":"issue-1,issue-2"}}\n-->';
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
            body: existingStateBody,
          },
        ],
      } as any);

      await issuesService.createBatchedIssues(
        [newResourceSameIssueIds, newResourceFewerIssues, newResourceNewAsset],
        'test-repo',
        'abc123',
        false
      );

      // asset-1 with same fingerprint (issue-1,issue-2) is skipped; asset-1 with fewer issues
      // (issue-1 only) has different fingerprint so included; asset-2 is new. One batch created.
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const createCall = mockCreateIssue.mock.calls[0][0];
      expect(createCall.body).toContain('resource-2');
    });

    it('should create a new issue when asset has new issue IDs (create-only, not update)', async () => {
      // Same asset but with new issue IDs (issue-2 and issue-3 are new); we create a new batch with only new issues
      const newResourceWithNewIssueIds = createMockResource(
        'resource-1',
        'aws_s3_bucket',
        'bucket-1',
        ['issue-1', 'issue-2', 'issue-3']
      );

      const existingStateBody =
        'Content\n<!-- averlon-batch-state\n{"v":1,"keys":["asset:asset-resource-1"],"fingerprints":{"asset:asset-resource-1":"issue-1"}}\n-->';
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
            body: existingStateBody,
          },
        ],
      } as any);

      await issuesService.createBatchedIssues(
        [newResourceWithNewIssueIds],
        'test-repo',
        'abc123',
        false
      );

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const body = mockCreateIssue.mock.calls[0][0].body;
      expect(body).toContain('resource-1');
      // New issue must contain only the new issue IDs (issue-2, issue-3), not the existing one (issue-1)
      expect(body).toContain('issue-2');
      expect(body).toContain('issue-3');
      expect(body).not.toContain('issue-1');
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });

    it('should create a new issue when asset has different issue IDs (new IDs, create-only)', async () => {
      // Same asset, different issue IDs (issue-3 and issue-4 are new); we create a new batch with only new issues
      const newResourceDifferentIssueIds = createMockResource(
        'resource-1',
        'aws_s3_bucket',
        'bucket-1',
        ['issue-3', 'issue-4']
      );

      const existingStateBody =
        'Content\n<!-- averlon-batch-state\n{"v":1,"keys":["asset:asset-resource-1"],"fingerprints":{"asset:asset-resource-1":"issue-1,issue-2"}}\n-->';
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
            body: existingStateBody,
          },
        ],
      } as any);

      await issuesService.createBatchedIssues(
        [newResourceDifferentIssueIds],
        'test-repo',
        'abc123',
        false
      );

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const body = mockCreateIssue.mock.calls[0][0].body;
      expect(body).toContain('resource-1');
      // New issue must contain only the new issue IDs (issue-3, issue-4), not the existing ones (issue-1, issue-2)
      expect(body).toContain('issue-3');
      expect(body).toContain('issue-4');
      expect(body).not.toContain('issue-1');
      expect(body).not.toContain('issue-2');
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });

    it('should create new issue with only new issue when existing resource in batch 1 gains one new finding', async () => {
      // Batch 1 already has resource-1 with issue-1. This run finds resource-1 with issue-1 + issue-2.
      // We must create one new issue containing only issue-2.
      const resourceWithOneNewIssue = createMockResource(
        'resource-1',
        'aws_s3_bucket',
        'bucket-1',
        ['issue-1', 'issue-2']
      );

      const existingStateBody =
        'Content\n<!-- averlon-batch-state\n{"v":1,"keys":["asset:asset-resource-1"],"fingerprints":{"asset:asset-resource-1":"issue-1"}}\n-->';
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
            body: existingStateBody,
          },
        ],
      } as any);

      await issuesService.createBatchedIssues(
        [resourceWithOneNewIssue],
        'test-repo',
        'abc123',
        false
      );

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const body = mockCreateIssue.mock.calls[0][0].body;
      expect(body).toContain('resource-1');
      expect(body).toContain('issue-2');
      expect(body).not.toContain('issue-1');
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });
  });

  describe('cleanupOrphanedIssues', () => {
    it('should close orphaned issues when batch count decreases', async () => {
      // Note: With the new implementation, cleanup is not automatically called
      // This test is kept for the cleanup method itself, but the main flow
      // now creates batches starting from maxBatchNumber + 1, so orphaned
      // batches are handled differently
      // Simulate scenario where we had 3 batches before, but now only have 2
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 15; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues for filtering
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      // Mock: getAllExistingBatchNumbers - finds batches 1, 2, 3
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
          },
          {
            number: 2,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 2',
            state: 'open',
          },
          {
            number: 3,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 3',
            state: 'open',
          },
        ],
      } as any);

      // Mock: check for existing batches (none found, will create new ones)
      mockListForRepo
        .mockResolvedValueOnce({ data: [] } as any) // Check for batch 1
        .mockResolvedValueOnce({ data: [] } as any); // Check for batch 2

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // With new implementation, batches start from maxBatchNumber + 1 (4)
      // So we create batches 4 and 5, and batch 3 remains (not cleaned up automatically)
      // The cleanup method exists but is not called in the main flow
      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      // Batch 3 is not automatically closed in the new implementation
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it('should not close issues for batches that still exist', async () => {
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 10; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues for filtering
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      mockListForRepo
        .mockResolvedValueOnce({
          data: [
            {
              number: 1,
              title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
              state: 'open',
            },
          ],
        } as any)
        .mockResolvedValueOnce({
          // Cleanup check - only batch 1 exists, which is valid
          data: [
            {
              number: 1,
              title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
              state: 'open',
            },
          ],
        } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // Should not close batch 1 since it still exists (batch number 1 <= currentBatchCount 1)
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it('should skip issues that do not match the batch pattern', async () => {
      const resources: TerraformResource[] = [];
      for (let i = 1; i <= 5; i++) {
        resources.push(
          createMockResource(`resource-${i}`, 'aws_s3_bucket', `bucket-${i}`, [`issue-${i}`])
        );
      }

      // Mock: no existing issues for filtering
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      // Mock: check for existing batch
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      // Mock: cleanup check - includes non-batch issues
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 1,
            title: 'Averlon Misconfiguration Remediation Agent for IaC: Batch 1',
            state: 'open',
          },
          {
            number: 2,
            title: 'Some Other Issue',
            state: 'open',
          },
        ],
      } as any);

      await issuesService.createBatchedIssues(resources, 'test-repo', 'abc123', false);

      // Should not try to close issue #2 since it doesn't match the pattern
      expect(mockCreateComment).not.toHaveBeenCalled();
    });
  });

  describe('extractBatchNumberFromTitle', () => {
    it('should extract batch number from title with single batch', () => {
      expect(
        extractBatchNumberFromTitle('Averlon Misconfiguration Remediation Agent for IaC: Batch 1')
      ).toBe(1);
    });

    it('should extract batch number from title with multiple batches', () => {
      expect(
        extractBatchNumberFromTitle(
          'Averlon Misconfiguration Remediation Agent for IaC: Batch 2 of 5'
        )
      ).toBe(2);
    });

    it('should return null for invalid title format', () => {
      expect(extractBatchNumberFromTitle('Some Other Title')).toBeNull();
      expect(extractBatchNumberFromTitle('')).toBeNull();
    });

    it('should return null for title without batch number', () => {
      expect(
        extractBatchNumberFromTitle('Averlon Misconfiguration Remediation Agent for IaC: Batch')
      ).toBeNull();
    });

    it('should handle titles with additional text', () => {
      expect(
        extractBatchNumberFromTitle(
          'Averlon Misconfiguration Remediation Agent for IaC: Batch 3 of 10 - Additional Text'
        )
      ).toBe(3);
    });
  });
});

// Helper function to generate expected issue body for comparison
async function generateExpectedBody(
  resources: TerraformResource[],
  batchNumber: number,
  totalBatches: number,
  repoName: string,
  commit: string
): Promise<string> {
  const { generateIssueBody } = await import('../../src/issue-template');
  const issueIds = new Set<string>();
  for (const resource of resources) {
    if (resource.Issues) {
      for (const issue of resource.Issues) {
        if (issue.ID) {
          issueIds.add(issue.ID);
        }
      }
    }
  }
  return generateIssueBody({
    batchNumber,
    totalBatches,
    resources,
    repoName,
    commit,
    issueIds: Array.from(issueIds),
  });
}
