import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import {
  ApiClient,
  type ApiConfig,
  type UserTokenResponse,
  type ScanTerraformRequest,
  type ScanTerraformResult,
  type JobStatusNotification,
  TerraformResource,
} from '@averlon/shared';
import { createTestApiConfig } from '../../../iac-risk-analysis/test/test-utils';

// Mock fetch globally
const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
    statusText: 'OK',
  })
);

global.fetch = mockFetch as any;

describe('api-client.ts - Scan Terraform Methods', () => {
  let mockConfig: ApiConfig;
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockConfig = createTestApiConfig();

    // Create spies for core functions
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});

    // Reset fetch mock
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Clean up spies after each test
    infoSpy.mockRestore();
    warningSpy.mockRestore();

    // Clean up environment variables
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  describe('startScanTerraform', () => {
    let client: ApiClient;

    beforeEach(async () => {
      client = new ApiClient(mockConfig);

      // Mock authentication response
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthResponse),
        status: 200,
        statusText: 'OK',
      } as any);
    });

    it('should start scan successfully', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'test-repo',
        Commit: 'abc123',
      };

      const mockJobResponse: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.startScanTerraform(scanRequest);

      expect(result).toEqual(mockJobResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/pb.Queries/StartScanTerraform',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-access-token',
          }),
          body: JSON.stringify(scanRequest),
        })
      );
    });

    it('should handle different repo names and commits', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'custom-repo-name',
        Commit: 'def456',
      };

      const mockJobResponse: JobStatusNotification = {
        JobID: 'custom-job-456',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.startScanTerraform(scanRequest);

      expect(result).toEqual(mockJobResponse);
      expect(result.JobID).toBe('custom-job-456');

      const fetchCalls = mockFetch.mock.calls as unknown as Array<[string, any]>;
      expect(fetchCalls.length).toBeGreaterThan(0);
      const lastCall = fetchCalls[fetchCalls.length - 1];
      if (lastCall && lastCall[1]) {
        expect(lastCall[1]).toMatchObject({
          body: JSON.stringify(scanRequest),
        });
      }
    });

    it('should handle API request failure', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'test-repo',
        Commit: 'abc123',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Invalid request parameters'),
      } as any);

      await expect(client.startScanTerraform(scanRequest)).rejects.toThrow(
        'API request to /pb.Queries/StartScanTerraform failed: API request failed: 400 Bad Request - Invalid request parameters'
      );
    });

    it('should handle network errors', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'test-repo',
        Commit: 'abc123',
      };

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.startScanTerraform(scanRequest)).rejects.toThrow(
        'API request to /pb.Queries/StartScanTerraform failed: Network error'
      );
    });

    it('should authenticate before making request', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'test-repo',
        Commit: 'abc123',
      };

      const mockJobResponse: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      await client.startScanTerraform(scanRequest);

      // Should have called authenticate (first fetch) and then startScanTerraform (second fetch)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use existing token if valid', async () => {
      const scanRequest: ScanTerraformRequest = {
        RepoName: 'test-repo',
        Commit: 'abc123',
      };

      // First call: authenticate and get token
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      // Second call: start scan
      const mockJobResponse: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      await client.startScanTerraform(scanRequest);

      // Third call: should reuse token (no new auth)
      const mockJobResponse2: JobStatusNotification = {
        JobID: 'test-job-456',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobResponse2),
        status: 200,
        statusText: 'OK',
      } as any);

      await client.startScanTerraform(scanRequest);

      // Should have authenticated once, then made 2 scan requests
      // Total: 1 auth + 2 scan = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('getScanTerraformResult', () => {
    let client: ApiClient;

    // Helper function to mock authentication
    const mockAuth = () => {
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthResponse),
        status: 200,
        statusText: 'OK',
      } as any);
    };

    beforeEach(() => {
      mockFetch.mockReset();
      client = new ApiClient(mockConfig);
    });

    it('should get scan result successfully with Succeeded status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };
      const expectedResources: TerraformResource[] = [
        {
          ID: 'test-resource-1',
          Type: 'test-type',
          Name: 'test-name',
          Asset: {
            ID: 'test-asset-id',
          },
          Issues: [
            {
              ID: 'test-issue-1',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
          ],
        },
      ];

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Succeeded',
        Resources: expectedResources,
      };

      // Set up mocks: first auth, then scan result
      mockAuth();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Succeeded');
      expect(result.Resources).toEqual(expectedResources);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/pb.Queries/GetScanTerraformResult',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-access-token',
          }),
          body: JSON.stringify(jobRequest),
        })
      );
    });

    it('should handle Running status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Running',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Running');
      expect(result.Resources).toEqual([]);
    });

    it('should handle Failed status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Failed',
        Resources: [
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'error-detail-1',
              },
              {
                ID: 'error-detail-2',
              },
            ],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Failed');
      expect(result.Resources).toBeDefined();
      expect(result.Resources?.[0]?.Issues?.length).toBe(2);
    });

    it('should handle Cancelled status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Cancelled',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Cancelled');
    });

    it('should handle Scheduled status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Scheduled',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Scheduled');
    });

    it('should handle Ready status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Ready',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Ready');
    });

    it('should handle Unknown status', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Unknown',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Status).toBe('Unknown');
    });

    it('should handle empty Resources array', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Succeeded',
        Resources: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result).toEqual(mockScanResult);
      expect(result.Resources).toEqual([]);
    });

    it('should handle API request failure', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('Job not found'),
      } as any);

      await expect(client.getScanTerraformResult(jobRequest)).rejects.toThrow(
        'API request to /pb.Queries/GetScanTerraformResult failed: API request failed: 404 Not Found - Job not found'
      );
    });

    it('should handle network errors', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      mockFetch.mockRejectedValueOnce(new Error('Connection timeout'));

      await expect(client.getScanTerraformResult(jobRequest)).rejects.toThrow(
        'API request to /pb.Queries/GetScanTerraformResult failed: Connection timeout'
      );
    });

    it('should handle different job IDs', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'different-job-456',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'different-job-456',
        Status: 'Succeeded',
        Resources: [
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'issue-1',
              },
            ],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      const result = await client.getScanTerraformResult(jobRequest);

      expect(result.JobID).toBe('different-job-456');
      const fetchCalls = mockFetch.mock.calls as unknown as Array<[string, any]>;
      expect(fetchCalls.length).toBeGreaterThan(0);
      const lastCall = fetchCalls[fetchCalls.length - 1];
      if (lastCall && lastCall[1]) {
        expect(lastCall[1]).toMatchObject({
          body: JSON.stringify(jobRequest),
        });
      }
    });

    it('should authenticate before making request', async () => {
      const jobRequest: JobStatusNotification = {
        JobID: 'test-job-123',
      };

      mockAuth();

      const mockScanResult: ScanTerraformResult = {
        JobID: 'test-job-123',
        Status: 'Succeeded',
        Resources: [
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'issue-1',
              },
            ],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScanResult),
        status: 200,
        statusText: 'OK',
      } as any);

      await client.getScanTerraformResult(jobRequest);

      // Should have called authenticate (first fetch) and then getScanTerraformResult (second fetch)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
