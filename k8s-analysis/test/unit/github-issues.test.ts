import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { GithubIssuesService } from '../../src/github-issues';
import type { ParsedResource } from '../../src/resource-parser';

// Mock the CopilotIssueManager methods
const mockAssignCopilot = mock(() => Promise.resolve());

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
  });

  afterEach(() => {
    infoSpy.mockRestore();
    mockListForRepo.mockClear();
    mockCreateIssue.mockClear();
    mockUpdateIssue.mockClear();
    mockAssignCopilot.mockClear();
  });

  describe('createResourceListIssue', () => {
    // One issue per namespace — no batching by count/size; unlikely to have so many resources in one namespace.
    it('should create one issue per namespace when none exists', async () => {
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

      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      const titles = mockCreateIssue.mock.calls.map(c => c[0].title);
      expect(titles).toContain(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart - default'
      );
      expect(titles).toContain(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart - production'
      );
      expect(mockCreateIssue.mock.calls[0][0].body).toContain('test-chart');
      expect(mockCreateIssue.mock.calls[0][0].body).toContain('<!-- averlon-batch-state');
      expect(mockAssignCopilot).toHaveBeenCalledTimes(2);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /GitHub issue\(s\) for chart test-chart created\/updated: #\d+(, #\d+)?/
        )
      );
    });

    it('should create a new issue when one resource has new issues (existing issue is not updated)', async () => {
      const singleResource: ParsedResource[] = [
        { ...testResources[0]!, issues: [{ id: 'new-issue-id', title: 'New finding' }] },
      ];
      const resourceKey = 'test-chart/Deployment/default/test-deployment';
      const state = {
        v: 1,
        keys: [resourceKey],
        fingerprints: { [resourceKey]: 'old-fingerprint' },
      };
      const existingStateBody = `Previous content\n\n<!-- averlon-batch-state\n${JSON.stringify(state)}\n-->`;
      mockListForRepo.mockResolvedValueOnce({
        data: [{ number: 42, body: existingStateBody }],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: singleResource,
        assignCopilot: true,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      expect(mockCreateIssue.mock.calls[0][0].body).toContain('<!-- averlon-batch-state');
      expect(mockCreateIssue.mock.calls[0][0].body).toContain('new-issue-id');
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(mockAssignCopilot).toHaveBeenCalledWith(1, true);
    });

    it('should create one new issue per namespace when resources have new issues', async () => {
      const resourcesWithNewIssues: ParsedResource[] = testResources.map((r, i) => ({
        ...r,
        issues: [{ id: `new-id-${i}`, title: 'New finding' }],
      }));
      const resourceKeys = [
        'test-chart/ConfigMap/production/test-config',
        'test-chart/Deployment/default/test-deployment',
        'test-chart/Service/default/test-service',
      ];
      const state = {
        v: 1,
        keys: resourceKeys,
        fingerprints: Object.fromEntries(resourceKeys.map(k => [k, 'old-fingerprint'])),
      };
      const existingStateBody = `Previous content\n\n<!-- averlon-batch-state\n${JSON.stringify(state)}\n-->`;
      mockListForRepo.mockResolvedValueOnce({
        data: [{ number: 42, body: existingStateBody }],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: resourcesWithNewIssues,
        assignCopilot: true,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      expect(mockAssignCopilot).toHaveBeenCalledTimes(2);
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

      const bodies = mockCreateIssue.mock.calls.map(c => c[0].body as string);
      expect(bodies).toHaveLength(2);
      expect(bodies.every(b => b.includes('**Chart:** `my-chart`'))).toBe(true);
      expect(bodies.every(b => b.includes('**Release Name:** `my-release`'))).toBe(true);
      expect(bodies.every(b => b.includes('**Namespace:**'))).toBe(true);
    });

    it('should include total resource count in summary (per-namespace)', async () => {
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

      const bodies = mockCreateIssue.mock.calls.map(c => c[0].body as string);
      expect(bodies.some(b => b.includes('Total resources scanned: 2'))).toBe(true);
      expect(bodies.some(b => b.includes('Total resources scanned: 1'))).toBe(true);
    });

    it('should do nothing when all resources unchanged (same fingerprints)', async () => {
      const resourcesWithMatchingFp: ParsedResource[] = testResources.map((r, i) => ({
        ...r,
        issues: [{ id: `fp-${i}`, title: 'Same' }],
      }));
      const resourceKeys = [
        'test-chart/Deployment/default/test-deployment',
        'test-chart/Service/default/test-service',
        'test-chart/ConfigMap/production/test-config',
      ];
      const state = {
        v: 1,
        keys: resourceKeys,
        fingerprints: Object.fromEntries(resourceKeys.map((k, i) => [k, `fp-${i}`])),
      };
      const existingStateBody = `Content\n\n<!-- averlon-batch-state\n${JSON.stringify(state)}\n-->`;
      mockListForRepo.mockResolvedValueOnce({
        data: [{ number: 10, body: existingStateBody }],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: resourcesWithMatchingFp,
        assignCopilot: false,
      });

      expect(mockListForRepo).toHaveBeenCalledTimes(1);
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        'No batches to create or update for chart test-chart (already up to date)'
      );
    });

    it('should do nothing when issues decreased (fewer issues than existing)', async () => {
      const resourceKey = 'test-chart/Deployment/default/test-deployment';
      const state = {
        v: 1,
        keys: [resourceKey],
        fingerprints: { [resourceKey]: 'issue-1,issue-2,issue-3' },
      };
      const existingStateBody = `Content\n\n<!-- averlon-batch-state\n${JSON.stringify(state)}\n-->`;
      mockListForRepo.mockResolvedValueOnce({
        data: [{ number: 7, body: existingStateBody }],
      } as any);

      const resourceWithFewerIssues: ParsedResource[] = [
        {
          ...testResources[0]!,
          issues: [{ id: 'issue-1', title: 'Only one' }],
        },
      ];

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: resourceWithFewerIssues,
        assignCopilot: false,
      });

      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        'No batches to create or update for chart test-chart (already up to date)'
      );
    });

    it('should create three issues when resources span three namespaces', async () => {
      const threeNamespaceResources: ParsedResource[] = [
        { ...testResources[0]!, namespace: 'default' },
        { ...testResources[1]!, namespace: 'default' },
        { ...testResources[2]!, namespace: 'production' },
        {
          kind: 'Secret',
          name: 'my-secret',
          namespace: 'kube-system',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: 'apiVersion: v1\nkind: Secret',
        },
      ];
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: threeNamespaceResources,
        assignCopilot: false,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(3);
      const titles = mockCreateIssue.mock.calls.map(c => c[0].title);
      expect(titles).toContain(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart - default'
      );
      expect(titles).toContain(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart - production'
      );
      expect(titles).toContain(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: test-chart - kube-system'
      );
    });

    it('should apply correct labels to created issues', async () => {
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: testResources,
        assignCopilot: false,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      mockCreateIssue.mock.calls.forEach(call => {
        expect(call[0].labels).toEqual(['averlon-created', 'averlon-k8s-analysis']);
      });
    });

    it('should handle empty resources list', async () => {
      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: [],
        assignCopilot: false,
      });

      expect(mockListForRepo).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        'No resources for chart test-chart; skipping issue creation'
      );
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

      expect(mockAssignCopilot).toHaveBeenCalledTimes(2);
      expect(mockAssignCopilot).toHaveBeenCalledWith(1, true);
    });

    it('should create one new issue per namespace when fingerprints changed', async () => {
      const resourcesWithNewIssues: ParsedResource[] = testResources.map((r, i) => ({
        ...r,
        issues: [{ id: `changed-id-${i}`, title: 'Finding' }],
      }));
      const testChartKeys = [
        'test-chart/ConfigMap/production/test-config',
        'test-chart/Deployment/default/test-deployment',
        'test-chart/Service/default/test-service',
      ];
      const state5 = {
        v: 1,
        keys: testChartKeys,
        fingerprints: Object.fromEntries(testChartKeys.map(k => [k, 'previous-fp'])),
      };
      const stateBody5 = `Content\n\n<!-- averlon-batch-state\n${JSON.stringify(state5)}\n-->`;
      const stateBody6 =
        'Other\n\n<!-- averlon-batch-state\n{"v":1,"keys":["other-chart/Deployment/default/foo"],"fingerprints":{"other-chart/Deployment/default/foo":"x"}}\n-->';
      mockListForRepo.mockResolvedValueOnce({
        data: [
          { number: 5, body: stateBody5 },
          { number: 6, body: stateBody6 },
        ],
      } as any);

      await issuesService.createResourceListIssue({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: resourcesWithNewIssues,
        assignCopilot: false,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });

    it('should create one issue per namespace (single namespace = one issue; no batching)', async () => {
      const manyResources: ParsedResource[] = Array.from({ length: 25 }, (_, i) => ({
        kind: 'Deployment',
        name: `deploy-${i}`,
        namespace: 'default',
        apiVersion: 'apps/v1',
        labels: {},
        annotations: {},
        rawYaml: `apiVersion: apps/v1\nkind: Deployment`,
      }));
      mockListForRepo.mockResolvedValueOnce({ data: [] } as any);

      await issuesService.createResourceListIssue({
        chartName: 'big-chart',
        releaseName: 'release',
        namespace: 'default',
        resources: manyResources,
        assignCopilot: false,
      });

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      expect(mockCreateIssue.mock.calls[0][0].title).toBe(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: big-chart - default'
      );
      expect(mockCreateIssue.mock.calls[0][0].body).toContain('Total resources scanned: 25');
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

      const bodies = mockCreateIssue.mock.calls.map(c => c[0].body as string);
      expect(bodies.some(b => b.includes(workflowRunUrl))).toBe(true);
      expect(bodies.some(b => b.includes(artifactsUrl))).toBe(true);
    });
  });
});
