import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';

const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockError = mock(() => {});
const mockDebug = mock(() => {});
const mockGetInput = mock(() => '');
const mockSetOutput = mock(() => {});
const mockSetFailed = mock(() => {});
const mockIsDebug = mock(() => false);
const mockSetSecret = mock(() => {});

mock.module('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  setSecret: mockSetSecret,
  isDebug: mockIsDebug,
}));

import * as core from '@actions/core';
import { run, gitLikeHash } from '../../src/main';
import { parsePulumiStackJson } from '../../src/pulumi';
import { parseTerraformPlanJson } from '../../src/terraform-local';
import { GithubIssuesService } from '../../src/github-issues';
import type { ApiClient } from '@averlon/shared';

const mockOrgOpenSearchQuery = mock(() =>
  Promise.resolve({
    Issues: [{ ID: 'issue-1', ResourceID: 'arn:aws:s3:::iac-bucket' }],
  })
);
const mockGetCallerInfo = mock(() => Promise.resolve({ userId: 'test-user' }));

const mockApiClient = {
  getCallerInfo: mockGetCallerInfo,
  orgOpenSearchQuery: mockOrgOpenSearchQuery,
} as unknown as ApiClient;

const apiClientModule = await import('@averlon/shared');
let createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
  () => mockApiClient
);

const fsModule = await import('node:fs/promises');
const mockReadFile = mock(() => Promise.resolve(''));
const readFileSpy = spyOn(fsModule, 'readFile').mockImplementation(mockReadFile as any);

describe('gitLikeHash', () => {
  it('returns deterministic SHA-1 hex', () => {
    expect(gitLikeHash('hello world')).toBe('2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
  });
});

describe('local IaC parsers', () => {
  it('extracts Terraform resources with stable IDs from plan JSON, including no-op', () => {
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
        ],
      })
    );

    expect(resources).toEqual([
      {
        id: 'aws_s3_bucket.iac',
        type: 'aws_s3_bucket',
        name: 'iac',
        operation: 'create',
        candidateResourceIds: ['arn:aws:s3:::iac-bucket'],
      },
      {
        id: 'aws_iam_role.same',
        type: 'aws_iam_role',
        name: 'same',
        operation: 'no-op',
        candidateResourceIds: ['arn:aws:iam::123:role/same'],
      },
    ]);
  });

  it('extracts Pulumi stack resources and skips internal types', () => {
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
    expect(resources[0]).toMatchObject({
      type: 'aws:s3/bucket:Bucket',
      name: 'iac-bucket',
      operation: 'applied',
      candidateResourceIds: ['arn:aws:s3:::iac-bucket', 'iac-bucket'],
    });
    expect(resources[1]?.candidateResourceIds).toEqual(['i-abc123']);
  });
});

describe('iac-misconfig-analysis correlation flow', () => {
  let setOutputSpy: ReturnType<typeof spyOn>;
  let setFailedSpy: ReturnType<typeof spyOn>;
  let createBatchedIssuesSpy: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
    process.env.GITHUB_SHA = 'abc123';
    process.env.INPUT_AVERLON_API_KEY = 'test-api-key';
    process.env.INPUT_AVERLON_API_SECRET = 'test-api-secret';
    process.env.INPUT_BASE_URL = 'https://test.example.com';
    process.env.INPUT_PLAN_PATH = './tfplan.json';
    process.env.INPUT_CLOUD_ID = 'cloud-123';
    process.env.INPUT_GITHUB_TOKEN = 'test-github-token';

    setOutputSpy = spyOn(core, 'setOutput').mockImplementation(() => {});
    setFailedSpy = spyOn(core, 'setFailed').mockImplementation(() => {});
    spyOn(core, 'info').mockImplementation(() => {});
    spyOn(core, 'warning').mockImplementation(() => {});
    spyOn(core, 'debug').mockImplementation(() => {});
    spyOn(core, 'error').mockImplementation(() => {});
    spyOn(core, 'isDebug').mockImplementation(() => false);
    createBatchedIssuesSpy = spyOn(
      GithubIssuesService.prototype,
      'createBatchedIssues'
    ).mockResolvedValue();

    createApiClientSpy.mockRestore();
    createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
      () => mockApiClient
    );
    readFileSpy.mockClear();
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(() =>
      Promise.resolve(
        JSON.stringify({
          resource_changes: [
            {
              address: 'aws_s3_bucket.iac',
              type: 'aws_s3_bucket',
              name: 'iac',
              change: { actions: ['create'], after: { arn: 'arn:aws:s3:::iac-bucket' } },
            },
            {
              address: 'aws_iam_role.admin',
              type: 'aws_iam_role',
              name: 'admin',
              change: {
                actions: ['update'],
                after: { arn: 'arn:aws:iam::123456789012:role/admin-role' },
              },
            },
          ],
        })
      )
    );
    mockOrgOpenSearchQuery.mockClear();
    mockOrgOpenSearchQuery.mockImplementation(() =>
      Promise.resolve({
        Issues: [{ ID: 'issue-1', ResourceID: 'arn:aws:s3:::iac-bucket' }],
      })
    );
  });

  afterEach(() => {
    setOutputSpy.mockRestore();
    setFailedSpy.mockRestore();
    createBatchedIssuesSpy.mockRestore();
    process.env = originalEnv;
  });

  it('correlates Terraform resources without backend upload or scan', async () => {
    await run();

    expect(mockOrgOpenSearchQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        QueryID: 2,
        FilterQuery: expect.stringContaining('arn:aws:s3:::iac-bucket'),
      })
    );
    expect(setOutputSpy).toHaveBeenCalledWith('scan-result', expect.stringContaining('issue-1'));
    expect(setOutputSpy).toHaveBeenCalledWith(
      'scan-result',
      expect.not.stringContaining('aws_iam_role.admin')
    );
    expect(createBatchedIssuesSpy).toHaveBeenCalled();
  });

  it('correlates Pulumi stack resources without backend upload or scan', async () => {
    process.env.INPUT_IAC_TYPE = 'pulumi';
    process.env.INPUT_PULUMI_STACK_PATH = './pulumi-stack.json';
    mockReadFile.mockImplementationOnce(() =>
      Promise.resolve(
        JSON.stringify({
          deployment: {
            resources: [
              {
                urn: 'urn:pulumi:dev::app::aws:s3/bucket:Bucket::iac-bucket',
                type: 'aws:s3/bucket:Bucket',
                id: 'iac-bucket',
                outputs: { arn: 'arn:aws:s3:::iac-bucket' },
              },
            ],
          },
        })
      )
    );

    await run();

    expect(mockOrgOpenSearchQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        QueryID: 2,
        FilterQuery: expect.stringContaining('arn:aws:s3:::iac-bucket'),
      })
    );
    expect(setOutputSpy).toHaveBeenCalledWith('scan-result', expect.stringContaining('issue-1'));
  });

  it('applies resource and severity filters to correlation lookup', async () => {
    process.env.INPUT_RESOURCE_TYPE_FILTER = 'aws_s3_bucket';
    process.env.INPUT_FILTERS = 'Critical,High';

    await run();

    const calls = mockOrgOpenSearchQuery.mock.calls as unknown as Array<[{ FilterQuery: string }]>;
    const request = calls[0]?.[0];
    expect(request?.FilterQuery).toContain('arn:aws:s3:::iac-bucket');
    expect(request?.FilterQuery).not.toContain('arn:aws:iam::123456789012:role/admin-role');
    expect(request?.FilterQuery).toContain('16');
    expect(request?.FilterQuery).toContain('8');
  });

  it('fails clearly for missing Pulumi stack path', async () => {
    process.env.INPUT_IAC_TYPE = 'pulumi';
    delete process.env.INPUT_PULUMI_STACK_PATH;

    await run();

    expect(setFailedSpy).toHaveBeenCalledWith(
      expect.stringContaining('pulumi-stack-path is required')
    );
  });

  it('fails clearly for invalid Terraform plan JSON', async () => {
    mockReadFile.mockImplementationOnce(() => Promise.resolve('{bad json'));

    await run();

    expect(setFailedSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Terraform plan JSON')
    );
  });

  it('fails clearly for invalid Pulumi stack JSON', async () => {
    process.env.INPUT_IAC_TYPE = 'pulumi';
    process.env.INPUT_PULUMI_STACK_PATH = './pulumi-stack.json';
    mockReadFile.mockImplementationOnce(() => Promise.resolve('{bad json'));

    await run();

    expect(setFailedSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Pulumi stack export JSON')
    );
  });

  it('accepts deprecated api-key and api-secret inputs', async () => {
    delete process.env.INPUT_AVERLON_API_KEY;
    delete process.env.INPUT_AVERLON_API_SECRET;
    process.env.INPUT_API_KEY = 'deprecated-api-key';
    process.env.INPUT_API_SECRET = 'deprecated-api-secret';

    await run();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(createApiClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'deprecated-api-key',
        apiSecret: 'deprecated-api-secret',
      })
    );
  });
});
