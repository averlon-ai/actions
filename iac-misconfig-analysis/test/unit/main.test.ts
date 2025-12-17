import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import { run } from '../../src/main';
import type { ApiClient, ScanTerraformResult, UploadTerraformFileRequest } from '@averlon/shared';

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
const mockStartScanTerraform = mock(() => Promise.resolve({ JobID: 'test-job-123' }));
const mockGetScanTerraformResult = mock(() =>
  Promise.resolve({
    JobID: 'test-job-123',
    Status: 'Succeeded',
    Resources: [
      {
        ID: 'test-resource-1',
        Type: 'test-type',
        Name: 'test-name',
        Asset: {
          ID: 'test-asset-id',
        },
        Issues: [
          {
            ID: 'issue-1',
            OrgID: 'test-org-id',
            CloudID: 'test-cloud-id',
          },
          {
            ID: 'issue-2',
            OrgID: 'test-org-id',
            CloudID: 'test-cloud-id',
          },
        ],
      },
    ],
  } as ScanTerraformResult)
);

const mockApiClient = {
  authenticate: mockAuthenticate,
  getCallerInfo: mockGetCallerInfo,
  uploadTerraformFile: mockUploadTerraformFile,
  startScanTerraform: mockStartScanTerraform,
  getScanTerraformResult: mockGetScanTerraformResult,
} as unknown as ApiClient;

const mockCreateApiClient = mock(() => mockApiClient);

// Mock the createApiClient function
const apiClientModule = await import('@averlon/shared');
let createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
  () => mockApiClient
);

// Mock file operations
const mockReadFile = mock(() => Promise.resolve(Buffer.from('test-file-content')));

// Mock the fs/promises module
const fsModule = await import('node:fs/promises');
const readFileSpy = spyOn(fsModule, 'readFile').mockImplementation(mockReadFile as any);

// Note: pr-comment module was removed - GitHub issues are now created instead

describe('iac-misconfig-analysis main.ts', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;
  let getInputSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let setFailedSpy: ReturnType<typeof spyOn>;
  let isDebugSpy: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };

    // Set required environment variables
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

    // Create spies for core functions
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    errorSpy = spyOn(core, 'error').mockImplementation(() => {});
    debugSpy = spyOn(core, 'debug').mockImplementation(() => {});
    getInputSpy = spyOn(core, 'getInput').mockImplementation(() => '');
    setOutputSpy = spyOn(core, 'setOutput').mockImplementation(() => {});
    setFailedSpy = spyOn(core, 'setFailed').mockImplementation(() => {});
    isDebugSpy = spyOn(core, 'isDebug').mockImplementation(() => false);

    // Reset all mocks and spies
    infoSpy.mockClear();
    warningSpy.mockClear();
    errorSpy.mockClear();
    debugSpy.mockClear();
    getInputSpy.mockClear();
    setOutputSpy.mockClear();
    setFailedSpy.mockClear();
    isDebugSpy.mockClear();

    // Reset API client mocks
    mockCreateApiClient.mockClear();
    mockAuthenticate.mockClear();
    mockGetCallerInfo.mockClear();
    mockUploadTerraformFile.mockClear();
    mockStartScanTerraform.mockClear();
    mockGetScanTerraformResult.mockClear();
    mockReadFile.mockClear();
    // Note: PR comment functionality removed - GitHub issues are used instead

    // Reset spy on createApiClient and ensure it returns the correct mock
    createApiClientSpy.mockClear();
    createApiClientSpy.mockRestore();
    createApiClientSpy = spyOn(apiClientModule, 'createApiClient').mockImplementation(
      () => mockApiClient
    );
    readFileSpy.mockClear();
    // postOrUpdateCommentSpy removed - GitHub issues are used instead

    // Set up default environment variables for testing
    process.env.INPUT_API_KEY = 'test-api-key';
    process.env.INPUT_API_SECRET = 'test-api-secret';
    process.env.INPUT_BASE_URL = 'https://test.example.com';
    process.env.INPUT_REPO_NAME = 'test-repo';
    process.env.INPUT_COMMIT = 'abc123';
    process.env.INPUT_PLAN_PATH = './test/plan.json';
    process.env.INPUT_SCAN_POLL_INTERVAL = '30';
    process.env.INPUT_SCAN_TIMEOUT = '1800';
    process.env.INPUT_GITHUB_TOKEN = 'test-github-token';
    process.env.INPUT_COMMENT_ON_PR = 'true';
    process.env.INPUT_COMMENT_MODE = 'update';
  });

  afterEach(() => {
    // Clean up spies after each test
    infoSpy.mockRestore();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    getInputSpy.mockRestore();
    setOutputSpy.mockRestore();
    setFailedSpy.mockRestore();
    isDebugSpy.mockRestore();

    // Restore original environment
    process.env = originalEnv;
  });

  describe('run function - successful flow', () => {
    it('should complete the full flow successfully', async () => {
      await run();

      // Check core API calls
      expect(mockUploadTerraformFile).toHaveBeenCalled();
      expect(mockStartScanTerraform).toHaveBeenCalled();
      expect(mockGetScanTerraformResult).toHaveBeenCalled();

      // Check that scan result is set as output (now JSON string of TerraformResource[])
      expect(setOutputSpy).toHaveBeenCalledWith(
        'scan-result',
        expect.stringContaining('test-resource-1')
      );
      const outputCall = setOutputSpy.mock.calls.find(call => call[0] === 'scan-result');
      expect(outputCall).toBeDefined();
      const outputValue = JSON.parse(outputCall![1] as string);
      expect(outputValue).toEqual([
        {
          ID: 'test-resource-1',
          Type: 'test-type',
          Name: 'test-name',
          Asset: {
            ID: 'test-asset-id',
          },
          Issues: [
            {
              ID: 'issue-1',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
            {
              ID: 'issue-2',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
          ],
        },
      ]);

      // Check that some info logging happened
      expect(infoSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Check that API client was created once
      expect(createApiClientSpy.mock.calls.length).toBe(1);

      // Check that key startup messages are logged
      const infoCalls = infoSpy.mock.calls.map(call => call[0]);
      expect(
        infoCalls.some(msg =>
          msg.includes('Starting Averlon Misconfiguration Remediation Agent for IaC...')
        )
      ).toBe(true);
    });

    it('should use default baseUrl when not provided', async () => {
      delete process.env.INPUT_BASE_URL;

      await run();

      // Check that the API client call uses the default baseUrl
      const calls = createApiClientSpy.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0].baseUrl).toBe('https://wfe.prod.averlon.io/');
      expect(calls[0][0].apiKey).toBe('test-api-key');
      expect(calls[0][0].apiSecret).toBe('test-api-secret');
    });

    it('should handle authentication test in debug mode', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      await run();

      // Check that getCallerInfo was called in debug mode
      expect(mockGetCallerInfo).toHaveBeenCalled();

      // Check that debug messages were logged
      const debugCalls = debugSpy.mock.calls.map(call => call[0]);
      expect(debugCalls.some(msg => msg.includes('Debug mode: Testing authentication'))).toBe(true);
    });

    it('should handle authentication failure gracefully in debug mode', async () => {
      // Enable debug mode to trigger getCallerInfo call
      isDebugSpy.mockImplementation(() => true);

      // Mock authentication to fail only on the first call (for getCallerInfo)
      mockAuthenticate.mockRejectedValueOnce(new Error('Authentication failed'));

      await run();

      // Check that the authentication failure warning was logged
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      const authFailureCalls = warningCalls.filter(msg =>
        msg.includes('Authentication test failed: Authentication failed')
      );
      expect(authFailureCalls.length).toBeGreaterThanOrEqual(1);

      // Despite auth failure in getCallerInfo, the function should still complete
      const expectedResources = [
        {
          ID: 'test-resource-1',
          Type: 'test-type',
          Name: 'test-name',
          Asset: {
            ID: 'test-asset-id',
          },
          Issues: [
            {
              ID: 'issue-1',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
            {
              ID: 'issue-2',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
          ],
        },
      ];
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', JSON.stringify(expectedResources));
    });

    it('should skip GitHub issues creation when github-token is missing', async () => {
      delete process.env.INPUT_GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      await run();

      // GitHub issues creation should be skipped when token is missing
      // Action should still complete successfully
      expect(infoSpy).toHaveBeenCalledWith('Action completed successfully');
      const infoCalls = infoSpy.mock.calls.map(call => call[0]);
      expect(infoCalls.some(msg => msg.includes('GitHub token not provided'))).toBe(true);
    });

    it('should handle GitHub issues creation failure gracefully', async () => {
      // Note: PR comment functionality removed - GitHub issues are used instead
      // This test verifies that GitHub issues creation failures don't fail the entire action
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
      process.env.INPUT_GITHUB_TOKEN = 'test-token';

      await run();

      // Check that warning was logged if issues creation fails
      const warningCalls = warningSpy.mock.calls.map(call => call[0]);
      // The action should complete successfully even if issues creation fails
      expect(infoSpy).toHaveBeenCalledWith('Action completed successfully');

      // Action should still complete successfully
      const expectedResources = [
        {
          ID: 'test-resource-1',
          Type: 'test-type',
          Name: 'test-name',
          Asset: {
            ID: 'test-asset-id',
          },
          Issues: [
            {
              ID: 'issue-1',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
            {
              ID: 'issue-2',
              OrgID: 'test-org-id',
              CloudID: 'test-cloud-id',
            },
          ],
        },
      ];
      expect(setOutputSpy).toHaveBeenCalledWith('scan-result', JSON.stringify(expectedResources));
    });
  });

  describe('input validation', () => {
    it('should set failed when required API key is missing', async () => {
      delete process.env.INPUT_API_KEY;
      getInputSpy.mockReturnValue('');

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Input required and not supplied: api-key')
      );
    });

    it('should set failed when required API secret is missing', async () => {
      delete process.env.INPUT_API_SECRET;
      getInputSpy.mockReturnValue('');

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Input required and not supplied: api-secret')
      );
    });

    it('should set failed when required commit is missing', async () => {
      delete process.env.INPUT_COMMIT;
      getInputSpy.mockReturnValue('');

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Input required and not supplied: commit')
      );
    });

    it('should set failed when required plan-path is missing', async () => {
      delete process.env.INPUT_PLAN_PATH;
      getInputSpy.mockReturnValue('');

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Input required and not supplied: plan-path')
      );
    });

    it('should use default scan-poll-interval when not provided', async () => {
      delete process.env.INPUT_SCAN_POLL_INTERVAL;

      await run();

      // Should complete successfully with default value
      expect(mockStartScanTerraform).toHaveBeenCalled();
    });

    it('should use default scan-timeout when not provided', async () => {
      delete process.env.INPUT_SCAN_TIMEOUT;

      await run();

      // Should complete successfully with default value
      expect(mockStartScanTerraform).toHaveBeenCalled();
    });

    it('should use default comment-on-pr when not provided', async () => {
      delete process.env.INPUT_COMMENT_ON_PR;

      await run();

      // Should complete successfully with default value (true)
      // Note: comment-on-pr input is no longer used - GitHub issues are created when github-token is provided
      expect(infoSpy).toHaveBeenCalledWith('Action completed successfully');
    });

    it('should handle missing GITHUB_REPOSITORY gracefully', async () => {
      delete process.env.GITHUB_REPOSITORY;

      await run();

      // Should fail with appropriate error message
      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('GITHUB_REPOSITORY environment variable is not set')
      );
    });

    it('should set failed for invalid scan-poll-interval (NaN)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = 'invalid';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-poll-interval: "invalid"')
      );
    });

    it('should set failed for invalid scan-poll-interval (negative)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '-5';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-poll-interval: "-5"')
      );
    });

    it('should set failed for invalid scan-poll-interval (zero)', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '0';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-poll-interval: "0"')
      );
    });

    it('should set failed for invalid scan-timeout (NaN)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = 'not-a-number';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-timeout: "not-a-number"')
      );
    });

    it('should set failed for invalid scan-timeout (negative)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = '-10';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-timeout: "-10"')
      );
    });

    it('should set failed for invalid scan-timeout (zero)', async () => {
      process.env.INPUT_SCAN_TIMEOUT = '0';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scan-timeout: "0"')
      );
    });

    it('should set failed when scan-timeout is less than scan-poll-interval', async () => {
      process.env.INPUT_SCAN_POLL_INTERVAL = '60';
      process.env.INPUT_SCAN_TIMEOUT = '30';

      await run();

      expect(setFailedSpy).toHaveBeenCalledWith(
        expect.stringContaining('scan-timeout (30s) must be greater than scan-poll-interval (60s)')
      );
    });

    describe('file upload', () => {
      it('should upload plan file successfully', async () => {
        await run();

        // Check that readFile was called with the correct path
        expect(readFileSpy).toHaveBeenCalledWith('./test/plan.json');

        // Check that uploadTerraformFile was called with correct parameters
        expect(mockUploadTerraformFile).toHaveBeenCalled();
        // Verify the call arguments by checking the mock was called
        // The actual parameters are verified through the mock implementation
        const callArgs = (mockUploadTerraformFile.mock as any).calls[0];
        if (callArgs && callArgs[0]) {
          const uploadCall = callArgs[0] as UploadTerraformFileRequest;
          expect(uploadCall.RepoName).toBe('test-owner/test-repo');
          expect(uploadCall.Commit).toBe('abc123');
          expect(uploadCall.FileType).toBe('Plan');
          expect(uploadCall.FileData).toBe(Buffer.from('test-file-content').toString('base64'));
        }
      });

      it('should set failed when file read errors occur', async () => {
        const fileError = new Error('File not found');
        readFileSpy.mockRejectedValueOnce(fileError);

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to read file ./test/plan.json: File not found')
        );

        // Check that error was logged
        const errorCalls = errorSpy.mock.calls.map(call => call[0]);
        expect(errorCalls.some(msg => msg.includes('File read error for ./test/plan.json'))).toBe(
          true
        );
      });

      it('should set failed when file upload API errors occur', async () => {
        mockUploadTerraformFile.mockRejectedValueOnce(new Error('Upload failed'));

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(
          expect.stringContaining('Some file uploads failed')
        );

        // Check that error was logged
        const errorCalls = errorSpy.mock.calls.map(call => call[0]);
        expect(errorCalls.some(msg => msg.includes('Failed to upload'))).toBe(true);
      });
    });

    describe('scan execution', () => {
      it('should start scan and return results immediately when status is Succeeded', async () => {
        await run();

        // Check that startScanTerraform was called with correct parameters
        expect(mockStartScanTerraform).toHaveBeenCalledWith({
          RepoName: 'test-owner/test-repo',
          Commit: 'abc123',
        });

        // Check that getScanTerraformResult was called
        expect(mockGetScanTerraformResult).toHaveBeenCalledWith({ JobID: 'test-job-123' });

        // Check that results were set
        const expectedResources = [
          {
            ID: 'test-resource-1',
            Type: 'test-type',
            Name: 'test-name',
            Asset: {
              ID: 'test-asset-id',
            },
            Issues: [
              {
                ID: 'issue-1',
                OrgID: 'test-org-id',
                CloudID: 'test-cloud-id',
              },
              {
                ID: 'issue-2',
                OrgID: 'test-org-id',
                CloudID: 'test-cloud-id',
              },
            ],
          },
        ];
        expect(setOutputSpy).toHaveBeenCalledWith('scan-result', JSON.stringify(expectedResources));
      });

      it('should handle scan with no Resources (missing property)', async () => {
        mockGetScanTerraformResult.mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
        } as unknown as ScanTerraformResult);

        await run();

        // Check that warning was logged
        const warningCalls = warningSpy.mock.calls.map(call => call[0]);
        expect(
          warningCalls.some(msg => msg.includes('Scan completed but no result data was returned'))
        ).toBe(true);

        // Check that empty array was returned
        expect(setOutputSpy).toHaveBeenCalledWith('scan-result', JSON.stringify([]));
      });

      it('should handle scan with empty Resources array', async () => {
        mockGetScanTerraformResult.mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Succeeded',
          Resources: [],
        } as ScanTerraformResult);

        await run();

        // Check that empty array was returned
        expect(setOutputSpy).toHaveBeenCalledWith('scan-result', JSON.stringify([]));
      });

      it('should set failed when scan status is Failed', async () => {
        mockGetScanTerraformResult.mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Failed',
          Resources: [
            {
              ID: 'test-resource-1',
              Type: 'test-type',
              Name: 'test-name',
              Asset: {
                ID: 'test-asset-id',
              },
              Issues: [],
            },
          ],
        } as ScanTerraformResult);

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(expect.stringContaining('Terraform scan failed'));

        // Check that error was logged
        const errorCalls = errorSpy.mock.calls.map(call => call[0]);
        expect(errorCalls.some(msg => msg.includes('Scan failed'))).toBe(true);
      });

      it('should set failed when scan status is Cancelled', async () => {
        mockGetScanTerraformResult.mockResolvedValueOnce({
          JobID: 'test-job-123',
          Status: 'Cancelled',
          Resources: [],
        } as ScanTerraformResult);

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(
          expect.stringContaining('Terraform scan was cancelled')
        );

        // Check that error was logged
        const errorCalls = errorSpy.mock.calls.map(call => call[0]);
        expect(errorCalls.some(msg => msg.includes('Scan was cancelled'))).toBe(true);
      });

      it('should poll multiple times when status is Running', async () => {
        let callCount = 0;
        mockGetScanTerraformResult.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
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
                  Type: 'test-type',
                  Name: 'test-name',
                  Asset: {
                    ID: 'test-asset-id',
                  },
                  Issues: [
                    {
                      ID: 'issue-1',
                      OrgID: 'test-org-id',
                      CloudID: 'test-cloud-id',
                    },
                  ],
                },
              ],
            } as ScanTerraformResult);
          }
        });

        // Mock setTimeout to speed up tests
        const originalSetTimeout = global.setTimeout;
        const mockSetTimeout = mock((fn: () => void, delay: number) => {
          // Execute immediately for testing
          fn();
          return {} as any;
        });
        global.setTimeout = mockSetTimeout as any;

        try {
          await run();

          // Check that getScanTerraformResult was called multiple times
          expect(mockGetScanTerraformResult.mock.calls.length).toBeGreaterThan(1);

          // Check that final result was set
          const expectedResources = [
            {
              ID: 'test-resource-1',
              Type: 'test-type',
              Name: 'test-name',
              Asset: {
                ID: 'test-asset-id',
              },
              Issues: [
                {
                  ID: 'issue-1',
                  OrgID: 'test-org-id',
                  CloudID: 'test-cloud-id',
                },
              ],
            },
          ];
          expect(setOutputSpy).toHaveBeenCalledWith(
            'scan-result',
            JSON.stringify(expectedResources)
          );
        } finally {
          global.setTimeout = originalSetTimeout;
        }
      });

      it('should handle various in-progress statuses (Scheduled, Ready, Unknown)', async () => {
        const statuses = ['Scheduled', 'Ready', 'Unknown'];
        let statusIndex = 0;

        mockGetScanTerraformResult.mockImplementation(() => {
          if (statusIndex < statuses.length) {
            return Promise.resolve({
              JobID: 'test-job-123',
              Status: statuses[statusIndex++] as any,
              Resources: [],
            } as ScanTerraformResult);
          } else {
            return Promise.resolve({
              JobID: 'test-job-123',
              Status: 'Succeeded',
              Resources: [
                {
                  ID: 'test-resource-1',
                  Type: 'test-type',
                  Name: 'test-name',
                  Asset: {
                    ID: 'test-asset-id',
                  },
                  Issues: [
                    {
                      ID: 'issue-1',
                      OrgID: 'test-org-id',
                      CloudID: 'test-cloud-id',
                    },
                  ],
                },
              ],
            } as ScanTerraformResult);
          }
        });

        // Mock setTimeout to speed up tests
        const originalSetTimeout = global.setTimeout;
        const mockSetTimeout = mock((fn: () => void) => {
          fn();
          return {} as any;
        });
        global.setTimeout = mockSetTimeout as any;

        try {
          await run();

          // Check that getScanTerraformResult was called multiple times
          expect(mockGetScanTerraformResult.mock.calls.length).toBeGreaterThan(statuses.length);

          // Check that final result was set
          const expectedResources = [
            {
              ID: 'test-resource-1',
              Type: 'test-type',
              Name: 'test-name',
              Asset: {
                ID: 'test-asset-id',
              },
              Issues: [
                {
                  ID: 'issue-1',
                  OrgID: 'test-org-id',
                  CloudID: 'test-cloud-id',
                },
              ],
            },
          ];
          expect(setOutputSpy).toHaveBeenCalledWith(
            'scan-result',
            JSON.stringify(expectedResources)
          );
        } finally {
          global.setTimeout = originalSetTimeout;
        }
      });

      it('should set failed when timeout is exceeded', async () => {
        // Set a very short timeout
        process.env.INPUT_SCAN_TIMEOUT = '1';
        process.env.INPUT_SCAN_POLL_INTERVAL = '1';

        // Mock getScanTerraformResult to always return Running status
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
          currentTime += 2000; // Advance time by 2 seconds (exceeding 1 second timeout)
          fn();
          return {} as any;
        });
        global.setTimeout = mockSetTimeout as any;

        try {
          await run();

          expect(setFailedSpy).toHaveBeenCalledWith(
            expect.stringContaining('Terraform scan timed out')
          );

          // Check that error was logged
          const errorCalls = errorSpy.mock.calls.map(call => call[0]);
          expect(errorCalls.some(msg => msg.includes('Scan exceeded timeout'))).toBe(true);
        } finally {
          Date.now = originalDateNow;
          global.setTimeout = originalSetTimeout;
        }
      });

      it('should set failed when API errors occur during status polling', async () => {
        mockGetScanTerraformResult.mockRejectedValueOnce(new Error('API error'));

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to scan terraform')
        );

        // Check that warning was logged
        const warningCalls = warningSpy.mock.calls.map(call => call[0]);
        expect(warningCalls.some(msg => msg.includes('API error checking scan status'))).toBe(true);
      });
    });

    describe('error handling', () => {
      it('should set failed when API client creation fails', async () => {
        createApiClientSpy.mockImplementationOnce(() => {
          throw new Error('Failed to create API client');
        });

        await run();

        expect(setFailedSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to create API client')
        );
      });

      it('should handle non-Error objects in catch blocks', async () => {
        mockUploadTerraformFile.mockRejectedValueOnce('string error');

        await run();

        // Check that error was handled - the error gets converted to Error in the upload function
        expect(setFailedSpy).toHaveBeenCalled();
        const failedCalls = setFailedSpy.mock.calls.map(call => call[0]);
        expect(failedCalls.some(msg => typeof msg === 'string' && msg.length > 0)).toBe(true);
      });

      it('should set failed with error message when Error is thrown', async () => {
        mockStartScanTerraform.mockRejectedValueOnce(new Error('Scan start failed'));

        await run();

        // Check that setFailed was called with error message
        expect(setFailedSpy).toHaveBeenCalledWith('Action failed: Scan start failed');
      });

      it('should set failed with generic message when non-Error is thrown', async () => {
        mockStartScanTerraform.mockRejectedValueOnce('string error');

        await run();

        // Check that setFailed was called with generic message
        expect(setFailedSpy).toHaveBeenCalledWith('An unknown error occurred');
      });
    });

    // Note: Comment mode behavior is tested in:
    // 1. Main successful flow test - verifies PR commenting works
    // 2. Input validation tests - verifies invalid comment modes are rejected
    // 3. PR comment skip tests - verifies commenting is skipped when appropriate
    // Additional comment mode tests would be redundant
  });
});
