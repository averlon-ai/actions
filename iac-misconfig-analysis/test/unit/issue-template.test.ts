import { describe, it, expect } from 'bun:test';
import { generateIssueTitle, generateIssueBody } from '../../src/issue-template';
import type { TerraformResource } from '@averlon/shared';

describe('issue-template', () => {
  describe('generateIssueTitle', () => {
    it('should generate title for single batch', () => {
      expect(generateIssueTitle(1, 1)).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 1'
      );
    });

    it('should generate title for multiple batches', () => {
      expect(generateIssueTitle(1, 3)).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 1 of 3'
      );
      expect(generateIssueTitle(2, 3)).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 2 of 3'
      );
      expect(generateIssueTitle(3, 3)).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 3 of 3'
      );
    });

    it('should handle edge case with totalBatches = 0', () => {
      expect(generateIssueTitle(1, 0)).toBe(
        'Averlon Misconfiguration Remediation Agent for IaC: Batch 1'
      );
    });
  });

  describe('generateIssueBody', () => {
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

    it('should generate body with repository and commit information', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'my-terraform-repo',
        commit: 'abc123def',
        issueIds: ['issue-1'],
      });

      expect(body).toContain('**Repository:** `my-terraform-repo`');
      expect(body).toContain('**Commit:** `abc123def`');
    });

    it('should include batch information when totalBatches > 1', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 2,
        totalBatches: 3,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      expect(body).toContain('**Batch:** 2 of 3');
    });

    it('should not include batch information when totalBatches = 1', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      expect(body).not.toContain('**Batch:**');
    });

    it('should include summary statistics', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1', 'issue-2']),
        createMockResource('resource-2', 'aws_ec2_instance', 'instance-1', ['issue-3']),
        createMockResource('resource-3', 'aws_s3_bucket', 'bucket-2', []), // No issues
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1', 'issue-2', 'issue-3'],
      });

      expect(body).toContain('Total resources scanned: 3');
      expect(body).toContain('Resources with issues: 2');
      expect(body).toContain('Unique issues found: 3');
    });

    it('should list all issue IDs in summary', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1', 'issue-2']),
        createMockResource('resource-2', 'aws_ec2_instance', 'instance-1', ['issue-3']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1', 'issue-2', 'issue-3'],
      });

      expect(body).toContain('🔍 **Issue IDs:** issue-1, issue-2, issue-3');
    });

    it('should include detailed resource information', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
        createMockResource('resource-2', 'aws_ec2_instance', 'instance-1', ['issue-2']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1', 'issue-2'],
      });

      expect(body).toContain('#### Resource 1: `aws_s3_bucket.bucket-1`');
      expect(body).toContain('**ID:** `resource-1`');
      expect(body).toContain('**Asset ID:** `asset-resource-1`');
      expect(body).toContain('**Resource ID:** `resource-resource-1`');

      expect(body).toContain('#### Resource 2: `aws_ec2_instance.instance-1`');
      expect(body).toContain('**ID:** `resource-2`');
    });

    it('should list issues for each resource', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1', 'issue-2']),
        createMockResource('resource-2', 'aws_ec2_instance', 'instance-1', []),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1', 'issue-2'],
      });

      expect(body).toContain('**Issues (2):**');
      expect(body).toContain('Issue ID: `issue-1`');
      expect(body).toContain('Issue ID: `issue-2`');
      expect(body).toContain('**Issues:** None'); // For resource-2
    });

    it('should include reachability information when available', () => {
      const resources: TerraformResource[] = [
        {
          ID: 'resource-1',
          Type: 'aws_s3_bucket',
          Name: 'bucket-1',
          Asset: {
            ID: 'asset-1',
            ResourceID: 'resource-1',
          },
          Issues: [
            {
              ID: 'issue-1',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
          ],
          Reachability: {
            IsReachableFromInternet: true,
            CanReachInternet: false,
          },
        },
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      expect(body).toContain('**Reachable from Internet:** Yes');
      expect(body).toContain('**Can reach Internet:** No');
    });

    it('should include next steps section', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      expect(body).toContain('### 📝 Next Steps');
      expect(body).toContain('Use Averlon MCP tools');
      expect(body).toContain('Asset details and context');
      expect(body).toContain('Misconfiguration information');
      expect(body).toContain('Specific remediation strategies');
    });

    it('should list other batches when totalBatches > 1', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 2,
        totalBatches: 3,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      // Verify batch information is included
      expect(body).toContain('**Batch:** 2 of 3');
    });

    it('should handle resources with missing fields gracefully', () => {
      const resources: TerraformResource[] = [
        {
          ID: undefined,
          Type: undefined,
          Name: undefined,
          Issues: [],
        },
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: [],
      });

      expect(body).toContain('#### Resource 1: `Unknown.Unknown`');
      expect(body).toContain('**ID:** `resource-1`'); // Falls back to resource-{index}
    });

    it('should handle empty resources list', () => {
      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources: [],
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: [],
      });

      expect(body).toContain('Total resources scanned: 0');
      expect(body).toContain('Resources with issues: 0');
      expect(body).toContain('Unique issues found: 0');
    });

    it('should include footer message', () => {
      const resources: TerraformResource[] = [
        createMockResource('resource-1', 'aws_s3_bucket', 'bucket-1', ['issue-1']),
      ];

      const body = generateIssueBody({
        batchNumber: 1,
        totalBatches: 1,
        resources,
        repoName: 'test-repo',
        commit: 'abc123',
        issueIds: ['issue-1'],
      });

      expect(body).toContain(
        '_This issue was automatically created by Averlon Misconfiguration Remediation Agent for IaC._'
      );
    });
  });
});
