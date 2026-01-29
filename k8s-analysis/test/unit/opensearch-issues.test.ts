import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import {
  IssueSeverityEnum,
  IssueTypeEnum,
  OpenSearchNamedQueryEnum,
  VulnerabilityClassEnum,
} from '@averlon/shared';
import type { ApiClient, OpenSearchIssue } from '@averlon/shared';
import type { ParsedResource, ResourceIssue } from '../../src/resource-parser';
import {
  extractImageIssuesForDisplay,
  annotateIssuesFromOpenSearch,
  type ImageIssueGroup,
} from '../../src/opensearch-issues';

/** Canonical repo keys from image-utils (parse-docker-image-name + default registry) */
const CANONICAL = {
  nginx: 'docker.io/library/nginx',
  redis: 'docker.io/library/redis',
  ghcrRepo: 'ghcr.io/org/repo',
} as const;

// Mock @actions/core
const mockCoreInfo = mock(() => {});
const mockCoreWarning = mock(() => {});
const mockCoreDebug = mock(() => {});

spyOn(core, 'info').mockImplementation(mockCoreInfo);
spyOn(core, 'warning').mockImplementation(mockCoreWarning);
spyOn(core, 'debug').mockImplementation(mockCoreDebug);

describe('opensearch-issues', () => {
  beforeEach(() => {
    mockCoreInfo.mockClear();
    mockCoreWarning.mockClear();
    mockCoreDebug.mockClear();
    // Clear environment variables
    delete process.env['IMAGE_REPOSITORY_QUERY_BATCH'];
    delete process.env['MAX_ISSUES_PER_RESOURCE'];
    delete process.env['RESOURCE_KIND_QUERY_BATCH'];
  });

  afterEach(() => {
    mockCoreInfo.mockClear();
    mockCoreWarning.mockClear();
    mockCoreDebug.mockClear();
  });

  describe('extractImageIssuesForDisplay', () => {
    const createResource = (
      kind: string,
      name: string,
      namespace: string = 'default',
      images: string[] = [],
      issues: ResourceIssue[] = []
    ): ParsedResource => ({
      kind,
      name,
      namespace,
      apiVersion: 'v1',
      labels: {},
      annotations: {},
      rawYaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
      metadata: images.length > 0 ? { images } : undefined,
      issues,
    });

    it('should return empty map when no container resources exist', () => {
      const resources: ParsedResource[] = [
        createResource('Service', 'my-service'),
        createResource('ConfigMap', 'my-config'),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(0);
    });

    it('should return empty map when container resources have no images or issues', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'my-deployment'),
        createResource('Pod', 'my-pod'),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(0);
    });

    it('should return image repositories even when no vulnerability issues exist (caller filters empty issues)', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'app',
          'default',
          ['nginx:1.19'],
          [
            {
              id: 'misconfig-1',
              severity: 'High',
              type: 'Misconfiguration', // Not a vulnerability
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      // Function returns image repos even without issues (caller filters empty issues)
      expect(result.size).toBe(1);
      const nginxGroup = result.get(CANONICAL.nginx)!;
      expect(nginxGroup.imageRepository).toBe(CANONICAL.nginx);
      expect(nginxGroup.images).toEqual(['nginx:1.19']); // One per repo (latest)
      expect(nginxGroup.issues.length).toBe(0); // No vulnerability issues
      expect(nginxGroup.resources.length).toBe(1);
    });

    it('should extract image issues from Deployment resources', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'web-app',
          'production',
          ['nginx:1.19', 'redis:6'],
          [
            {
              id: 'img-issue-1',
              severity: 'High',
              title: 'CVE-2023-1234',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
            {
              id: 'img-issue-2',
              severity: 'Medium',
              title: 'CVE-2023-5678',
              type: 'Vulnerability',
              imageRepository: 'redis',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(2);
      expect(result.has(CANONICAL.nginx)).toBe(true);
      expect(result.has(CANONICAL.redis)).toBe(true);

      const nginxGroup = result.get(CANONICAL.nginx)!;
      expect(nginxGroup.imageRepository).toBe(CANONICAL.nginx);
      expect(nginxGroup.images).toEqual(['nginx:1.19']);
      expect(nginxGroup.issues).toHaveLength(1);
      expect(nginxGroup.issues[0].id).toBe('img-issue-1');
      expect(nginxGroup.resources).toHaveLength(1);
      expect(nginxGroup.resources[0]).toEqual({
        kind: 'Deployment',
        name: 'web-app',
        namespace: 'production',
      });
    });

    it('should group multiple images by repository and use latest tag', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'app',
          'default',
          ['nginx:1.19', 'nginx:1.20'],
          [
            {
              id: 'img-issue-1',
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(1);
      const nginxGroup = result.get(CANONICAL.nginx)!;
      expect(nginxGroup.imageRepository).toBe(CANONICAL.nginx);
      // One image per repo: latest tag (1.20 > 1.19)
      expect(nginxGroup.images).toEqual(['nginx:1.20']);
    });

    it('should handle images with tags and digests', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Pod',
          'my-pod',
          'default',
          [
            'ghcr.io/org/repo:latest',
            'nginx@sha256:aaaaf56b44807c64d294e6c8059b479f35350b454492398225034174808d1726',
          ],
          [
            {
              id: 'img-issue-1',
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'ghcr.io/org/repo',
            },
            {
              id: 'img-issue-2',
              severity: 'Medium',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(2);
      expect(result.has(CANONICAL.ghcrRepo)).toBe(true);
      expect(result.has(CANONICAL.nginx)).toBe(true);
    });

    it('should aggregate issues from multiple resources using same image', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'app-1',
          'default',
          ['nginx:1.19'],
          [
            {
              id: 'img-issue-1',
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
        createResource(
          'Deployment',
          'app-2',
          'default',
          ['nginx:1.19'],
          [
            {
              id: 'img-issue-1', // Same issue ID - should be deduplicated
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
            {
              id: 'img-issue-2',
              severity: 'Medium',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(1);
      const nginxGroup = result.get(CANONICAL.nginx)!;
      // Should have 2 unique issues (img-issue-1 deduplicated, img-issue-2 added)
      expect(nginxGroup.issues.length).toBe(2);
      expect(nginxGroup.issues.map(i => i.id).sort()).toEqual(['img-issue-1', 'img-issue-2']);
      // Both resources should be included
      expect(nginxGroup.resources.length).toBe(2);
      expect(nginxGroup.resources.map(r => r.name).sort()).toEqual(['app-1', 'app-2']);
    });

    it('should filter out non-vulnerability issues', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'app',
          'default',
          ['nginx:1.19'],
          [
            {
              id: 'misconfig-1',
              severity: 'High',
              type: 'Misconfiguration',
            },
            {
              id: 'vuln-1',
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(1);
      const nginxGroup = result.get(CANONICAL.nginx)!;
      expect(nginxGroup.issues.length).toBe(1);
      expect(nginxGroup.issues[0].id).toBe('vuln-1');
    });

    it('should handle all container resource kinds', () => {
      const kinds = ['Pod', 'Deployment', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob'];
      const resources: ParsedResource[] = kinds.map((kind, index) =>
        createResource(
          kind,
          `resource-${index}`,
          'default',
          [`image-${index}:tag`],
          [
            {
              id: `issue-${index}`,
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: `image-${index}`,
            },
          ]
        )
      );

      const result = extractImageIssuesForDisplay(resources);

      expect(result.size).toBe(kinds.length);
      // Verify each kind is processed correctly (canonical repo = docker.io/library/image-N)
      for (let i = 0; i < kinds.length; i++) {
        const canonicalRepo = `docker.io/library/image-${i}`;
        const group = result.get(canonicalRepo);
        expect(group).toBeDefined();
        expect(group!.imageRepository).toBe(canonicalRepo);
        expect(group!.issues.length).toBe(1);
        expect(group!.issues[0].id).toBe(`issue-${i}`);
        expect(group!.resources[0].kind).toBe(kinds[i]);
      }
    });

    it('should use latest tag per repository when multiple tags exist', () => {
      const resources: ParsedResource[] = [
        createResource(
          'Deployment',
          'app',
          'default',
          ['nginx:1.20', 'nginx:1.19', 'nginx:latest', 'nginx:1.18'],
          [
            {
              id: 'issue-1',
              severity: 'High',
              type: 'Vulnerability',
              imageRepository: 'nginx',
            },
          ]
        ),
      ];

      const result = extractImageIssuesForDisplay(resources);

      const nginxGroup = result.get(CANONICAL.nginx)!;
      // One image per repo: latest tag ("latest" is greatest in compareTags)
      expect(nginxGroup.images).toEqual(['nginx:latest']);
    });
  });

  describe('annotateIssuesFromOpenSearch', () => {
    const createMockClient = (): ApiClient => {
      return {
        orgOpenSearchQuery: mock(() => Promise.resolve({ Issues: [] })),
      } as unknown as ApiClient;
    };

    const createResourceWithArn = (
      kind: string,
      name: string,
      namespace: string = 'default',
      arn: string = `arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/${kind}/${namespace}/${name}`
    ): ParsedResource => ({
      kind,
      name,
      namespace,
      apiVersion: 'v1',
      labels: {},
      annotations: {},
      rawYaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
      arn,
    });

    it('should return early when no resources have ARNs', async () => {
      const client = createMockClient();
      const resources: ParsedResource[] = [
        {
          kind: 'Deployment',
          name: 'test',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
      ];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(mockCoreWarning).toHaveBeenCalledWith(
        '⚠️  No resource ARNs available for issue lookup (region/cluster may be missing)'
      );
      expect(client.orgOpenSearchQuery).not.toHaveBeenCalled();
    });

    it('should query OpenSearch for misconfiguration issues', async () => {
      const mockQuery = mock(() =>
        Promise.resolve({
          Issues: [
            {
              ID: 'issue-1',
              ResourceID:
                'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app',
              SeverityV2: { Severity: IssueSeverityEnum.High },
              Title: 'Test Issue',
              Summary: 'Test Summary',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
          ],
        })
      );

      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(mockQuery).toHaveBeenCalled();
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.QueryID).toBe(OpenSearchNamedQueryEnum.Issue);
      expect(resources[0].issues).toBeDefined();
      expect(resources[0].issues!.length).toBe(1);
      expect(resources[0].issues![0].id).toBe('issue-1');
    });

    it('should filter by severity when provided', async () => {
      const mockQuery = mock(() => Promise.resolve({ Issues: [] }));
      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [IssueSeverityEnum.High, IssueSeverityEnum.Critical],
      });

      expect(mockQuery).toHaveBeenCalled();
      const filterQuery = JSON.parse(mockQuery.mock.calls[0][0].FilterQuery);
      const severityFilter = filterQuery.bool.filter.find(
        (f: any) => f.terms && f.terms['issue.SeverityV2.Severity']
      );
      expect(severityFilter).toBeDefined();
      expect(severityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.High.toString()
      );
      expect(severityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.Critical.toString()
      );
    });

    it('should batch resources by kind and chunk size', async () => {
      const mockQuery = mock(() => Promise.resolve({ Issues: [] }));
      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      process.env['RESOURCE_KIND_QUERY_BATCH'] = '2';

      const resources: ParsedResource[] = [
        createResourceWithArn('Deployment', 'app-1'),
        createResourceWithArn('Deployment', 'app-2'),
        createResourceWithArn('Deployment', 'app-3'),
        createResourceWithArn('Service', 'svc-1'),
      ];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      // Should be called for Deployment (2 chunks: [app-1, app-2], [app-3]) and Service (1 chunk)
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle OpenSearch errors gracefully', async () => {
      const mockQuery = mock(() => Promise.reject(new Error('Connection failed')));
      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed OrgOpenSearchQuery')
      );
    });

    it('should check for image issues when container resources exist', async () => {
      const mockQuery = mock((params: any) => {
        if (params.QueryID === OpenSearchNamedQueryEnum.Image) {
          return Promise.resolve({
            Images: [{ Repository: 'nginx' }],
          });
        }
        return Promise.resolve({ Issues: [] });
      });

      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];
      resources[0].metadata = { images: ['nginx:1.19'] };

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      // Should query for images (public images) and then for issues
      const imageQueryCall = mockQuery.mock.calls.find(
        (call: any[]) => call[0].QueryID === OpenSearchNamedQueryEnum.Image
      );
      expect(imageQueryCall).toBeDefined();
    });

    it('should skip image issues when getPublicImages returns empty', async () => {
      const queryCalls: any[] = [];
      const mockQuery = mock((params: any) => {
        queryCalls.push(params);
        if (params.QueryID === OpenSearchNamedQueryEnum.Image) {
          return Promise.resolve({ Images: [] });
        }
        return Promise.resolve({ Issues: [] });
      });
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];
      resources[0].metadata = { images: ['nginx:1.19'] };

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      const imageCalls = queryCalls.filter(c => c.QueryID === OpenSearchNamedQueryEnum.Image);
      const issueCalls = queryCalls.filter(c => c.QueryID === OpenSearchNamedQueryEnum.Issue);
      expect(imageCalls.length).toBe(1);
      expect(mockCoreInfo).toHaveBeenCalledWith(
        expect.stringContaining('No public images found in system')
      );
      expect(issueCalls.length).toBe(1);
    });

    it('should skip image section when no container resources', async () => {
      const queryCalls: any[] = [];
      const mockQuery = mock((params: any) => {
        queryCalls.push(params);
        return Promise.resolve({ Issues: [] });
      });
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [
        createResourceWithArn('Service', 'api', 'default'),
        createResourceWithArn('ConfigMap', 'config', 'default'),
      ];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      const imageCalls = queryCalls.filter(c => c.QueryID === OpenSearchNamedQueryEnum.Image);
      expect(imageCalls.length).toBe(0);
    });

    it('should skip image section when container resources have no image repos', async () => {
      const queryCalls: any[] = [];
      const mockQuery = mock((params: any) => {
        queryCalls.push(params);
        return Promise.resolve({ Issues: [] });
      });
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];
      resources[0].metadata = {};

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      const imageCalls = queryCalls.filter(c => c.QueryID === OpenSearchNamedQueryEnum.Image);
      expect(imageCalls.length).toBe(0);
    });

    it('should handle getPublicImages failure gracefully', async () => {
      const mockQuery = mock((params: any) => {
        if (params.QueryID === OpenSearchNamedQueryEnum.Image) {
          return Promise.reject(new Error('OpenSearch unavailable'));
        }
        return Promise.resolve({ Issues: [] });
      });
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];
      resources[0].metadata = { images: ['nginx:1.19'] };

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to query public images')
      );
    });

    it('should log "no indices provided" hints when OpenSearch returns that error', async () => {
      const mockQuery = mock((params: any) => Promise.reject(new Error('no indices provided')));
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('CloudID "123" may not exist or has no scan data')
      );
      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('CloudID does not exist')
      );
    });

    it('should attach only issues whose ResourceID matches a resource ARN', async () => {
      const deploymentArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app';
      const mockQuery = mock((params: any) => {
        if (params.QueryID === OpenSearchNamedQueryEnum.Image) {
          return Promise.resolve({ Images: [{ Repository: 'nginx' }] });
        }
        if (
          params.QueryID === OpenSearchNamedQueryEnum.Issue &&
          params.IncludeFields?.includes('issue.ImageRepository')
        ) {
          return Promise.resolve({
            Issues: [
              {
                ID: 'vuln-1',
                ResourceID: deploymentArn,
                ImageRepository: 'nginx',
                SeverityV2: { Severity: IssueSeverityEnum.High },
                Title: 'CVE-1',
                Type: IssueTypeEnum.Vulnerability,
                Status: 2,
              },
              {
                ID: 'vuln-2',
                ResourceID: 'arn:unknown/other/resource',
                ImageRepository: 'nginx',
                SeverityV2: { Severity: IssueSeverityEnum.High },
                Title: 'CVE-2',
                Type: IssueTypeEnum.Vulnerability,
                Status: 2,
              },
            ],
          });
        }
        return Promise.resolve({ Issues: [] });
      });
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app', 'default')];
      resources[0].arn = deploymentArn;
      resources[0].metadata = { images: ['nginx:1.19'] };

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(resources[0].issues).toBeDefined();
      const vulnIssues = resources[0].issues!.filter(i => i.type === 'Vulnerability');
      expect(vulnIssues.length).toBe(1);
      expect(vulnIssues[0].id).toBe('vuln-1');
    });

    it('should map issue with missing Severity to severity Unknown', async () => {
      const deploymentArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app';
      const mockQuery = mock(() =>
        Promise.resolve({
          Issues: [
            {
              ID: 'issue-no-severity',
              ResourceID: deploymentArn,
              Title: 'Test',
              Summary: 'Summary',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
          ],
        })
      );
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];
      resources[0].arn = deploymentArn;

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(resources[0].issues?.length).toBe(1);
      expect(resources[0].issues![0].severity).toBe('Unknown');
    });

    it('should map issue Severity enum to string (Invalid, Unknown, Low, Medium, High, Critical)', async () => {
      const deploymentArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app';
      const mockQuery = mock(() =>
        Promise.resolve({
          Issues: [
            {
              ID: 'i1',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.Invalid },
              Title: 'A',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
            {
              ID: 'i2',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.Unknown },
              Title: 'B',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
            {
              ID: 'i3',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.Low },
              Title: 'C',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
            {
              ID: 'i4',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.Medium },
              Title: 'D',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
            {
              ID: 'i5',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.High },
              Title: 'E',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
            {
              ID: 'i6',
              ResourceID: deploymentArn,
              SeverityV2: { Severity: IssueSeverityEnum.Critical },
              Title: 'F',
              Type: IssueTypeEnum.Misconfiguration,
              Status: 2,
            },
          ],
        })
      );
      const client = { orgOpenSearchQuery: mockQuery } as unknown as ApiClient;
      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];
      resources[0].arn = deploymentArn;

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      const severities = (resources[0].issues ?? []).map(i => i.severity);
      expect(severities).toContain('Invalid');
      expect(severities).toContain('Unknown');
      expect(severities).toContain('Low');
      expect(severities).toContain('Medium');
      expect(severities).toContain('High');
      expect(severities).toContain('Critical');
    });

    it('should respect MAX_ISSUES_PER_RESOURCE limit', async () => {
      const issues: OpenSearchIssue[] = Array.from({ length: 60 }, (_, i) => ({
        ID: `issue-${i}`,
        ResourceID:
          'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app',
        SeverityV2: { Severity: IssueSeverityEnum.High },
        Title: `Issue ${i}`,
        Summary: `Summary ${i}`,
        Type: IssueTypeEnum.Misconfiguration,
        Status: 2,
      }));

      const mockQuery = mock(() => Promise.resolve({ Issues: issues }));
      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      process.env['MAX_ISSUES_PER_RESOURCE'] = '50';

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
      });

      expect(resources[0].issues!.length).toBe(50);
    });

    it('should handle verbose logging', async () => {
      const mockQuery = mock(() => Promise.resolve({ Issues: [] }));
      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      const resources: ParsedResource[] = [createResourceWithArn('Deployment', 'app')];

      await annotateIssuesFromOpenSearch({
        client,
        cloudId: '123',
        resources,
        severityFilters: [],
        verbose: true,
      });

      expect(mockCoreInfo).toHaveBeenCalledWith(
        expect.stringContaining('Annotating issues from OpenSearch')
      );
    });

    it('should perform complete e2e flow: resource misconfigurations, public images, and image vulnerabilities', async () => {
      // Setup: Create resources with different types and images
      const deploymentArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/web-app';
      const statefulSetArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/StatefulSet/default/db';
      const serviceArn =
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Service/default/api';

      const resources: ParsedResource[] = [
        {
          kind: 'Deployment',
          name: 'web-app',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {},
          annotations: {},
          rawYaml: 'apiVersion: apps/v1\nkind: Deployment',
          arn: deploymentArn,
          metadata: {
            images: ['nginx:1.19', 'redis:6.2'],
          },
        },
        {
          kind: 'StatefulSet',
          name: 'db',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {},
          annotations: {},
          rawYaml: 'apiVersion: apps/v1\nkind: StatefulSet',
          arn: statefulSetArn,
          metadata: {
            images: ['postgres:13'],
          },
        },
        {
          kind: 'Service',
          name: 'api',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: 'apiVersion: v1\nkind: Service',
          arn: serviceArn,
        },
      ];

      // Track all query calls
      const queryCalls: any[] = [];

      const mockQuery = mock((params: any) => {
        queryCalls.push(params);

        // Query 1: Public images query (Image query) — response.Images with Repository
        if (params.QueryID === OpenSearchNamedQueryEnum.Image) {
          return Promise.resolve({
            Images: [{ Repository: 'nginx' }, { Repository: 'redis' }],
          });
        }

        // Query 2: Misconfiguration issues for Deployment
        if (
          params.QueryID === OpenSearchNamedQueryEnum.Issue &&
          params.FilterQuery.includes('kubernetes:Deployment') &&
          params.FilterQuery.includes(deploymentArn)
        ) {
          return Promise.resolve({
            Issues: [
              {
                ID: 'misconfig-deploy-1',
                ResourceID: deploymentArn,
                SeverityV2: { Severity: IssueSeverityEnum.High },
                Title: 'Deployment Security Issue',
                Summary: 'Missing security context',
                Type: IssueTypeEnum.Misconfiguration,
                Status: 2,
                Classification: 0,
              },
              {
                ID: 'misconfig-deploy-2',
                ResourceID: deploymentArn,
                SeverityV2: { Severity: IssueSeverityEnum.Critical },
                Title: 'Critical Deployment Issue',
                Summary: 'Privileged container',
                Type: IssueTypeEnum.Misconfiguration,
                Status: 2,
                Classification: 0,
              },
            ],
          });
        }

        // Query 3: Misconfiguration issues for StatefulSet
        // Note: Medium severity issues are filtered out by severity filter (High/Critical only)
        if (
          params.QueryID === OpenSearchNamedQueryEnum.Issue &&
          params.FilterQuery.includes('kubernetes:StatefulSet') &&
          params.FilterQuery.includes(statefulSetArn)
        ) {
          // Check if severity filter is applied - if so, Medium issues won't be returned
          const filterQuery = JSON.parse(params.FilterQuery);
          const hasSeverityFilter = filterQuery.bool.filter.some(
            (f: any) => f.terms && f.terms['issue.SeverityV2.Severity']
          );
          if (hasSeverityFilter) {
            // Severity filter is applied, so Medium issues are filtered out
            return Promise.resolve({ Issues: [] });
          }
          // If no severity filter, return the Medium issue (shouldn't happen in this test)
          return Promise.resolve({
            Issues: [
              {
                ID: 'misconfig-stateful-1',
                ResourceID: statefulSetArn,
                SeverityV2: { Severity: IssueSeverityEnum.Medium },
                Title: 'StatefulSet Issue',
                Summary: 'Volume mount issue',
                Type: IssueTypeEnum.Misconfiguration,
                Status: 2,
                Classification: 0,
              },
            ],
          });
        }

        // Query 4: Misconfiguration issues for Service
        // Note: Low severity issues are filtered out by severity filter (High/Critical only)
        if (
          params.QueryID === OpenSearchNamedQueryEnum.Issue &&
          params.FilterQuery.includes('kubernetes:Service') &&
          params.FilterQuery.includes(serviceArn)
        ) {
          // Check if severity filter is applied - if so, Low issues won't be returned
          const filterQuery = JSON.parse(params.FilterQuery);
          const hasSeverityFilter = filterQuery.bool.filter.some(
            (f: any) => f.terms && f.terms['issue.SeverityV2.Severity']
          );
          if (hasSeverityFilter) {
            // Severity filter is applied, so Low issues are filtered out
            return Promise.resolve({ Issues: [] });
          }
          // If no severity filter, return the Low issue (shouldn't happen in this test)
          return Promise.resolve({
            Issues: [
              {
                ID: 'misconfig-svc-1',
                ResourceID: serviceArn,
                SeverityV2: { Severity: IssueSeverityEnum.Low },
                Title: 'Service Issue',
                Summary: 'Service configuration issue',
                Type: IssueTypeEnum.Misconfiguration,
                Status: 2,
                Classification: 0,
              },
            ],
          });
        }

        // Query 5: Image vulnerability issues for nginx and redis
        if (
          params.QueryID === OpenSearchNamedQueryEnum.Issue &&
          params.FilterQuery.includes('issue.ImageRepository') &&
          params.IncludeFields?.includes('issue.ImageRepository')
        ) {
          const filterQuery = JSON.parse(params.FilterQuery);
          const imageRepos =
            filterQuery.bool.filter.find((f: any) => f.terms && f.terms['issue.ImageRepository'])
              ?.terms['issue.ImageRepository'] || [];

          const issues: any[] = [];

          if (imageRepos.includes(CANONICAL.nginx)) {
            issues.push({
              ID: 'vuln-nginx-1',
              ResourceID: deploymentArn,
              ImageRepository: 'nginx',
              SeverityV2: { Severity: IssueSeverityEnum.Critical },
              Title: 'CVE-2023-1234 in nginx',
              Summary: 'Critical vulnerability in nginx image',
              Type: IssueTypeEnum.Vulnerability,
              Status: 2,
              Classification: VulnerabilityClassEnum.RemoteCodeExecution,
            });
            issues.push({
              ID: 'vuln-nginx-2',
              ResourceID: deploymentArn,
              ImageRepository: 'nginx',
              SeverityV2: { Severity: IssueSeverityEnum.High },
              Title: 'CVE-2023-5678 in nginx',
              Summary: 'High severity vulnerability',
              Type: IssueTypeEnum.Vulnerability,
              Status: 2,
              Classification: VulnerabilityClassEnum.PrivilegeEscalation,
            });
          }

          if (imageRepos.includes(CANONICAL.redis)) {
            issues.push({
              ID: 'vuln-redis-1',
              ResourceID: deploymentArn,
              ImageRepository: 'redis',
              SeverityV2: { Severity: IssueSeverityEnum.High },
              Title: 'CVE-2023-9999 in redis',
              Summary: 'High severity vulnerability in redis',
              Type: IssueTypeEnum.Vulnerability,
              Status: 2,
              Classification: VulnerabilityClassEnum.InformationDisclosure,
            });
          }

          return Promise.resolve({ Issues: issues });
        }

        return Promise.resolve({ Issues: [] });
      });

      const client = {
        orgOpenSearchQuery: mockQuery,
      } as unknown as ApiClient;

      // Execute the e2e flow with severity filters (Critical and High only)
      await annotateIssuesFromOpenSearch({
        client,
        cloudId: 'test-cloud-123',
        resources,
        severityFilters: [IssueSeverityEnum.Critical, IssueSeverityEnum.High],
        verbose: false,
      });

      // Verify: All queries were made
      expect(mockQuery).toHaveBeenCalled();

      // Verify: Public images query was made
      const imageQueryCall = queryCalls.find(
        call => call.QueryID === OpenSearchNamedQueryEnum.Image
      );
      expect(imageQueryCall).toBeDefined();

      // Verify: Resource misconfiguration queries were made for each resource type
      const deploymentQuery = queryCalls.find(
        call =>
          call.QueryID === OpenSearchNamedQueryEnum.Issue &&
          call.FilterQuery.includes('kubernetes:Deployment')
      );
      expect(deploymentQuery).toBeDefined();

      const statefulSetQuery = queryCalls.find(
        call =>
          call.QueryID === OpenSearchNamedQueryEnum.Issue &&
          call.FilterQuery.includes('kubernetes:StatefulSet')
      );
      expect(statefulSetQuery).toBeDefined();

      const serviceQuery = queryCalls.find(
        call =>
          call.QueryID === OpenSearchNamedQueryEnum.Issue &&
          call.FilterQuery.includes('kubernetes:Service')
      );
      expect(serviceQuery).toBeDefined();

      // Verify: Image vulnerability query was made
      const imageVulnQuery = queryCalls.find(
        call =>
          call.QueryID === OpenSearchNamedQueryEnum.Issue &&
          call.IncludeFields?.includes('issue.ImageRepository')
      );
      expect(imageVulnQuery).toBeDefined();
      expect(imageVulnQuery.IncludeFields).toContain('issue.ImageRepository');

      // Verify: Deployment resource has both misconfiguration and image issues
      const deployment = resources.find(r => r.kind === 'Deployment');
      expect(deployment?.issues).toBeDefined();
      expect(deployment?.issues!.length).toBeGreaterThan(0);

      // Deployment should have 2 misconfiguration issues (High and Critical)
      const deployMisconfigs = deployment?.issues!.filter(i => i.type === 'Misconfiguration');
      expect(deployMisconfigs?.length).toBe(2);
      expect(deployMisconfigs?.some(i => i.id === 'misconfig-deploy-1')).toBe(true);
      expect(deployMisconfigs?.some(i => i.id === 'misconfig-deploy-2')).toBe(true);

      // Deployment should have image vulnerabilities for nginx (2 issues) and redis (1 issue)
      const deployImageIssues = deployment?.issues!.filter(i => i.type === 'Vulnerability');
      expect(deployImageIssues?.length).toBe(3);
      expect(deployImageIssues?.some(i => i.id === 'vuln-nginx-1')).toBe(true);
      expect(deployImageIssues?.some(i => i.id === 'vuln-nginx-2')).toBe(true);
      expect(deployImageIssues?.some(i => i.id === 'vuln-redis-1')).toBe(true);

      // Verify image repository is set on vulnerability issues
      const nginxVuln = deployImageIssues?.find(i => i.id === 'vuln-nginx-1');
      expect(nginxVuln?.imageRepository).toBe('nginx');
      expect(nginxVuln?.severity).toBe('Critical');
      expect(nginxVuln?.classification).toContain('RemoteCodeExecution');

      // Verify: StatefulSet has no issues (Medium severity is filtered out by query)
      const statefulSet = resources.find(r => r.kind === 'StatefulSet');
      // The query includes severity filter for High/Critical only, so Medium issues won't be returned
      // StatefulSet should have no issues since Medium is excluded
      expect(statefulSet?.issues).toBeUndefined();

      // Verify: Service has no issues (Low severity is filtered out by query)
      const service = resources.find(r => r.kind === 'Service');
      // Service issue is Low, which is filtered out by the severity filter in the query
      expect(service?.issues).toBeUndefined();

      // Verify: Severity filtering is applied in queries
      const deploymentFilterQuery = JSON.parse(deploymentQuery.FilterQuery);
      const deploymentSeverityFilter = deploymentFilterQuery.bool.filter.find(
        (f: any) => f.terms && f.terms['issue.SeverityV2.Severity']
      );
      expect(deploymentSeverityFilter).toBeDefined();
      expect(deploymentSeverityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.Critical.toString()
      );
      expect(deploymentSeverityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.High.toString()
      );

      // Verify: Image vulnerability query also has severity filter
      const imageVulnFilterQuery = JSON.parse(imageVulnQuery.FilterQuery);
      const imageVulnSeverityFilter = imageVulnFilterQuery.bool.filter.find(
        (f: any) => f.terms && f.terms['issue.SeverityV2.Severity']
      );
      expect(imageVulnSeverityFilter).toBeDefined();
      expect(imageVulnSeverityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.Critical.toString()
      );
      expect(imageVulnSeverityFilter.terms['issue.SeverityV2.Severity']).toContain(
        IssueSeverityEnum.High.toString()
      );

      // Verify: All issues have proper structure
      deployment?.issues!.forEach(issue => {
        expect(issue.id).toBeDefined();
        expect(issue.severity).toBeDefined();
        expect(issue.type).toBeDefined();
        expect(['Misconfiguration', 'Vulnerability']).toContain(issue.type!);
        if (issue.type === 'Vulnerability') {
          expect(issue.imageRepository).toBeDefined();
          expect(typeof issue.imageRepository).toBe('string');
        }
      });

      // Verify: Total issues count
      const totalIssues = resources.reduce((sum, r) => sum + (r.issues?.length || 0), 0);
      expect(totalIssues).toBe(5); // 2 misconfigs + 3 image vulns for Deployment
    });
  });
});
