import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import { run, _runTerraformScan } from '../../src/main.ts';
import type {
  ApiClient,
  JobStatusNotification,
  AnalyzeTerraformResult,
} from '@averlon/shared/api-client';
import { createTestApiConfig } from '../test-utils';
import { TerraformReachabilityAnalysis } from '@averlon/shared/src/types.ts';

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

// Mock the api-client module
const mockAuthenticate = mock(() => Promise.resolve());
const mockGetCallerInfo = mock(() =>
  Promise.resolve({
    userId: 'test-user-id',
    organizationId: 'test-org-id',
    role: 'admin',
  })
);
const mockUploadTerraformFile = mock(() => Promise.resolve({ success: true }));
const mockStartAnalyzeTerraform = mock(() => Promise.resolve({ JobID: 'test-job-123' }));
const mockGetAnalyzeTerraformResult = mock(() =>
  Promise.resolve({
    JobID: 'test-job-123',
    Status: 'Succeeded',
    ReachabilityAnalysis: {
      TextSummary: 'test-result',
    } as TerraformReachabilityAnalysis,
  })
);

const mockApiClient = {
  authenticate: mockAuthenticate,
  getCallerInfo: mockGetCallerInfo,
  uploadTerraformFile: mockUploadTerraformFile,
  startAnalyzeTerraform: mockStartAnalyzeTerraform,
  getAnalyzeTerraformResult: mockGetAnalyzeTerraformResult,
} as unknown as ApiClient;

const mockCreateApiClient = mock(() => mockApiClient);

// Mock the createApiClient function
const apiClientModule = await import('@averlon/shared/api-client');
let createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
  () => mockApiClient
);

// Mock file operations
const mockReadFile = mock(() => Promise.resolve(Buffer.from('test-file-content')));

// Mock the fs/promises module
const fsModule = await import('node:fs/promises');
const readFileSpy = spyOn(fsModule, 'readFile').mockImplementation(mockReadFile as any);

describe('main.ts', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;
  let getInputSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let setFailedSpy: ReturnType<typeof spyOn>;
  let isDebugSpy: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };

    // Create spies for core functions
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    getInputSpy = spyOn(core, 'getInput').mockImplementation(() => '');
    setOutputSpy = spyOn(core, 'setOutput').mockImplementation(() => {});
    setFailedSpy = spyOn(core, 'setFailed').mockImplementation(() => {});
    isDebugSpy = spyOn(core, 'isDebug').mockImplementation(() => false);

    // Reset all mocks and spies
    infoSpy.mockClear();
    warningSpy.mockClear();
    getInputSpy.mockClear();
    setOutputSpy.mockClear();
    setFailedSpy.mockClear();
    isDebugSpy.mockClear();

    // Reset API client mocks
    mockCreateApiClient.mockClear();
    mockAuthenticate.mockClear();
    mockGetCallerInfo.mockClear();
    mockUploadTerraformFile.mockClear();
    mockStartAnalyzeTerraform.mockClear();
    mockGetAnalyzeTerraformResult.mockClear();
    mockReadFile.mockClear();

    // Reset spy on createApiClient and ensure it returns the correct mock
    createApiClientSpy.mockClear();
    createApiClientSpy.mockRestore();
    createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
      () => mockApiClient
    );
    readFileSpy.mockClear();

    // Set up default environment variables for testing
    process.env.INPUT_API_KEY = 'test-api-key';
    process.env.INPUT_API_SECRET = 'test-api-secret';
    process.env.INPUT_BASE_URL = 'https://test.example.com';
    process.env.INPUT_REPO_NAME = 'test-repo';
    process.env.INPUT_BASE_COMMIT_HASH = 'abc123';
    process.env.INPUT_HEAD_COMMIT_HASH = 'def456';
    process.env.INPUT_BASE_PLAN_PATH = './test/base-plan.json';
    process.env.INPUT_HEAD_PLAN_PATH = './test/head-plan.json';
    process.env.INPUT_BASE_GRAPH_PATH = './test/base-graph.dot';
    process.env.INPUT_HEAD_GRAPH_PATH = './test/head-graph.dot';
    process.env.INPUT_SCAN_POLL_INTERVAL = '30';
    process.env.INPUT_SCAN_TIMEOUT = '1800';
    process.env.INPUT_GITHUB_TOKEN = 'test-github-token';
    process.env.INPUT_COMMENT_ON_PR = 'true';
    // Removed verbose parameter - now using core.isDebug() instead
  });

  afterEach(() => {
    // Clean up spies after each test
    infoSpy.mockRestore();
    warningSpy.mockRestore();
    getInputSpy.mockRestore();
    setOutputSpy.mockRestore();
    setFailedSpy.mockRestore();
    isDebugSpy.mockRestore();

    // Restore original environment
    process.env = originalEnv;
  });

  describe('run function', () => {
    it('should complete the full flow successfully', async () => {
      await run();

      // Check core API calls
      // Note: mockAuthenticate is called internally by the real API client but not by our simple mocks
      // mockGetCallerInfo is only called in debug mode now
      expect(mockUploadTerraformFile).toHaveBeenCalled();
      expect(mockStartAnalyzeTerraform).toHaveBeenCalled();
      expect(mockGetAnalyzeTerraformResult).toHaveBeenCalled();

      // Check that scan result is set as output
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', '{"TextSummary":"test-result"}');

      // Check that some info logging happened
      expect(infoSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Check that API client was created once
      expect(createApiClientSpy.mock.calls.length).toBe(1);

      // Check that key startup messages are logged
      const infoCalls = infoSpy.mock.calls.map(call => call[0]);
      expect(
        infoCalls.some(msg => msg.includes('Starting Averlon Infrastructure Risk PreCog Agent...'))
      ).toBe(true);
      // Note: Authentication and caller info messages are only logged in debug mode now
    });

    it('should use default baseUrl when not provided', async () => {
      delete process.env.INPUT_BASE_URL;

      await run();

      // Check that the API client call uses the default baseUrl
      const calls = createApiClientSpy.mock.calls;
      expect(calls.length).toBe(1);

      // Check that the call uses the default baseUrl
      expect(calls[0][0].baseUrl).toBe('https://wfe.prod.averlon.io/');
      expect(calls[0][0].apiKey).toBe('test-api-key');
      expect(calls[0][0].apiSecret).toBe('test-api-secret');
    });

    it('should handle authentication failure gracefully', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      // Mock authentication to fail only on the first call (for getCallerInfo)
      // but allow subsequent calls (for upload/scan) to succeed
      mockAuthenticate.mockRejectedValueOnce(new Error('Authentication failed'));

      await run();

      // Check that the authentication failure warning was logged
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const authFailureCalls = warningCalls.filter(msg =>
        msg.includes('Authentication test failed: Authentication failed')
      );
      expect(authFailureCalls.length).toBeGreaterThanOrEqual(1);

      // Verify that authenticate was called (which would have failed)
      expect(mockAuthenticate).toHaveBeenCalled();

      // Despite auth failure in getCallerInfo, the function should still complete
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', '{"TextSummary":"test-result"}');
    });

    it('should handle getCallerInfo failure gracefully', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      // Mock getCallerInfo to fail only on the first call (for getCallerInfo)
      mockGetCallerInfo.mockRejectedValueOnce(new Error('Failed to get caller info'));

      await run();

      // Check that the caller info failure warning was logged
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const callerInfoFailureCalls = warningCalls.filter(msg =>
        msg.includes('Authentication test failed: Failed to get caller info')
      );
      expect(callerInfoFailureCalls.length).toBeGreaterThanOrEqual(1);

      // Verify that getCallerInfo was called (which would have failed)
      expect(mockGetCallerInfo).toHaveBeenCalled();

      // Despite caller info failure, the function should still complete
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', '{"TextSummary":"test-result"}');
    });

    it('should complete without errors', async () => {
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('input handling', () => {
    it('should throw error when required API key is missing', async () => {
      delete process.env.INPUT_API_KEY;
      getInputSpy.mockReturnValue('');

      await expect(run()).rejects.toThrow('Input required and not supplied: api-key');
    });

    it('should throw error when required API secret is missing', async () => {
      delete process.env.INPUT_API_SECRET;
      getInputSpy.mockReturnValue('');

      await expect(run()).rejects.toThrow('Input required and not supplied: api-secret');
    });

    it('should prefer GitHub Actions core.getInput over environment variables', async () => {
      getInputSpy.mockImplementation((name: string) => {
        switch (name) {
          case 'api-key':
            return 'github-api-key';
          case 'api-secret':
            return 'github-api-secret';
          case 'base-url':
            return 'https://github.example.com';
          default:
            return '';
        }
      });

      await run();

      // Check that core.getInput values are used
      const calls = createApiClientSpy.mock.calls;
      expect(calls.length).toBe(1);

      // Check that the call uses core.getInput values
      expect(calls[0][0].baseUrl).toBe('https://github.example.com');
      expect(calls[0][0].apiKey).toBe('github-api-key');
      expect(calls[0][0].apiSecret).toBe('github-api-secret');
    });

    it('should fallback to environment variables when core.getInput fails', async () => {
      getInputSpy.mockImplementation(() => {
        throw new Error('Not in GitHub Actions environment');
      });

      await run();

      // Check that environment variables are used when core.getInput fails
      const calls = createApiClientSpy.mock.calls;
      expect(calls.length).toBe(1);

      // Check that the call uses environment variable values
      expect(calls[0][0].baseUrl).toBe('https://test.example.com');
      expect(calls[0][0].apiKey).toBe('test-api-key');
      expect(calls[0][0].apiSecret).toBe('test-api-secret');
    });

    it('should handle environment variable name transformation correctly', async () => {
      getInputSpy.mockReturnValue('');

      // Test hyphenated input names are converted to uppercase with underscores
      process.env.INPUT_API_KEY = 'env-api-key';
      process.env.INPUT_API_SECRET = 'env-api-secret';
      process.env.INPUT_BASE_URL = 'https://env.example.com';

      await run();

      // Check that environment variable transformations work correctly
      const calls = createApiClientSpy.mock.calls;
      expect(calls.length).toBe(1);

      // Check that the call uses the transformed environment variable values
      expect(calls[0][0].baseUrl).toBe('https://env.example.com');
      expect(calls[0][0].apiKey).toBe('env-api-key');
      expect(calls[0][0].apiSecret).toBe('env-api-secret');
    });

    it('should throw error for invalid scan-poll-interval (NaN)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = 'invalid';

      await expect(run()).rejects.toThrow(
        'Invalid scan-poll-interval: "invalid". Must be a positive integer (seconds).'
      );
    });

    it('should throw error for invalid scan-poll-interval (negative)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '-5';

      await expect(run()).rejects.toThrow(
        'Invalid scan-poll-interval: "-5". Must be a positive integer (seconds).'
      );
    });

    it('should throw error for invalid scan-poll-interval (zero)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '0';

      await expect(run()).rejects.toThrow(
        'Invalid scan-poll-interval: "0". Must be a positive integer (seconds).'
      );
    });

    it('should throw error for invalid scan-timeout (NaN)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = 'not-a-number';

      await expect(run()).rejects.toThrow(
        'Invalid scan-timeout: "not-a-number". Must be a positive integer (seconds).'
      );
    });

    it('should throw error for invalid scan-timeout (negative)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = '-10';

      await expect(run()).rejects.toThrow(
        'Invalid scan-timeout: "-10". Must be a positive integer (seconds).'
      );
    });

    it('should throw error for invalid scan-timeout (zero)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = '0';

      await expect(run()).rejects.toThrow(
        'Invalid scan-timeout: "0". Must be a positive integer (seconds).'
      );
    });

    it('should throw error when scan-timeout is less than scan-poll-interval', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '60';
      process.env.INPUT_SCAN_TIMEOUT = '30';

      await expect(run()).rejects.toThrow(
        'scan-timeout (30s) must be greater than scan-poll-interval (60s)'
      );
    });
  });

  describe('error scenarios', () => {
    it('should handle API client creation failure', async () => {
      createApiClientSpy.mockImplementationOnce(() => {
        throw new Error('Failed to create API client');
      });

      await expect(run()).rejects.toThrow('Failed to create API client');
    });

    it('should handle non-Error objects in catch blocks', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      // Mock authentication to fail with a string error only on the first call
      mockAuthenticate.mockRejectedValueOnce('string error');

      await run();

      // Check that string errors are handled properly
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const stringErrorCalls = warningCalls.filter(msg =>
        msg.includes('Authentication test failed: string error')
      );
      expect(stringErrorCalls.length).toBeGreaterThanOrEqual(1);

      // Despite string error in getCallerInfo, the function should still complete
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', '{"TextSummary":"test-result"}');
    });

    it('should handle undefined errors in catch blocks', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      // Mock authentication to fail with undefined only on the first call
      mockAuthenticate.mockRejectedValueOnce(undefined);

      await run();

      // Check that undefined errors are handled properly
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const undefinedErrorCalls = warningCalls.filter(msg =>
        msg.includes('Authentication test failed: undefined')
      );
      expect(undefinedErrorCalls.length).toBeGreaterThanOrEqual(1);

      // Despite undefined error in getCallerInfo, the function should still complete
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', '{"TextSummary":"test-result"}');
    });
  });
});
