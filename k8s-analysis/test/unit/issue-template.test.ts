import { describe, it, expect } from 'bun:test';
import { generateIssueTitle, generateIssueBody } from '../../src/issue-template';
import type { ParsedResource } from '../../src/resource-parser';

describe('issue-template', () => {
  describe('generateIssueTitle', () => {
    it('should generate title with chart name', () => {
      expect(generateIssueTitle('my-chart')).toBe(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: my-chart'
      );
    });

    it('should handle chart names with special characters', () => {
      expect(generateIssueTitle('my-chart-v1.0.0')).toBe(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: my-chart-v1.0.0'
      );
    });

    it('should handle empty chart name', () => {
      expect(generateIssueTitle('')).toBe(
        'Averlon Misconfiguration Remediation Agent for Kubernetes: '
      );
    });
  });

  describe('generateIssueBody', () => {
    const createMockResource = (
      kind: string,
      name: string,
      namespace: string = 'default',
      issueIds: string[] = []
    ): ParsedResource => ({
      kind,
      name,
      namespace,
      apiVersion: 'v1',
      labels: {},
      annotations: {},
      rawYaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
      issues: issueIds.map(id => ({
        id,
        severity: 'High',
        title: `Issue ${id}`,
        summary: `Summary for ${id}`,
      })),
    });

    it('should generate body with chart, release name, and namespace', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        resources,
        issueIds: [],
        totalResources: 1,
        resourcesWithIssues: 0,
      });

      expect(body).toContain('**Chart:** `my-chart`');
      expect(body).toContain('**Release Name:** `my-release`');
      expect(body).toContain('**Namespace:** `production`');
    });

    it('should include summary statistics', () => {
      const resources: ParsedResource[] = [
        createMockResource('Deployment', 'deployment-1', 'default', ['issue-1', 'issue-2']),
        createMockResource('Service', 'service-1', 'default', ['issue-3']),
        createMockResource('ConfigMap', 'config-1', 'default', []), // No issues
      ];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1', 'issue-2', 'issue-3'],
        totalResources: 3,
        resourcesWithIssues: 2,
      });

      expect(body).toContain('Total resources scanned: 3');
      expect(body).toContain('Resources with issues: 2');
      expect(body).toContain('Unique issues found: 3');
    });

    it('should list all issue IDs in summary', () => {
      const resources: ParsedResource[] = [
        createMockResource('Deployment', 'deployment-1', 'default', ['issue-1', 'issue-2']),
        createMockResource('Service', 'service-1', 'default', ['issue-3']),
      ];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1', 'issue-2', 'issue-3'],
        totalResources: 2,
        resourcesWithIssues: 2,
      });

      expect(body).toContain('🔍 **Issue IDs:** issue-1, issue-2, issue-3');
    });

    it('should display "None" when no issue IDs are provided', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'deployment-1')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: [],
        totalResources: 1,
        resourcesWithIssues: 0,
      });

      expect(body).toContain('🔍 **Issue IDs:** None');
    });

    it('should include sidecar component evaluation instructions', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      // Check for the sidecar evaluation section
      expect(body).toContain('### ⚠️ Important: Sidecar Component Evaluation');
      expect(body).toContain('Before proceeding with any remediation');
      expect(body).toContain('sidecar" component');
      expect(body).toContain('Monitoring agents (cwagent, prometheus, datadog-agent, etc.)');
      expect(body).toContain('Service mesh components (istio, linkerd, consul, etc.)');
      expect(body).toContain('Network plugins (calico, cilium, weave, etc.)');
      expect(body).toContain('Logging agents (fluentd, fluent-bit, logstash, etc.)');
      expect(body).toContain('Security tools (falco, twistlock, aqua, etc.)');
      expect(body).toContain('CRITICAL RULE');
      expect(body).toContain('research and consult the official best practices');
    });

    it('should place sidecar instructions after summary and before remediation info', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      // Verify the order: Summary -> Sidecar Instructions -> Remediation Info
      const summaryIndex = body.indexOf('Total resources scanned');
      const sidecarIndex = body.indexOf('### ⚠️ Important: Sidecar Component Evaluation');
      const remediationIndex = body.indexOf('To get comprehensive remediation information');

      expect(summaryIndex).toBeGreaterThan(-1);
      expect(sidecarIndex).toBeGreaterThan(-1);
      expect(remediationIndex).toBeGreaterThan(-1);
      expect(sidecarIndex).toBeGreaterThan(summaryIndex);
      expect(remediationIndex).toBeGreaterThan(sidecarIndex);
    });

    it('should include artifact download instructions', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      expect(body).toContain('1. **Download artifacts** from this workflow run:');
      expect(body).toContain('k8s-analysis-output.json');
      expect(body).toContain('consolidated-issues.json');
    });

    it('should include artifact links when artifactsUrl is provided', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const artifactsUrl = 'https://github.com/test-owner/test-repo/actions/runs/123456#artifacts';

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
        artifactsUrl,
      });

      expect(body).toContain(artifactsUrl);
      expect(body).toContain('[`k8s-analysis-output.json`]');
      expect(body).toContain('[`consolidated-issues.json`]');
    });

    it('should include fallback text when artifactsUrl is not provided', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      expect(body).toContain('(see workflow artifacts tab)');
    });

    it('should include MCP tools instructions', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      expect(body).toContain('2. **Use Averlon MCP tools** (averlon_get_ide_recommendation)');
      expect(body).toContain('Asset details and context');
      expect(body).toContain('Misconfiguration information');
      expect(body).toContain('Specific remediation strategies');
    });

    it('should include workflow run link when workflowRunUrl is provided', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const workflowRunUrl = 'https://github.com/test-owner/test-repo/actions/runs/123456789';

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
        workflowRunUrl,
      });

      expect(body).toContain('Workflow run: [View logs & artifacts]');
      expect(body).toContain(workflowRunUrl);
    });

    it('should include fallback workflow run message when workflowRunUrl is not provided', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      expect(body).toContain(
        'Workflow run: Logs & artifacts are available in the GitHub Actions run that generated this issue.'
      );
    });

    it('should handle empty resources list', () => {
      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources: [],
        issueIds: [],
        totalResources: 0,
        resourcesWithIssues: 0,
      });

      expect(body).toContain('Total resources scanned: 0');
      expect(body).toContain('Resources with issues: 0');
      expect(body).toContain('Unique issues found: 0');
    });

    it('should include footer message', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1'],
        totalResources: 1,
        resourcesWithIssues: 1,
      });

      expect(body).toContain('_This issue was automatically created by Averlon Helm analysis._');
    });

    it('should handle multiple issue IDs correctly', () => {
      const resources: ParsedResource[] = [
        createMockResource('Deployment', 'deployment-1', 'default', ['issue-1']),
        createMockResource('Service', 'service-1', 'default', ['issue-2', 'issue-3']),
      ];

      const body = generateIssueBody({
        chartName: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        resources,
        issueIds: ['issue-1', 'issue-2', 'issue-3', 'issue-4'],
        totalResources: 2,
        resourcesWithIssues: 2,
      });

      expect(body).toContain('🔍 **Issue IDs:** issue-1, issue-2, issue-3, issue-4');
      expect(body).toContain('Unique issues found: 4');
    });

    it('should replace all placeholders correctly', () => {
      const resources: ParsedResource[] = [createMockResource('Deployment', 'test-deployment')];

      const body = generateIssueBody({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'my-namespace',
        resources,
        issueIds: ['id1', 'id2'],
        totalResources: 5,
        resourcesWithIssues: 3,
      });

      // Verify all placeholders are replaced (no brackets should remain)
      expect(body).not.toContain('[CHART_NAME]');
      expect(body).not.toContain('[RELEASE_NAME]');
      expect(body).not.toContain('[NAMESPACE]');
      expect(body).not.toContain('[COUNT]');
      expect(body).not.toContain('[RESOURCES_WITH_ISSUES]');
      expect(body).not.toContain('[UNIQUE_ISSUES_COUNT]');
      expect(body).not.toContain('[ISSUE_ID_1]');
      expect(body).not.toContain('[HELM_OUTPUT_BULLET]');
      expect(body).not.toContain('[CONSOLIDATED_ISSUES_BULLET]');
      expect(body).not.toContain('[WORKFLOW_RUN_NOTE]');
    });

    describe('image issues section', () => {
      const createContainerResourceWithImages = (
        kind: string,
        name: string,
        namespace: string = 'default',
        images: string[] = [],
        imageIssues: Array<{ id: string; imageRepository?: string; type?: string }> = []
      ): ParsedResource => ({
        kind,
        name,
        namespace,
        apiVersion: 'apps/v1',
        labels: {},
        annotations: {},
        rawYaml: `apiVersion: apps/v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
        metadata: { images },
        issues: imageIssues.map(issue => ({
          id: issue.id,
          severity: 'High',
          title: `CVE for ${issue.imageRepository || 'image'}`,
          summary: `Vulnerability in ${issue.imageRepository || 'image'}`,
          type: issue.type || 'Vulnerability',
          imageRepository: issue.imageRepository,
        })),
      });

      it('should not show image issues section when no image issues exist', () => {
        const resources: ParsedResource[] = [
          createMockResource('Deployment', 'deployment-1', 'default', ['issue-1']),
        ];

        const body = generateIssueBody({
          chartName: 'test-chart',
          releaseName: 'test-release',
          namespace: 'default',
          resources,
          issueIds: ['issue-1'],
          totalResources: 1,
          resourcesWithIssues: 1,
        });

        expect(body).not.toContain('### 🐳 Container Image Issues');
        expect(body).not.toContain('Image Issue IDs');
      });

      it('should show image issues section when image vulnerabilities exist', () => {
        const resources: ParsedResource[] = [
          createContainerResourceWithImages(
            'Deployment',
            'web-app',
            'production',
            ['nginx:1.19', 'redis:6'],
            [
              { id: 'img-issue-1', imageRepository: 'nginx', type: 'Vulnerability' },
              { id: 'img-issue-2', imageRepository: 'redis', type: 'Vulnerability' },
            ]
          ),
        ];

        const body = generateIssueBody({
          chartName: 'test-chart',
          releaseName: 'test-release',
          namespace: 'production',
          resources,
          issueIds: ['issue-1'],
          totalResources: 1,
          resourcesWithIssues: 1,
        });

        expect(body).toContain('### 🐳 Container Image Issues');
        expect(body).toContain('🔍 **Image Issue IDs:**');
        expect(body).toContain('img-issue-1');
        expect(body).toContain('img-issue-2');
        expect(body).toContain('**Images used:**');
      });

      it('should list images with their associated resources', () => {
        const resources: ParsedResource[] = [
          createContainerResourceWithImages(
            'Deployment',
            'web-app',
            'production',
            ['nginx:1.19'],
            [{ id: 'img-issue-1', imageRepository: 'nginx', type: 'Vulnerability' }]
          ),
        ];

        const body = generateIssueBody({
          chartName: 'test-chart',
          releaseName: 'test-release',
          namespace: 'production',
          resources,
          issueIds: [],
          totalResources: 1,
          resourcesWithIssues: 1,
        });

        expect(body).toContain('`nginx:1.19`');
        expect(body).toContain('Deployment/production/web-app');
      });

      it('should deduplicate image issues across multiple resources', () => {
        const resources: ParsedResource[] = [
          createContainerResourceWithImages(
            'Deployment',
            'web-app-1',
            'production',
            ['nginx:1.19'],
            [{ id: 'img-issue-1', imageRepository: 'nginx', type: 'Vulnerability' }]
          ),
          createContainerResourceWithImages(
            'Deployment',
            'web-app-2',
            'production',
            ['nginx:1.19'],
            [{ id: 'img-issue-1', imageRepository: 'nginx', type: 'Vulnerability' }]
          ),
        ];

        const body = generateIssueBody({
          chartName: 'test-chart',
          releaseName: 'test-release',
          namespace: 'production',
          resources,
          issueIds: [],
          totalResources: 2,
          resourcesWithIssues: 2,
        });

        // img-issue-1 should appear only once (deduplicated)
        const matches = body.match(/img-issue-1/g);
        expect(matches?.length).toBe(1);
      });

      it('should place image issues section after summary and before sidecar instructions', () => {
        const resources: ParsedResource[] = [
          createContainerResourceWithImages(
            'Deployment',
            'web-app',
            'production',
            ['nginx:1.19'],
            [{ id: 'img-issue-1', imageRepository: 'nginx', type: 'Vulnerability' }]
          ),
        ];

        const body = generateIssueBody({
          chartName: 'test-chart',
          releaseName: 'test-release',
          namespace: 'production',
          resources,
          issueIds: [],
          totalResources: 1,
          resourcesWithIssues: 1,
        });

        const summaryIndex = body.indexOf('Unique issues found');
        const imageIssuesIndex = body.indexOf('### 🐳 Container Image Issues');
        const sidecarIndex = body.indexOf('### ⚠️ Important: Sidecar Component Evaluation');

        expect(imageIssuesIndex).toBeGreaterThan(summaryIndex);
        expect(sidecarIndex).toBeGreaterThan(imageIssuesIndex);
      });
    });
  });
});
