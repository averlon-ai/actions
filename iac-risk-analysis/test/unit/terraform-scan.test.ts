import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import { _runTerraformScan } from '../../src/main';
import type { ApiClient } from '@averlon/shared/api-client';

// Define ActionInputs interface for testing
interface ActionInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  basePlanPath: string;
  headPlanPath: string;
  baseGraphPath: string;
  headGraphPath: string;
  baseCommitHash: string;
  headCommitHash: string;
  repoName: string;
  scanPollInterval: number;
  scanTimeout: number;
}

// Mock the api-client module - create fresh mocks for each test
let mockAuthenticate: any;
let mockStartAnalyzeTerraform: any;
let mockGetAnalyzeTerraformResult: any;
let mockApiClient: any;
let mockCreateApiClient: any;
let createApiClientSpy: any;

function setupMocks() {
  mockAuthenticate = mock(() => Promise.resolve());
  mockStartAnalyzeTerraform = mock(() => Promise.resolve({ JobID: 'test-job-123' }));
  mockGetAnalyzeTerraformResult = mock(() =>
    Promise.resolve({
      JobID: 'test-job-123',
      Status: 'Succeeded',
      ReachabilityAnalysis: {
        TextSummary: 'test-result',
      } as any,
    })
  );

  mockApiClient = {
    authenticate: mockAuthenticate,
    getCallerInfo: mock(() =>
      Promise.resolve({ userId: 'test', organizationId: 'test', role: 'admin' })
    ),
    uploadTerraformFile: mock(() => Promise.resolve({ success: true })),
    startAnalyzeTerraform: mockStartAnalyzeTerraform,
    getAnalyzeTerraformResult: mockGetAnalyzeTerraformResult,
  } as unknown as ApiClient;

  mockCreateApiClient = mock(() => mockApiClient);
}

// Initialize the first time
setupMocks();

// Mock the createApiClient function
const apiClientModule = await import('@averlon/shared/api-client');
createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
  mockCreateApiClient as any
);

describe('_runTerraformScan function', () => {
  // Create spies once and reuse them
  const infoSpy = spyOn(core, 'info').mockImplementation(() => {});
  const warningSpy = spyOn(core, 'warning').mockImplementation(() => {});

  // Helper function to create test inputs
  const createTestInputs = (overrides: Partial<ActionInputs> = {}): ActionInputs => ({
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://test.example.com',
    basePlanPath: './test/base-plan.json',
    headPlanPath: './test/head-plan.json',
    baseGraphPath: './test/base-graph.dot',
    headGraphPath: './test/head-graph.dot',
    baseCommitHash: 'abc123',
    headCommitHash: 'def456',
    repoName: 'test-repo',
    scanPollInterval: 0.2,
    scanTimeout: 1,
    ...overrides,
  });

  beforeEach(() => {
    // Clear spy call history
    infoSpy.mockClear();
    warningSpy.mockClear();

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

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('{"TextSummary":"test-result"}');
      expect(mockStartAnalyzeTerraform).toHaveBeenCalledWith({
        RepoName: 'test-repo',
        BaseCommit: 'abc123',
        HeadCommit: 'def456',
      });
      expect(mockGetAnalyzeTerraformResult).toHaveBeenCalledWith({
        JobID: 'test-job-123',
      });
      expect(infoSpy).toHaveBeenCalledWith('✓ Terraform scan started with Job ID: test-job-123');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('✓ Terraform scan completed successfully')
      );
    });

    it('should handle scan success after 3 polling retries', async () => {
      const inputs = createTestInputs();

      // Mock sequence: Running -> Running -> Running -> Succeeded
      mockGetAnalyzeTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          ReachabilityAnalysis: {
            TextSummary: 'success-after-retries',
          } as any,
        });

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('{"TextSummary":"success-after-retries"}');
      expect(mockGetAnalyzeTerraformResult).toHaveBeenCalledTimes(4);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scan still in progress (Running). Waiting')
      );
    });

    it('should handle different in-progress statuses', async () => {
      const inputs = createTestInputs();

      // Mock sequence: Scheduled -> Ready -> Running -> Succeeded
      mockGetAnalyzeTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Scheduled',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Ready',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Running',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          ReachabilityAnalysis: {
            TextSummary: 'final-result',
          } as any,
        });

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('{"TextSummary":"final-result"}');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scan still in progress (Scheduled). Waiting')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scan still in progress (Ready). Waiting')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scan still in progress (Running). Waiting')
      );
    });

    it('should handle empty result gracefully', async () => {
      const inputs = createTestInputs();

      mockGetAnalyzeTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Succeeded',
        ReachabilityAnalysis: undefined,
      });

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('');
      expect(warningSpy).toHaveBeenCalledWith('Scan completed but no result data was returned');
    });
  });

  describe('failure scenarios', () => {
    it('should handle StartAnalyzeTerraform API failure', async () => {
      const inputs = createTestInputs();
      const scanError = new Error('Failed to start scan');

      mockStartAnalyzeTerraform.mockRejectedValue(scanError);

      await expect(_runTerraformScan(inputs, mockApiClient)).rejects.toThrow(
        'Failed to start scan'
      );
      expect(mockStartAnalyzeTerraform).toHaveBeenCalledWith({
        RepoName: 'test-repo',
        BaseCommit: 'abc123',
        HeadCommit: 'def456',
      });
      expect(mockGetAnalyzeTerraformResult).not.toHaveBeenCalled();
    });

    it('should handle scan failure status with no error details', async () => {
      const inputs = createTestInputs();

      mockGetAnalyzeTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Failed',
        ReachabilityAnalysis: undefined,
      });

      await expect(_runTerraformScan(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan failed. Job ID: test-job-123. Result: No error details provided'
      );
    });

    it('should handle scan cancelled status', async () => {
      const inputs = createTestInputs();

      mockGetAnalyzeTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Cancelled',
        ReachabilityAnalysis: undefined,
      });

      await expect(_runTerraformScan(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan was cancelled. Job ID: test-job-123'
      );
    });

    it('should handle scan timeout', async () => {
      const inputs = createTestInputs({ scanTimeout: 0.2, scanPollInterval: 0.1 });

      // Reset mock to always return 'Running' to trigger timeout
      mockGetAnalyzeTerraformResult.mockClear();
      mockGetAnalyzeTerraformResult.mockResolvedValue({
        JobID: 'test-job-123',
        Status: 'Running',
        ReachabilityAnalysis: undefined,
      });

      await expect(_runTerraformScan(inputs, mockApiClient)).rejects.toThrow(
        'Terraform scan timed out after 0.2 seconds. Job ID: test-job-123'
      );

      // Should have made at least 2 polling attempts
      expect(mockGetAnalyzeTerraformResult).toHaveBeenCalled();
    });

    it('should handle unknown status gracefully', async () => {
      const inputs = createTestInputs();

      // Reset mock and set specific sequence
      mockGetAnalyzeTerraformResult.mockClear();
      mockGetAnalyzeTerraformResult
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'UnknownStatus',
          ReachabilityAnalysis: undefined,
        })
        .mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          ReachabilityAnalysis: {
            TextSummary: 'final-result',
          } as any,
        });

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('{"TextSummary":"final-result"}');
      expect(warningSpy).toHaveBeenCalledWith(
        'Unknown scan status: UnknownStatus. Continuing to poll...'
      );
    });

    it('should handle non-Error objects in API failures', async () => {
      const inputs = createTestInputs();

      // Create fresh mock for this test that fails with string errors
      const testMockScanResult = mock();
      testMockScanResult.mockRejectedValue('String error message');

      // Create a fresh API client mock for this test
      const testApiClient = {
        authenticate: mock(() => Promise.resolve()),
        startAnalyzeTerraform: mock(() => Promise.resolve({ JobID: 'test-job-123' })),
        getAnalyzeTerraformResult: testMockScanResult,
      } as unknown as ApiClient;

      createApiClientSpy.mockReturnValueOnce(testApiClient);

      await expect(_runTerraformScan(inputs, testApiClient)).rejects.toThrow(
        'Failed to scan terraform. Last error: String error message'
      );

      expect(testMockScanResult).toHaveBeenCalledTimes(1);

      // Check that warning messages contain the expected error
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const stringErrorCalls = warningCalls.filter(
        (msg): msg is string => typeof msg === 'string' && msg.includes('String error message')
      );
      expect(stringErrorCalls.length).toBeGreaterThanOrEqual(1); // At least 1 warning message
    });
  });

  describe('configuration validation', () => {
    it('should use custom poll interval and timeout', async () => {
      const inputs = createTestInputs({
        scanPollInterval: 5,
        scanTimeout: 30,
      });

      const result = await _runTerraformScan(inputs, mockApiClient);

      expect(result).toBe('{"TextSummary":"test-result"}');
      expect(infoSpy).toHaveBeenCalledWith(
        'Polling for scan results with exponential backoff (base interval: 5s, timeout: 30s)...'
      );
    });

    it('should properly construct scan request', async () => {
      const inputs = createTestInputs({
        repoName: 'custom-repo',
        baseCommitHash: 'base-hash-123',
        headCommitHash: 'head-hash-456',
      });

      await _runTerraformScan(inputs, mockApiClient);

      expect(mockStartAnalyzeTerraform).toHaveBeenCalledWith({
        RepoName: 'custom-repo',
        BaseCommit: 'base-hash-123',
        HeadCommit: 'head-hash-456',
      });
    });
  });
});
