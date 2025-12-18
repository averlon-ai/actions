import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { GithubIssuesService } from '../../src/github-issues';
import type { ParsedResource } from '../../src/resource-parser';

// Mock the CopilotIssueManager methods
const mockAssignCopilot = mock(() => Promise.resolve());
const mockHandleCopilotAssignmentForUpdatedIssue = mock(() => Promise.resolve());
const mockHandleCopilotAssignmentForUnchangedIssue = mock(() => Promise.resolve());

describe('GithubIssuesService', () => {
  let mockOctokit: ReturnType<typeof github.getOctokit>;
  let issuesService: GithubIssuesService;
  let infoSpy: ReturnType<typeof spyOn>;
  let mockListForRepo: ReturnType<typeof mock>;
  let mockCreateIssue: ReturnType<typeof mock>;
  let mockUpdateIssue: ReturnType<typeof mock>;

  const testResources: ParsedResource[] = [
    {
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      apiVersion: 'apps/v1',
      labels: {
        app: 'test-app',
        account: '123456789012',
        region: 'us-east-1',
      },
      annotations: {},
      rawYaml: 'apiVersion: apps/v1\nkind: Deployment',
    },
    {
      kind: 'Service',
      name: 'test-service',
      namespace: 'default',
      apiVersion: 'v1',
      labels: {
        app: 'test-app',
        'aws-region': 'us-west-2',
      },
      annotations: {
        account: '987654321098',
      },
      rawYaml: 'apiVersion: v1\nkind: Service',
    },
    {
      kind: 'ConfigMap',
      name: 'test-config',
      namespace: 'production',
      apiVersion: 'v1',
      labels: {},
      annotations: {},
      rawYaml: 'apiVersion: v1\nkind: ConfigMap',
    },
  ];

  beforeEach(() => {
    // Mock core.info
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});

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

    // Create mock Octokit instance
    mockOctokit = {
      rest: {
        issues: {
          listForRepo: mockListForRepo as any,
          create: mockCreateIssue as any,
          update: mockUpdateIssue as any,
        },
      },
    } as any;

    // Create service instance
    issuesService = new GithubIssuesService(mockOctokit, 'test-owner', 'test-repo');

    // Mock parent class methods
    (issuesService as any).assignCopilot = mockAssignCopilot;
    (issuesService as any).handleCopilotAssignmentForUpdatedIssue =
      mockHandleCopilotAssignmentForUpdatedIssue;
    (issuesService as any).handleCopilotAssignmentForUnchangedIssue =
      mockHandleCopilotAssignmentForUnchangedIssue;
  });

  afterEach(() => {
    infoSpy.mockRestore();
    mockListForRepo.mockClear();
    mockCreateIssue.mockClear();
    mockUpdateIssue.mockClear();
    mockAssignCopilot.mockClear();
    mockHandleCopilotAssignmentForUpdatedIssue.mockClear();
    mockHandleCopilotAssignmentForUnchangedIssue.mockClear();
  });

  describe('createResourceListIssue', () => {
    it('should create a new issue when none exists', async () => {
      // Mock no existing issues
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: false,
      });

      expect(mockListForRepo).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        labels: 'averlon-k8s-analysis',
        state: 'open',
        per_page: 100,
      });

      expect(mockCreateIssue).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: 'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart',
        body: expect.stringContaining('test-chart'),
        labels: ['averlon-created', 'averlon-k8s-analysis'],
      });

      expect(mockAssignCopilot).toHaveBeenCalledWith(1, false);
      expect(infoSpy).toHaveBeenCalledWith('Created resource list issue #1 for chart test-chart');
    });

    it('should update existing issue when one exists', async () => {
      // Mock existing issue
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 42,
            title: 'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart',
            state: 'open',
          },
        ],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: true,
      });

      expect(mockUpdateIssue).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
        title: 'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart',
        body: expect.stringContaining('test-chart'),
      });

      expect(mockHandleCopilotAssignmentForUpdatedIssue).toHaveBeenCalledWith(42, true);
      expect(infoSpy).toHaveBeenCalledWith('Updated resource list issue #42 for chart test-chart');
    });

    it('should include chart name, release name, and namespace in issue body', async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'my-namespace',
        resources: testResources,
        assignCopilot: false,
      });

      const createCall = mockCreateIssue.mock.calls[0][0];
      expect(createCall.body).toContain('**Chart:** `my-chart`');
      expect(createCall.body).toContain('**Release Name:** `my-release`');
      expect(createCall.body).toContain('**Namespace:** `my-namespace`');
    });

    it('should include total resource count in summary', async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: false,
      });

      const createCall = mockCreateIssue.mock.calls[0][0];
      const body = createCall.body as string;

      expect(body).toContain('Total resources scanned: 3');
    });

    it('should handle empty resources list', async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: [],
        assignCopilot: false,
      });

      const createCall = mockCreateIssue.mock.calls[0][0];
      const body = createCall.body as string;

      expect(body).toContain('Total resources scanned: 0');
    });

    it('should handle auto-assign copilot when enabled', async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: true,
        workflowRunUrl: 'https://github.com/test-owner/test-repo/actions/runs/1',
        artifactsUrl: 'https://github.com/test-owner/test-repo/actions/runs/1#artifacts',
      });

      expect(mockAssignCopilot).toHaveBeenCalledWith(1, true);
    });

    it('should check for existing issue by exact title match', async () => {
      // Mock existing issue with matching title
      mockListForRepo.mockResolvedValueOnce({
        data: [
          {
            number: 5,
            title: 'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart',
            state: 'open',
          },
          {
            number: 6,
            title: 'Averlon Misconfiguration Remediation Agent for Kubernetes: other-chart',
            state: 'open',
          },
        ],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: false,
      });

      // Should update issue #5, not create a new one
      expect(mockUpdateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 5,
        })
      );
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('should include workflow and artifact links when provided', async () => {
      mockListForRepo.mockResolvedValueOnce({
        data: [],
      } as any);

      const workflowRunUrl = 'https://github.com/test-owner/test-repo/actions/runs/123456789';
      const artifactsUrl = `${workflowRunUrl}#artifacts`;

      await issuesService.createResourceListIssue({
        chartName: 'link-chart',
        releaseName: 'link-release',
        namespace: 'link-namespace',
        resources: testResources,
        assignCopilot: false,
        workflowRunUrl,
        artifactsUrl,
      });

      const body = mockCreateIssue.mock.calls[0][0].body as string;
      expect(body).toContain(workflowRunUrl);
      expect(body).toContain(artifactsUrl);
    });
  });
});
