import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import { _runScanTerraformMisconfiguration } from '../../src/main';
import type { ApiClient, ScanTerraformResult } from '@averlon/shared';
import type { ActionInputs } from '../../src/main';

let mockAuthenticate: any;
let mockStartScanTerraform: any;
let mockGetScanTerraformResult: any;
let mockApiClient: any;
let mockCreateApiClient: any;
let createApiClientSpy: any;

function setupMocks() {
  mockAuthenticate = mock(() => Promise.resolve());
  mockStartScanTerraform = mock(() => Promise.resolve({ JobID: 'test-job-123' }));
  mockGetScanTerraformResult = mock(() =>
    Promise.resolve({
      JobID: 'test-job-123',
      Status: 'Succeeded',
      Resources: [
        {
          ID: 'test-resource-1',
          Issues: [
            {
              ID: 'issue-1',
            },
            {
              ID: 'issue-2',
            },
          ],
        },
      ],
    } as ScanTerraformResult)
  );

  mockApiClient = {
    authenticate: mockAuthenticate,
    getCallerInfo: mock(() =>
      Promise.resolve({ userId: 'test', organizationId: 'test', role: 'admin' })
    ),
    uploadTerraformFile: mock(() => Promise.resolve({ success: true })),
    startScanTerraform: mockStartScanTerraform,
    getScanTerraformResult: mockGetScanTerraformResult,
  } as unknown as ApiClient;

  mockCreateApiClient = mock(() => mockApiClient);
}

// Initialize the first time
setupMocks();

// Mock the createApiClient function
const apiClientModule = await import('@averlon/shared');
createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
  mockCreateApiClient as any
);

describe('_runScanTerraformMisconfiguration function', () => {
  // Create spies once and reuse them
  const infoSpy = spyOn(core, 'info').mockImplementation(() => {});
  const warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
  const errorSpy = spyOn(core, 'error').mockImplementation(() => {});
  const debugSpy = spyOn(core, 'debug').mockImplementation(() => {});

  // Helper function to create test inputs
  const createTestInputs = (overrides: Partial<ActionInputs> = {}): ActionInputs => ({
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://test.example.com',
    commit: 'abc123',
    planPath: './test/plan.json',
    scanPollInterval: 0.2, // Short interval for faster tests
    scanTimeout: 1, // Short timeout for faster tests
    githubToken: '',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    autoAssignCopilot: false,
    ...overrides,
  });

  beforeEach(() => {
    // Clear spy call history
    infoSpy.mockClear();
    warningSpy.mockClear();
    errorSpy.mockClear();
    debugSpy.mockClear();

    // Setup fresh mocks for each test
    setupMocks();

    // Update the createApiClient spy to use the new mock
    createApiClientSpy.mockImplementation(mockCreateApiClient as any);
  });

  afterEach(() => {
    // Clean up is handled globally
  });

  describe('successful scenarios', () => {
    it('should complete e2e success scenario - scan succeeds immediately', async () => {
      const inputs = createTestInputs();

      const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

      expect(result).toEqual([
        {
          ID: 'test-resource-1',
          Issues: [
            {
              ID: 'issue-1',
            },
            {
              ID: 'issue-2',
            },
          ],
        },
      ]);
      expect(mockStartScanTerraform).toHaveBeenCalledWith({
        RepoName: 'test-owner/test-repo',
        Commit: 'abc123',
      });
      expect(mockGetScanTerraformResult).toHaveBeenCalledWith({
        JobID: 'test-job-123',
      });
      expect(infoSpy).toHaveBeenCalledWith('✓ Terraform scan started with Job ID: test-job-123');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('✓ Terraform scan completed successfully')
      );
    });

    it('should handle scan success after multiple polling retries', async () => {
      const inputs = createTestInputs();

      // Mock sequence: Running -> Running -> Running -> Succeeded
      mockGetScanTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          Resources: [
            {
              ID: 'test-resource-1',
              Issues: [
                {
                  ID: 'issue-1',
                },
                {
                  ID: 'issue-2',
                },
                {
                  ID: 'issue-3',
                },
              ],
            },
          ],
        } as ScanTerraformResult);

      // Mock setTimeout to execute immediately for faster tests
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void) => {
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

        expect(result).toEqual([
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'issue-1',
              },
              {
                ID: 'issue-2',
              },
              {
                ID: 'issue-3',
              },
            ],
          },
        ]);
        expect(mockGetScanTerraformResult).toHaveBeenCalledTimes(4);
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan still in progress (Running). Waiting')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should handle different in-progress statuses', async () => {
      const inputs = createTestInputs();

      // Mock sequence: Scheduled -> Ready -> Running -> Unknown -> Succeeded
      mockGetScanTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Scheduled',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Ready',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Unknown',
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          Resources: [
            {
              ID: 'test-resource-1',
              Issues: [
                {
                  ID: 'final-issue',
                },
              ],
            },
          ],
        } as ScanTerraformResult);

      // Mock setTimeout to execute immediately
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void) => {
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

        expect(result).toEqual([
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'final-issue',
              },
            ],
          },
        ]);
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan still in progress (Scheduled). Waiting')
        );
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan still in progress (Ready). Waiting')
        );
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan still in progress (Running). Waiting')
        );
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan still in progress (Unknown). Waiting')
        );
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should handle empty Resources array gracefully', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Succeeded',
        Resources: [],
      } as ScanTerraformResult);

      const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

      expect(result).toEqual([]);
      expect(infoSpy).toHaveBeenCalledWith('Scan result received and validated');
    });

    it('should handle missing Resources property gracefully', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Succeeded',
      } as unknown as ScanTerraformResult);

      const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

      expect(result).toEqual([]);
      expect(warningSpy).toHaveBeenCalledWith('Scan completed but no result data was returned');
    });
  });

  describe('failure scenarios', () => {
    it('should handle startScanTerraform API failure', async () => {
      const inputs = createTestInputs();
      const scanError = new Error('Failed to start scan');

      mockStartScanTerraform.mockRejectedValue(scanError);

      await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
        'Failed to start scan'
      );
      expect(mockStartScanTerraform).toHaveBeenCalledWith({
        RepoName: 'test-owner/test-repo',
        Commit: 'abc123',
      });
      expect(mockGetScanTerraformResult).not.toHaveBeenCalled();
    });

    it('should throw ScanStatusError when scan status is Failed', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockResolvedValue({
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
      } as ScanTerraformResult);

      await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan failed. Job ID: test-job-123. Result: error-detail-1,error-detail-2'
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Scan failed. Error details:'));
    });

    it('should throw ScanStatusError when scan status is Failed with empty Resources array', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Failed',
        Resources: [],
      } as ScanTerraformResult);

      // When Resources is an empty array, no issue IDs are extracted
      // So the error message will be: "Terraform scan failed. Job ID: test-job-123. Result: No error details provided"
      await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan failed. Job ID: test-job-123'
      );
    });

    it('should throw ScanStatusError when scan status is Cancelled', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Cancelled',
        Resources: [],
      } as ScanTerraformResult);

      await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan was cancelled. Job ID: test-job-123'
      );

      expect(errorSpy).toHaveBeenCalledWith('Scan was cancelled');
    });

    it('should throw ScanTimeoutError when timeout is exceeded', async () => {
      const inputs = createTestInputs({ scanTimeout: 0.2, scanPollInterval: 0.1 });

      // Reset mock to always return 'Running' to trigger timeout
      mockGetScanTerraformResult.mockClear();
      mockGetScanTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Running',
        Resources: [],
      } as ScanTerraformResult);

      // Mock Date.now to simulate time passing
      const originalDateNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      // Mock setTimeout to advance time
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void) => {
        currentTime += 300; // Advance time by 300ms (exceeding 200ms timeout)
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
          'Terraform scan timed out after 0.2 seconds. Job ID: test-job-123'
        );

        // Should have made at least 1 polling attempt
        expect(mockGetScanTerraformResult).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Scan exceeded timeout after')
        );
      } finally {
        Date.now = originalDateNow;
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should handle unknown status gracefully and continue polling', async () => {
      const inputs = createTestInputs();

      // Reset mock and set specific sequence
      mockGetScanTerraformResult.mockClear();
      mockGetScanTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'UnknownStatus' as any,
          Resources: [],
        } as ScanTerraformResult)
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          Resources: [
            {
              ID: 'test-resource-1',
              Issues: [
                {
                  ID: 'final-issue',
                },
              ],
            },
          ],
        } as ScanTerraformResult);

      // Mock setTimeout to execute immediately
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void) => {
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        const result = await _runScanTerraformMisconfiguration(inputs, mockApiClient);

        expect(result).toEqual([
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'final-issue',
              },
            ],
          },
        ]);
        expect(warningSpy).toHaveBeenCalledWith(
          'Unknown scan status: UnknownStatus. Continuing to poll...'
        );
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should handle API errors during status polling', async () => {
      const inputs = createTestInputs();

      mockGetScanTerraformResult.mockRejectedValueOnce(new Error('API connection error'));

      await expect(_runScanTerraformMisconfiguration(inputs, mockApiClient)).rejects.toThrow(
        'Failed to scan terraform. Last error: API connection error'
      );

      // Check that warning was logged
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      expect(
        warningCalls.some(
          msg => typeof msg === 'string' && msg.includes('API error checking scan status')
        )
      ).toBe(true);
    });

    it('should handle non-Error objects in API failures', async () => {
      const inputs = createTestInputs();

      // Create fresh mock for this test that fails with string errors
      const testMockScanResult = mock();
      testMockScanResult.mockRejectedValue('String error message');

      // Create a fresh API client mock for this test
      const testApiClient = {
        authenticate: mock(() => Promise.resolve()),
        startScanTerraform: mock(() => Promise.resolve({ JobID: 'test-job-123' })),
        getScanTerraformResult: testMockScanResult,
      } as unknown as ApiClient;

      await expect(_runScanTerraformMisconfiguration(inputs, testApiClient)).rejects.toThrow(
        'Failed to scan terraform. Last error: String error message'
      );

      expect(testMockScanResult).toHaveBeenCalledTimes(1);

      // Check that warning messages contain the expected error
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const stringErrorCalls = warningCalls.filter(
        msg => typeof msg === 'string' && msg.includes('String error message')
      );
      expect(stringErrorCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should re-throw ScanStatusError without wrapping', async () => {
      const inputs = createTestInputs();

      // Import the actual ScanStatusError from main.ts
      // Since it's not exported, we'll test the behavior by having getScanTerraformResult
      // return a Failed status, which will throw ScanStatusError internally
      mockGetScanTerraformResult.mockResolvedValueOnce({
        JobID: 'test-job-123',
        Status: 'Failed',
        Resources: [
          {
            ID: 'test-resource-1',
            Issues: [
              {
                ID: 'test-error',
              },
            ],
          },
        ],
      } as ScanTerraformResult);

      await expect(_runScanTerraformMisconfiguration(inputs as any, mockApiClient)).rejects.toThrow(
        'Terraform scan failed'
      );

      // The error should be logged
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Scan failed. Error details:'));
    });
  });

  describe('exponential backoff behavior', () => {
    it('should apply exponential backoff with initial gentle multipliers', async () => {
      const inputs = createTestInputs();

      // Mock multiple Running statuses to test backoff
      let callCount = 0;
      mockGetScanTerraformResult.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.resolve({
            JobID: 'test-job-123',
            Status: 'Running',
            Resources: [],
          } as ScanTerraformResult);
        } else {
          return Promise.resolve({
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
          } as ScanTerraformResult);
        }
      });

      // Mock setTimeout to track delays
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void, delay: number) => {
        delays.push(delay);
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        await _runScanTerraformMisconfiguration(inputs as any, mockApiClient);

        // Should have delays for the first 3 attempts
        expect(delays.length).toBeGreaterThanOrEqual(3);

        // First delay should use initial multiplier (1.05x)
        // Base interval is 0.2s = 200ms, so first delay should be ~200ms * 1.05 = 210ms
        expect(delays[0]).toBeGreaterThanOrEqual(200);
        expect(delays[0]).toBeLessThanOrEqual(250);

        // Verify backoff multiplier debug messages
        const debugCalls = debugSpy.mock.calls.map(call => call[0]);
        expect(debugCalls.some(msg => msg.includes('Backoff multiplier:'))).toBe(true);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should cap backoff multiplier at MAX_BACKOFF_MULTIPLIER', async () => {
      const inputs = createTestInputs();

      // Mock many Running statuses to test backoff capping
      let callCount = 0;
      mockGetScanTerraformResult.mockImplementation(() => {
        callCount++;
        if (callCount <= 10) {
          return Promise.resolve({
            JobID: 'test-job-123',
            Status: 'Running',
            Resources: [],
          } as ScanTerraformResult);
        } else {
          return Promise.resolve({
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
          } as ScanTerraformResult);
        }
      });

      // Mock setTimeout to track delays
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      const mockSetTimeout = mock((fn: () => void, delay: number) => {
        delays.push(delay);
        fn();
        return {} as any;
      });
      global.setTimeout = mockSetTimeout as any;

      try {
        await _runScanTerraformMisconfiguration(inputs as any, mockApiClient);

        // After many attempts, delays should be capped
        // MAX_BACKOFF_MULTIPLIER = 5, base interval = 200ms, so max delay = 1000ms
        const maxDelay = Math.max(...delays);
        expect(maxDelay).toBeLessThanOrEqual(1100); // Allow some tolerance
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('configuration validation', () => {
    it('should use custom poll interval and timeout', async () => {
      const inputs = createTestInputs({
        scanPollInterval: 5,
        scanTimeout: 30,
      });

      const result = await _runScanTerraformMisconfiguration(inputs as any, mockApiClient);

      expect(result).toEqual([
        {
          ID: 'test-resource-1',
          Issues: [
            {
              ID: 'issue-1',
            },
            {
              ID: 'issue-2',
            },
          ],
        },
      ]);
      expect(infoSpy).toHaveBeenCalledWith(
        'Polling for scan results with exponential backoff (base interval: 5s, timeout: 30s)...'
      );
    });

    it('should properly construct scan request', async () => {
      const inputs = createTestInputs({
        githubRepo: 'custom-repo',
        commit: 'custom-commit-hash',
      });

      await _runScanTerraformMisconfiguration(inputs as any, mockApiClient);

      expect(mockStartScanTerraform).toHaveBeenCalledWith({
        RepoName: 'test-owner/custom-repo',
        Commit: 'custom-commit-hash',
      });
    });

    it('should log scan request details in debug mode', async () => {
      const inputs = createTestInputs();

      await _runScanTerraformMisconfiguration(inputs as any, mockApiClient);

      const debugCalls = debugSpy.mock.calls.map(call => call[0]);
      expect(debugCalls.some(msg => msg.includes('Scan request:'))).toBe(true);
      expect(debugCalls.some(msg => msg.includes('Full scan response:'))).toBe(true);
    });
  });
});
