import * as core from '@actions/core';
import * as github from '@actions/github';

import { readFile } from 'node:fs/promises';
import {
  createApiClient,
  TerraformFileType,
  UploadTerraformFileRequest,
  ScanTerraformRequest,
  JobStatusNotification,
  ScanTerraformResult,
  TerraformResource,
  getCallerInfo,
} from '@averlon/shared';
import { getInputSafe, parseBoolean, parseGitHubRepository } from '@averlon/github-actions-utils';
import { GithubIssuesService } from './github-issues';

/**
 * Maximum backoff multiplier to prevent excessive delays
 * Limits exponential growth to reasonable intervals
 */
const MAX_BACKOFF_MULTIPLIER = 5;

/**
 * Exponential backoff factor for polling retries (after initial attempts)
 */
const BACKOFF_FACTOR = 1.5;

/**
 * Initial backoff multipliers for first 3 attempts (gentler increases)
 * After attempt 3, switches to exponential backoff with BACKOFF_FACTOR
 */
const INITIAL_BACKOFF_MULTIPLIERS = [1.05, 1.1, 1.15];

/**
 * Custom error class for scan status failures (Failed, Cancelled)
 * These should be immediately re-thrown without retry
 */
class ScanStatusError extends Error {
  constructor(
    message: string,
    public readonly status: string,
    public readonly jobId: string
  ) {
    super(message);
    this.name = 'ScanStatusError';
  }
}

/**
 * Custom error class for scan timeout failures
 * These should be immediately re-thrown without retry
 */
class ScanTimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutSeconds: number,
    public readonly jobId: string
  ) {
    super(message);
    this.name = 'ScanTimeoutError';
  }
}

export interface ActionInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  commit: string;
  planPath: string;
  scanPollInterval: number;
  scanTimeout: number;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  autoAssignCopilot: boolean;
  resourceTypeFilter?: string[];
}

/**
 * Collect and validate all action inputs
 *
 * @returns Validated action inputs
 * @throws Error if validation fails
 */
async function _getInputs(): Promise<ActionInputs> {
  core.info('Collecting and validating action inputs...');

  // Get optional inputs with defaults
  const scanPollIntervalStr = getInputSafe('scan-poll-interval', false) || '30'; // Default: 30 seconds
  const scanTimeoutStr = getInputSafe('scan-timeout', false) || '1800'; // Default: 30 minutes

  // Parse and validate numeric inputs
  const scanPollInterval = parseInt(scanPollIntervalStr, 10);
  const scanTimeout = parseInt(scanTimeoutStr, 10);

  // Validate scan poll interval (must be positive integer)
  if (isNaN(scanPollInterval) || scanPollInterval <= 0) {
    throw new Error(
      `Invalid scan-poll-interval: "${scanPollIntervalStr}". Must be a positive integer (seconds).`
    );
  }
  core.debug(`Scan poll interval: ${scanPollInterval}s`);

  // Validate scan timeout (must be positive integer)
  if (isNaN(scanTimeout) || scanTimeout <= 0) {
    throw new Error(
      `Invalid scan-timeout: "${scanTimeoutStr}". Must be a positive integer (seconds).`
    );
  }
  core.debug(`Scan timeout: ${scanTimeout}s`);

  // Validate polling configuration relationships
  // Timeout must be longer than poll interval, otherwise we can't complete even one poll
  if (scanTimeout < scanPollInterval) {
    throw new Error(
      `scan-timeout (${scanTimeout}s) must be greater than scan-poll-interval (${scanPollInterval}s)`
    );
  }

  const explicitGithubToken = getInputSafe('github-token', false);
  const fallbackGithubToken = process.env['GITHUB_TOKEN'] || '';
  const githubToken = explicitGithubToken || fallbackGithubToken;
  const autoAssignCopilotStr = getInputSafe('auto-assign-copilot', false) || 'false';
  const autoAssignCopilot = parseBoolean(autoAssignCopilotStr);
  // Parse resource type
  const resourceTypeFilterRaw = getInputSafe('resource-type-filter', false);
  const resourceTypeFilter = resourceTypeFilterRaw
    ? resourceTypeFilterRaw
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    : undefined;

  const { owner: githubOwner, repo: githubRepo } = parseGitHubRepository();

  if (githubToken) {
    core.setSecret(githubToken);
  }

  return {
    apiKey: getInputSafe('api-key', true),
    apiSecret: getInputSafe('api-secret', true),
    baseUrl: getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/',
    commit: getInputSafe('commit', true),
    scanPollInterval,
    scanTimeout,
    planPath: getInputSafe('plan-path', true),
    githubToken,
    githubOwner,
    githubRepo,
    autoAssignCopilot,
    resourceTypeFilter,
  };
}

/**
 * Read a file and encode its contents as base64
 *
 * @param filePath - Path to the file to read
 * @returns Base64-encoded file contents
 * @throws Error if file cannot be read
 */
async function _readFileAsBase64(filePath: string): Promise<string> {
  try {
    core.info(`Reading file: ${filePath}`);
    const fileBuffer = await readFile(filePath);
    const base64Data = fileBuffer.toString('base64');
    core.debug(`Successfully read ${fileBuffer.length} bytes from ${filePath}`);
    return base64Data;
  } catch (error) {
    // Handle file read errors (missing file, permission denied, etc.)
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`File read error for ${filePath}: ${errorMessage}`);
    throw new Error(`Failed to read file ${filePath}: ${errorMessage}`);
  }
}

/**
 * Upload Terraform plan file to the API
 *
 * @param inputs - Action inputs containing file paths
 * @param apiClient - The API client instance
 * @throws Error if any upload fails
 */
async function _uploadTerraformPlanFile(
  inputs: ActionInputs,
  apiClient: ReturnType<typeof createApiClient>
): Promise<void> {
  // Define the files to upload with their metadata
  // We need both base and head versions of plan and graph files for comparison
  const filesToUpload = [
    {
      path: inputs.planPath,
      type: TerraformFileType.Plan,
      commitHash: inputs.commit,
      name: 'Base Plan',
    },
  ];

  core.info(`Starting parallel file uploads (${filesToUpload.length} files)...`);

  // Upload all files in parallel for better performance
  // This is safe because each upload is independent
  const uploadPromises = filesToUpload.map(async file => {
    try {
      core.info(`Uploading ${file.name}: ${file.path}`);

      // Read file and encode as base64 for API transmission
      const fileData = await _readFileAsBase64(file.path);

      // Create upload request with file metadata
      const uploadRequest: UploadTerraformFileRequest = {
        FileData: fileData,
        FileType: file.type, // 'Plan' or 'Graph'
        RepoName: `${inputs.githubOwner}/${inputs.githubRepo}`,
        Commit: file.commitHash, // Associates file with specific commit
      };

      // Upload the file to the API
      core.debug(`Calling uploadTerraformFile API for ${file.name}...`);
      const result = await apiClient.uploadTerraformFile(uploadRequest);
      core.info(`✓ Successfully uploaded ${file.name}`);

      core.debug(`Upload result for ${file.name}: ${JSON.stringify(result, null, 2)}`);

      return { file: file.name, success: true, result };
    } catch (error) {
      // Capture upload errors but don't fail immediately
      // Let all uploads attempt to complete before failing
      const errorMessage = error instanceof Error ? error.message : String(error);
      core.error(`✗ Failed to upload ${file.name}: ${errorMessage}`);
      return { file: file.name, success: false, error: errorMessage };
    }
  });

  // Wait for all uploads to complete (parallel execution)
  core.debug('Waiting for all upload promises to resolve...');
  const results = await Promise.all(uploadPromises);

  // Check results and report status
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  core.info(`File upload summary: ${successful.length} successful, ${failed.length} failed`);

  if (failed.length > 0) {
    // If any uploads failed, fail the action with detailed error message
    const failedFiles = failed.map(f => `${f.file}: ${f.error}`).join(', ');
    throw new Error(`Some file uploads failed: ${failedFiles}`);
  }

  core.info('✓ All files uploaded successfully!');
}

/**
 * Extract issue IDs from scan result Resources
 *
 * @param result - Scan result
 * @returns Array of issue IDs
 */
function _extractIssueIDs(result: ScanTerraformResult): string[] {
  if (result.Resources && Array.isArray(result.Resources)) {
    const issueIDs: string[] = [];
    for (const resource of result.Resources) {
      if (resource.Issues && Array.isArray(resource.Issues)) {
        for (const issue of resource.Issues) {
          if (issue.ID) {
            issueIDs.push(issue.ID);
          }
        }
      }
    }
    return issueIDs;
  }

  return [];
}

/**
 * Run Terraform scan and poll for results with exponential backoff
 *
 * @param inputs - Action inputs containing scan configuration
 * @param apiClient - The API client instance
 * @returns Array of issue IDs
 * @throws ScanStatusError if scan fails or is cancelled
 * @throws ScanTimeoutError if scan exceeds timeout
 * @throws Error for other failures
 */
async function _runScanTerraformMisconfiguration(
  inputs: ActionInputs,
  apiClient: ReturnType<typeof createApiClient>
): Promise<TerraformResource[]> {
  // Start the scan by submitting the comparison job to the API
  core.info('Initiating Terraform scan...');
  const scanRequest: ScanTerraformRequest = {
    RepoName: `${inputs.githubOwner}/${inputs.githubRepo}`,
    Commit: inputs.commit,
    ResourceTypes: inputs.resourceTypeFilter,
  };

  core.debug(`Scan request: ${JSON.stringify(scanRequest, null, 2)}`);
  const scanResponse: JobStatusNotification = await apiClient.startScanTerraform(scanRequest);
  const jobId = scanResponse.JobID;

  core.info(`✓ Terraform scan started with Job ID: ${jobId}`);

  // Poll for results with exponential backoff
  // We poll because the scan is async and can take several minutes
  const startTime = Date.now();
  const timeoutMs = inputs.scanTimeout * 1000; // Convert to milliseconds
  const pollIntervalMs = inputs.scanPollInterval * 1000; // Convert to milliseconds

  core.info(
    `Polling for scan results with exponential backoff (base interval: ${inputs.scanPollInterval}s, timeout: ${inputs.scanTimeout}s)...`
  );

  let attempts = 0;
  let backoffMultiplier = 1; // Starts at 1, uses gentler increases for first 3 attempts

  // Poll until we get a final status (Succeeded, Failed, Cancelled) or timeout
  while (true) {
    attempts++;
    const currentTime = Date.now();
    const elapsedMs = currentTime - startTime;

    // Check timeout before making API call to avoid wasted requests
    if (elapsedMs > timeoutMs) {
      const elapsedSeconds = Math.round(elapsedMs / 1000);
      core.error(`Scan exceeded timeout after ${elapsedSeconds}s (limit: ${inputs.scanTimeout}s)`);
      throw new ScanTimeoutError(
        `Terraform scan timed out after ${inputs.scanTimeout} seconds. Job ID: ${jobId}`,
        inputs.scanTimeout,
        jobId
      );
    }

    core.info(`Polling attempt ${attempts}: Checking scan status for Job ID: ${jobId}...`);

    try {
      const resultRequest: JobStatusNotification = { JobID: jobId };
      const resultResponse: ScanTerraformResult =
        await apiClient.getScanTerraformResult(resultRequest);

      core.debug(`Full scan response: ${JSON.stringify(resultResponse, null, 2)}`);
      core.info(`Scan status: ${resultResponse.Status}`);

      // === Handle Final States ===

      if (resultResponse.Status === 'Succeeded') {
        // SUCCESS: Scan completed successfully
        const elapsedSeconds = Math.round((currentTime - startTime) / 1000);
        core.info(
          `✓ Terraform scan completed successfully after ${elapsedSeconds} seconds and ${attempts} polling attempts`
        );

        const issueIDs = _extractIssueIDs(resultResponse);
        if (issueIDs.length > 0 || resultResponse.Resources) {
          core.info('Scan result received and validated');
          if (resultResponse.Resources) {
            core.debug(`Scan result length: ${resultResponse.Resources.length} resources`);
          }
          core.debug(`Extracted ${issueIDs.length} issue ID(s)`);
          return resultResponse.Resources || [];
        } else {
          // Unusual: scan succeeded but no result data
          core.warning('Scan completed but no result data was returned');
          return [];
        }
      } else if (resultResponse.Status === 'Failed') {
        // FAILURE: Scan encountered an error and will not retry
        // Re-throw as ScanStatusError so it's not retried
        const issueIDs = _extractIssueIDs(resultResponse);
        const errorDetails = issueIDs.length > 0 ? issueIDs.join(',') : 'No error details provided';
        core.error(`Scan failed. Error details: ${errorDetails}`);
        throw new ScanStatusError(
          `Terraform scan failed. Job ID: ${jobId}. Result: ${errorDetails}`,
          resultResponse.Status,
          jobId
        );
      } else if (resultResponse.Status === 'Cancelled') {
        // CANCELLED: Scan was cancelled (likely by user or system)
        // Re-throw as ScanStatusError so it's not retried
        core.error('Scan was cancelled');
        throw new ScanStatusError(
          `Terraform scan was cancelled. Job ID: ${jobId}`,
          resultResponse.Status,
          jobId
        );
      }

      // === Handle In-Progress States ===
      else if (['Unknown', 'Scheduled', 'Running', 'Ready'].includes(resultResponse.Status)) {
        // Scan is still processing, continue polling with backoff
        const currentDelay = Math.round(pollIntervalMs * backoffMultiplier) / 1000;
        core.info(
          `Scan still in progress (${resultResponse.Status}). Waiting ${currentDelay}s before next check (attempt ${attempts})...`
        );
        core.debug(
          `Backoff multiplier: ${backoffMultiplier.toFixed(2)}x, next delay: ${currentDelay}s`
        );
      } else {
        // UNKNOWN STATUS: Unexpected status, but continue polling to be safe
        core.warning(`Unknown scan status: ${resultResponse.Status}. Continuing to poll...`);
      }
    } catch (error) {
      // === Error Handling: Distinguish between retriable and non-retriable errors ===

      if (error instanceof ScanStatusError) {
        // ScanStatusError = Definitive failure (Failed/Cancelled status)
        // Do NOT retry - the scan itself failed, not just the status check
        core.error(`Scan failed with definitive status: ${error.status}`);
        throw error;
      }

      // API/Network errors might be temporary (rate limiting, network glitch, etc.)
      // These could potentially resolve on retry, but we'll throw for now
      const errorMessage = error instanceof Error ? error.message : String(error);
      core.warning(`API error checking scan status (attempt ${attempts}): ${errorMessage}`);
      core.debug(`Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
      throw new Error(`Failed to scan terraform. Last error: ${errorMessage}`);
    }

    // === Exponential Backoff Delay ===

    // Wait before next poll, with delay increasing each iteration
    // This reduces API load and avoids hammering the service
    const currentDelay = pollIntervalMs * backoffMultiplier;
    core.debug(`Sleeping for ${Math.round(currentDelay)}ms before next poll...`);
    await new Promise(resolve => setTimeout(resolve, currentDelay));

    // Increase backoff multiplier for next iteration
    // First 3 attempts: gentle increases (1.05x, 1.10x, 1.15x)
    // After attempt 3: exponential backoff (1.5x factor)
    // Example: 1.05x → 1.10x → 1.15x → 1.725x → 2.588x → 3.882x → 5x (capped)
    const oldMultiplier = backoffMultiplier;

    if (attempts <= INITIAL_BACKOFF_MULTIPLIERS.length) {
      // Use predefined gentle multipliers for first 3 attempts
      backoffMultiplier =
        INITIAL_BACKOFF_MULTIPLIERS[attempts - 1] ||
        INITIAL_BACKOFF_MULTIPLIERS[INITIAL_BACKOFF_MULTIPLIERS.length - 1];
    } else {
      // After first 3 attempts, use exponential backoff
      backoffMultiplier = Math.min(backoffMultiplier * BACKOFF_FACTOR, MAX_BACKOFF_MULTIPLIER);
    }

    core.debug(
      `Backoff multiplier: ${oldMultiplier.toFixed(2)}x → ${backoffMultiplier.toFixed(2)}x (attempt ${attempts})`
    );
  }
}

async function run(): Promise<void> {
  try {
    core.info('Starting Averlon Misconfiguration Remediation Agent for IaC...');
    // === Step 1: Input Collection and Validation ===
    core.debug('Step 1: Collecting and validating inputs');
    const inputs = await _getInputs();

    // === Step 2: API Client Initialization ===
    core.debug('Step 2: Initializing API client');
    core.info('Initializing API client...');
    const apiClient = createApiClient({
      apiKey: inputs.apiKey,
      apiSecret: inputs.apiSecret,
      baseUrl: inputs.baseUrl,
    });

    // In debug mode, test authentication and get caller info for troubleshooting
    if (core.isDebug()) {
      core.debug('Debug mode: Testing authentication');
      const callerInfo = await getCallerInfo(apiClient);
      core.debug(`Caller info: ${JSON.stringify(callerInfo, null, 2)}`);
    }

    // === Step 3: File Upload ===
    core.debug('Step 3: Uploading Terraform plan file');
    await _uploadTerraformPlanFile(inputs, apiClient);

    // === Step 4: Scan Execution ===
    core.debug('Step 4: Running Terraform scan');
    const scanResult = await _runScanTerraformMisconfiguration(inputs, apiClient);

    // === Step 5: Output Results ===
    core.debug('Step 5: Setting action outputs');
    // Sort resources by ID for deterministic output
    const sortedScanResult = [...scanResult].sort((a, b) => {
      const idA = a.ID || '';
      const idB = b.ID || '';
      return idA.localeCompare(idB);
    });
    // GitHub Actions outputs are strings, so convert array to JSON string
    core.setOutput('scan-result', JSON.stringify(sortedScanResult));
    core.info(`Scan results set as action output (${sortedScanResult.length} resources)`);

    // === Step 6: Create GitHub Issues (if token provided) ===
    if (inputs.githubToken && sortedScanResult.length > 0) {
      core.debug('Step 6: Creating GitHub issues');
      core.info('Creating GitHub issues for Terraform resources...');
      try {
        const octokit = github.getOctokit(inputs.githubToken);
        // Type mismatch due to different @actions/github versions in dependencies
        // The octokit instance is compatible at runtime, but TypeScript sees different type definitions
        const issuesService = new GithubIssuesService(
          octokit,
          inputs.githubOwner,
          inputs.githubRepo
        );

        const runId = process.env['GITHUB_RUN_ID'];
        const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(
          /\/+$/,
          ''
        );
        const workflowRunUrl =
          runId && inputs.githubOwner && inputs.githubRepo
            ? `${serverUrl}/${inputs.githubOwner}/${inputs.githubRepo}/actions/runs/${runId}`
            : undefined;
        await issuesService.createBatchedIssues(
          sortedScanResult,
          `${inputs.githubOwner}/${inputs.githubRepo}`,
          inputs.commit,
          inputs.autoAssignCopilot,
          workflowRunUrl
        );
        core.info('✓ GitHub issues created/updated successfully');
      } catch (issueError) {
        // Don't fail the entire action if issue creation fails
        // The scan succeeded, so the results are still available
        const issueErrorMessage =
          issueError instanceof Error ? issueError.message : String(issueError);
        core.warning(`Failed to create GitHub issues: ${issueErrorMessage}`);
        core.info('Scan completed successfully despite issue creation failure');
      }
    } else if (!inputs.githubToken) {
      core.debug('Step 6: Skipping GitHub issues creation (no token provided)');
      core.info('GitHub token not provided. Skipping issue creation.');
    } else {
      core.debug('Step 6: Skipping GitHub issues creation (no resources found)');
    }

    core.info('Action completed successfully');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

// Export the run function and internal functions for testing
export { run, _runScanTerraformMisconfiguration };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
