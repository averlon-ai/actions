import { describe, it, expect, mock } from 'bun:test';
import {
  dedupeResourceIds,
  deriveGcpFullResourceName,
  extractPulumiCandidateIds,
  extractTerraformCandidateIds,
  isStableResourceId,
} from '../../src/iac-resource';
import { correlateExistingIssues } from '../../src/local-analysis';
import { parsePulumiStackJson } from '../../src/pulumi';
import {
  parseTerraformPlanJson,
  parseTerraformStateJson,
  parseTerraformJson,
} from '../../src/terraform-local';
import type { ApiClient } from '@averlon/shared';

describe('resource ID extraction', () => {
  it('rejects terraform placeholder IDs', () => {
    expect(isStableResourceId('(known after apply)')).toBe(false);
    expect(isStableResourceId('arn:aws:s3:::my-bucket')).toBe(true);
  });

  it('collects terraform candidates from before and after', () => {
    const candidates = extractTerraformCandidateIds('aws_lambda_function', {
      before: { id: 'old-lambda-name' },
      after: { arn: 'arn:aws:lambda:us-east-1:123:function:new-lambda-name' },
    });

    expect(candidates).toEqual([
      'arn:aws:lambda:us-east-1:123:function:new-lambda-name',
      'old-lambda-name',
    ]);
  });

  it('prefers arn for IAM resources', () => {
    const candidates = extractTerraformCandidateIds('aws_iam_role', {
      after: {
        id: 'admin-role',
        arn: 'arn:aws:iam::123456789012:role/admin-role',
      },
    });

    expect(candidates[0]).toBe('arn:aws:iam::123456789012:role/admin-role');
  });

  it('emits a lowercased candidate for azure resources (backend stores lowercase ARM ids)', () => {
    const id =
      '/subscriptions/4fdf88e0-fed9-4d19-82d7-ffd8a59618fa/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/mystorageacct';
    const candidates = extractTerraformCandidateIds('azurerm_storage_account', {
      after: { id, name: 'mystorageacct' },
    });

    expect(candidates).toContain(id);
    expect(candidates).toContain(id.toLowerCase());
  });

  it('derives the GCP CAI full resource name from self_link', () => {
    const candidates = extractTerraformCandidateIds('google_compute_instance', {
      after: {
        id: 'projects/p/zones/us-central1-a/instances/vm-1',
        self_link:
          'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/vm-1',
      },
    });

    expect(candidates).toContain(
      '//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm-1'
    );
  });

  it('derives CAI names for compute and storage self_links', () => {
    expect(
      deriveGcpFullResourceName(
        'https://www.googleapis.com/compute/v1/projects/p/global/networks/default'
      )
    ).toBe('//compute.googleapis.com/projects/p/global/networks/default');
    expect(deriveGcpFullResourceName('https://storage.googleapis.com/storage/v1/b/my-bucket')).toBe(
      '//storage.googleapis.com/my-bucket'
    );
    expect(deriveGcpFullResourceName('not-a-url')).toBeUndefined();
  });

  it('collects pulumi candidates from oldState when outputs are empty', () => {
    const candidates = extractPulumiCandidateIds({
      outputs: {},
      oldState: { id: 'i-abc123' },
    });

    expect(candidates).toEqual(['i-abc123']);
  });

  it('collects pulumi arn from nested newState.outputs and ranks it before physical id', () => {
    const candidates = extractPulumiCandidateIds({
      newState: {
        id: 'my-bucket',
        outputs: { arn: 'arn:aws:s3:::my-bucket', bucket: 'my-bucket' },
      },
    });

    expect(candidates[0]).toBe('arn:aws:s3:::my-bucket');
    expect(candidates).toContain('my-bucket');
  });

  it('deduplicates candidate IDs', () => {
    expect(dedupeResourceIds(['i-1', 'i-1', 'arn:aws:s3:::bucket'])).toEqual([
      'i-1',
      'arn:aws:s3:::bucket',
    ]);
  });
});

describe('terraform plan parsing', () => {
  it('extracts resources with stable IDs, including no-op resources', () => {
    const resources = parseTerraformPlanJson(
      JSON.stringify({
        resource_changes: [
          {
            address: 'aws_s3_bucket.iac',
            type: 'aws_s3_bucket',
            name: 'iac',
            change: { actions: ['create'], after: { arn: 'arn:aws:s3:::iac-bucket' } },
          },
          {
            address: 'aws_iam_role.same',
            type: 'aws_iam_role',
            name: 'same',
            change: { actions: ['no-op'], after: { arn: 'arn:aws:iam::123:role/same' } },
          },
          {
            address: 'aws_lambda_function.new',
            type: 'aws_lambda_function',
            name: 'new',
            change: { actions: ['create'], after: { function_name: 'new-fn' } },
          },
        ],
      })
    );

    expect(resources).toHaveLength(2);
    expect(resources).toEqual([
      expect.objectContaining({
        id: 'aws_s3_bucket.iac',
        type: 'aws_s3_bucket',
        operation: 'create',
        candidateResourceIds: ['arn:aws:s3:::iac-bucket'],
      }),
      expect.objectContaining({
        id: 'aws_iam_role.same',
        type: 'aws_iam_role',
        operation: 'no-op',
        candidateResourceIds: ['arn:aws:iam::123:role/same'],
      }),
    ]);
  });
});

describe('terraform state parsing', () => {
  it('parses raw tfstate google resources with CAI candidates', () => {
    const resources = parseTerraformStateJson(
      JSON.stringify({
        version: 4,
        resources: [
          {
            type: 'google_storage_bucket',
            name: 'terraform_state',
            instances: [
              {
                attributes: {
                  id: 'my-bucket',
                  name: 'my-bucket',
                  self_link: 'https://www.googleapis.com/storage/v1/b/my-bucket',
                },
              },
            ],
          },
          {
            type: 'google_project',
            name: 'this',
            instances: [
              {
                attributes: {
                  project_id: 'goat-shared-1',
                  number: '987604224719',
                },
              },
            ],
          },
        ],
      })
    );

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'google_storage_bucket',
          operation: 'state',
          candidateResourceIds: expect.arrayContaining(['//storage.googleapis.com/my-bucket']),
        }),
        expect.objectContaining({
          type: 'google_project',
          operation: 'state',
          candidateResourceIds: expect.arrayContaining([
            '//cloudresourcemanager.googleapis.com/projects/goat-shared-1',
            '//cloudresourcemanager.googleapis.com/projects/987604224719',
          ]),
        }),
      ])
    );
  });

  it('auto-detects plan vs state JSON', () => {
    const planResources = parseTerraformJson(
      JSON.stringify({
        resource_changes: [
          {
            address: 'aws_s3_bucket.b',
            type: 'aws_s3_bucket',
            name: 'b',
            change: { actions: ['no-op'], after: { bucket: 'b' } },
          },
        ],
      })
    );
    expect(planResources[0]?.operation).toBe('no-op');

    const stateResources = parseTerraformJson(
      JSON.stringify({
        version: 4,
        resources: [
          {
            type: 'google_organization',
            name: 'org',
            instances: [{ attributes: { org_id: '123', name: 'organizations/123' } }],
          },
        ],
      })
    );
    expect(stateResources[0]?.operation).toBe('state');
  });
});

describe('pulumi stack parsing', () => {
  it('extracts stack resources and skips internal types', () => {
    const resources = parsePulumiStackJson(
      JSON.stringify({
        deployment: {
          resources: [
            {
              urn: 'urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev',
              type: 'pulumi:pulumi:Stack',
            },
            {
              urn: 'urn:pulumi:dev::app::aws:s3/bucket:Bucket::iac-bucket',
              type: 'aws:s3/bucket:Bucket',
              id: 'iac-bucket',
              outputs: { arn: 'arn:aws:s3:::iac-bucket' },
            },
            {
              urn: 'urn:pulumi:dev::app::aws:ec2/instance:Instance::old-instance',
              type: 'aws:ec2/instance:Instance',
              id: 'i-abc123',
            },
          ],
        },
      })
    );

    expect(resources).toHaveLength(2);
    expect(resources[0]?.candidateResourceIds).toEqual(['arn:aws:s3:::iac-bucket', 'iac-bucket']);
    expect(resources[1]?.candidateResourceIds).toEqual(['i-abc123']);
  });

  it('parses parent URN chains and provider filtering', () => {
    const resources = parsePulumiStackJson(
      JSON.stringify({
        deployment: {
          resources: [
            {
              urn: 'urn:pulumi:dev::app::pulumi:providers:aws::default_6_0_0',
              type: 'pulumi:providers:aws',
              id: 'provider-id-123',
            },
            {
              urn: 'urn:pulumi:dev::app::my:component:Bucket$aws:s3/bucket:Bucket::data',
              type: 'aws:s3/bucket:Bucket',
              id: 'data-bucket',
              outputs: { arn: 'arn:aws:s3:::data-bucket', bucket: 'data-bucket' },
            },
          ],
        },
      })
    );

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: 'aws:s3/bucket:Bucket',
      name: 'data',
      operation: 'applied',
    });
    expect(resources[0]?.candidateResourceIds[0]).toBe('arn:aws:s3:::data-bucket');
  });

  it('extracts applied resources from stack export JSON', () => {
    const resources = parsePulumiStackJson(
      JSON.stringify({
        deployment: {
          resources: [
            {
              urn: 'urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev',
              type: 'pulumi:pulumi:Stack',
              outputs: {
                bucket_arn: 'arn:aws:s3:::stack-output-bucket',
              },
            },
            {
              urn: 'urn:pulumi:dev::app::pulumi:providers:aws::default_6_0_0',
              type: 'pulumi:providers:aws',
              id: 'provider-id',
            },
            {
              urn: 'urn:pulumi:dev::app::aws:s3/bucket:Bucket::data',
              type: 'aws:s3/bucket:Bucket',
              id: 'data-bucket',
              outputs: {
                arn: 'arn:aws:s3:::data-bucket',
                bucket: 'data-bucket',
              },
            },
          ],
        },
      })
    );

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: 'aws:s3/bucket:Bucket',
      name: 'data',
      operation: 'applied',
      candidateResourceIds: ['arn:aws:s3:::data-bucket', 'data-bucket'],
    });
  });
});

describe('correlateExistingIssues', () => {
  const parsedResources = [
    {
      id: 'aws_s3_bucket.iac',
      type: 'aws_s3_bucket',
      name: 'iac',
      operation: 'update',
      candidateResourceIds: ['arn:aws:s3:::iac-bucket', 'my-old-bucket'],
    },
    {
      id: 'aws_iam_role.admin',
      type: 'aws_iam_role',
      name: 'admin',
      operation: 'update',
      candidateResourceIds: ['arn:aws:iam::123456789012:role/admin-role'],
    },
  ];

  it('returns only resources with matched issues by default', async () => {
    const mockOrgOpenSearchQuery = mock(() =>
      Promise.resolve({
        Issues: [{ ID: 'issue-1', ResourceID: 'arn:aws:s3:::iac-bucket' }],
      })
    );
    const apiClient = { orgOpenSearchQuery: mockOrgOpenSearchQuery } as unknown as ApiClient;

    const result = await correlateExistingIssues({
      resources: parsedResources,
      apiClient,
      cloudId: 'cloud-123',
      sourceName: 'Terraform',
      toTerraformResource: (resource, matchedResourceId) => ({
        ID: resource.id,
        Type: resource.type,
        Name: resource.name,
        Asset: {
          CloudID: 'cloud-123',
          ResourceID: matchedResourceId ?? resource.candidateResourceIds[0],
        },
        Issues: [],
      }),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.ID).toBe('aws_s3_bucket.iac');
    expect(result[0]?.Issues).toEqual([{ ID: 'issue-1', CloudID: 'cloud-123' }]);
    expect(result[0]?.Asset?.ResourceID).toBe('arn:aws:s3:::iac-bucket');
  });

  it('builds filter matching the verified backend query (numeric Type, CloudID terms array, no Status)', async () => {
    const mockOrgOpenSearchQuery = mock(() => Promise.resolve({ Issues: [] }));
    const apiClient = { orgOpenSearchQuery: mockOrgOpenSearchQuery } as unknown as ApiClient;

    await correlateExistingIssues({
      resources: parsedResources,
      apiClient,
      cloudId: 'cloud-123',
      sourceName: 'Terraform',
      toTerraformResource: resource => ({
        ID: resource.id,
        Type: resource.type,
        Name: resource.name,
        Asset: { CloudID: 'cloud-123', ResourceID: resource.candidateResourceIds[0] },
        Issues: [],
      }),
    });

    const calls = mockOrgOpenSearchQuery.mock.calls as unknown as Array<[{ FilterQuery: string }]>;
    const request = calls[0]?.[0];
    expect(request).toBeDefined();
    const parsed = JSON.parse(request!.FilterQuery) as {
      bool: { should: Array<{ bool: { filter: Array<Record<string, Record<string, unknown>>> } }> };
    };
    const filter = parsed.bool.should[0]?.bool.filter ?? [];
    const typeClause = filter.find(clause => clause.term?.['issue.Type'] !== undefined);
    const cloudClause = filter.find(clause => clause.terms?.['issue.CloudID'] !== undefined);
    const statusClause = filter.find(clause => clause.term?.['issue.Status'] !== undefined);

    expect(typeClause?.term?.['issue.Type']).toBe(2);
    expect(cloudClause?.terms?.['issue.CloudID']).toEqual(['cloud-123']);
    expect(statusClause).toBeUndefined();
  });
});
