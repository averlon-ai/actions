import * as core from '@actions/core';
import * as github from '@actions/github';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createApiClient,
  TerraformFileType,
  UploadTerraformFileRequest,
  AnalyzeTerraformRequest,
  JobStatusNotification,
  AnalyzeTerraformResult,
  TerraformResource,
  getCallerInfo,
} from '@averlon/shared';
import { getInputSafe, parseBoolean } from '@averlon/github-actions-utils';
import { postOrUpdateComment, type CommentMode } from './pr-comment';
import { registerPrWithSourceControl } from './github-issue';

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

/** File extensions treated as Terraform config (case-insensitive). */
const TERRAFORM_EXTENSIONS = ['.tf', '.tf.json', '.tfvars', '.tfvars.json'];

function _hasTerraformExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return TERRAFORM_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Get list of file paths changed between base and head refs via GitHub Compare API.
 * Returns empty array on API error or when no diff (e.g. same commit).
 */
async function _getChangedFilesBetweenCommits(
  owner: string,
  repo: string,
  baseRef: string,
  headRef: string,
  token: string
): Promise<string[]> {
  const octokit = github.getOctokit(token);
  const basehead = `${baseRef}...${headRef}`;
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
    });
    const files = data.files ?? [];
    return files.map(f => f.filename).filter(Boolean);
  } catch (err) {
    core.debug(
      `GitHub compare API failed (${baseRef}...${headRef}); not skipping based on file changes. Error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

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
  commentOnPr: boolean;
  githubToken: string;
  commentMode: CommentMode;
  skipWhenNoChanges: boolean;
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
  const commentOnPrStr = getInputSafe('comment-on-pr', false) || 'true'; // Default: enabled
  const commentModeStr = getInputSafe('comment-mode', false) || 'update'; // Default: update existing comment

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

  const commentOnPr = parseBoolean(commentOnPrStr);
  core.debug(`PR commenting ${commentOnPr ? 'enabled' : 'disabled'}`);

  const skipWhenNoChangesStr = getInputSafe('skip-when-no-changes', false) || 'true';
  const skipWhenNoChanges = parseBoolean(skipWhenNoChangesStr);
  core.debug(`Skip when no changes: ${skipWhenNoChanges}`);

  // Validate comment mode against allowed values
  const validCommentModes: CommentMode[] = ['always', 'update', 'on-security-risks'];
  const commentMode = commentModeStr as CommentMode;
  if (!validCommentModes.includes(commentMode)) {
    throw new Error(
      `Invalid comment-mode: "${commentModeStr}". Must be one of: ${validCommentModes.join(', ')}`
    );
  }
  core.debug(`Comment mode: ${commentMode}`);

  const githubToken = getInputSafe('github-token', false);

  // Validate that github-token is provided if comment-on-pr is enabled
  // This prevents runtime errors when trying to post comments
  if (commentOnPr && !githubToken) {
    throw new Error(
      'github-token is required when comment-on-pr is true. Please provide it using: github-token: ${{ secrets.GITHUB_TOKEN }}'
    );
  }

  if (githubToken) {
    core.setSecret(githubToken);
  }

  const apiKey = getInputSafe('averlon-api-key', false) || getInputSafe('api-key', false);
  const apiSecret = getInputSafe('averlon-api-secret', false) || getInputSafe('api-secret', false);

  if (!apiKey) {
    throw new Error(
      'Averlon API key required: provide averlon-api-key (preferred) or api-key (deprecated)'
    );
  }
  if (!apiSecret) {
    throw new Error(
      'Averlon API secret required: provide averlon-api-secret (preferred) or api-secret (deprecated)'
    );
  }

  return {
    apiKey,
    apiSecret,
    baseUrl: getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/',
    basePlanPath: getInputSafe('base-plan-path', true),
    headPlanPath: getInputSafe('head-plan-path', true),
    baseGraphPath: getInputSafe('base-graph-path', true),
    headGraphPath: getInputSafe('head-graph-path', true),
    baseCommitHash: getInputSafe('base-commit-hash', true),
    headCommitHash: getInputSafe('head-commit-hash', true),
    scanPollInterval,
    scanTimeout,
    repoName: getInputSafe('repo-name', true),
    commentOnPr,
    githubToken,
    commentMode,
    skipWhenNoChanges,
  };
}

/**
 * Normalize a value for logical comparison: recursively sort object keys
 * so that the same logical content produces the same string regardless of
 * key order or (when stringified) formatting. Arrays keep element order.
 */
function _normalizeForComparison(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(_normalizeForComparison);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = _normalizeForComparison(obj[key]);
  }
  return sorted;
}

/**
 * Read plan file, parse as JSON, normalize for logical comparison, return SHA-256 of normalized JSON.
 * Returns null if file cannot be read or content is not valid JSON (caller should not skip).
 */
async function _planLogicalHash(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(buffer) as unknown;
    const normalized = _normalizeForComparison(parsed);
    const str = JSON.stringify(normalized);
    return createHash('sha256').update(str, 'utf-8').digest('hex');
  } catch {
    return null;
  }
}

/**
 * Check if base and head Terraform plan files are logically identical.
 * Terraform has no CLI to compare two plan files (only terraform show -json per file),
 * so we compare normalized JSON: sorted keys and consistent stringify so that key order,
 * formatting, or trivial serialization differences do not cause a false "different" result.
 * Used to skip upload and scan when there are no meaningful plan changes.
 *
 * @returns true if both files exist, are valid plan JSON, and are logically equal; false otherwise
 */
async function _arePlanFilesIdentical(
  basePlanPath: string,
  headPlanPath: string
): Promise<boolean> {
  const baseHash = await _planLogicalHash(basePlanPath);
  const headHash = await _planLogicalHash(headPlanPath);
  if (baseHash == null || headHash == null) {
    return false;
  }
  return baseHash === headHash;
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
 * Upload all Terraform files (plans and graphs) to the API in parallel
 *
 * @param inputs - Action inputs containing file paths
 * @param apiClient - The API client instance
 * @throws Error if any upload fails
 */
async function _uploadTerraformFiles(
  inputs: ActionInputs,
  apiClient: ReturnType<typeof createApiClient>
): Promise<void> {
  // Define the files to upload with their metadata
  // We need both base and head versions of plan and graph files for comparison
  const filesToUpload = [
    {
      path: inputs.basePlanPath,
      type: TerraformFileType.Plan,
      commitHash: inputs.baseCommitHash,
      name: 'Base Plan',
    },
    {
      path: inputs.headPlanPath,
      type: TerraformFileType.Plan,
      commitHash: inputs.headCommitHash,
      name: 'Head Plan',
    },
    {
      path: inputs.baseGraphPath,
      type: TerraformFileType.Graph,
      commitHash: inputs.baseCommitHash,
      name: 'Base Graph',
    },
    {
      path: inputs.headGraphPath,
      type: TerraformFileType.Graph,
      commitHash: inputs.headCommitHash,
      name: 'Head Graph',
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
        RepoName: inputs.repoName,
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
 * Run Terraform scan and poll for results with exponential backoff
 *
 * @param inputs - Action inputs containing scan configuration
 * @param apiClient - The API client instance
 * @returns JSON string containing the scan results
 * @throws ScanStatusError if scan fails or is cancelled
 * @throws ScanTimeoutError if scan exceeds timeout
 * @throws Error for other failures
 */
async function _runTerraformScan(
  inputs: ActionInputs,
  apiClient: ReturnType<typeof createApiClient>
): Promise<string> {
  // Start the scan by submitting the comparison job to the API
  core.info('Initiating Terraform scan...');
  const scanRequest: AnalyzeTerraformRequest = {
    RepoName: inputs.repoName,
    BaseCommit: inputs.baseCommitHash, // Old state for comparison
    HeadCommit: inputs.headCommitHash, // New state for comparison
  };

  core.debug(`Scan request: ${JSON.stringify(scanRequest, null, 2)}`);
  const scanResponse: JobStatusNotification = await apiClient.startAnalyzeTerraform(scanRequest);
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
      const resultResponse: AnalyzeTerraformResult =
        await apiClient.getAnalyzeTerraformResult(resultRequest);

      core.info(`Scan status: ${resultResponse.Status}`);
      core.debug(`Full scan response: ${JSON.stringify(resultResponse, null, 2)}`);

      // === Handle Final States ===

      if (resultResponse.Status === 'Succeeded') {
        // SUCCESS: Scan completed successfully
        const elapsedSeconds = Math.round((currentTime - startTime) / 1000);
        core.info(
          `✓ Terraform scan completed successfully after ${elapsedSeconds} seconds and ${attempts} polling attempts`
        );

        // Build the result object with ReachabilityAnalysis, AccessAnalysis, and optional CrowdstrikePrecogDetections.
        // Parse CrowdstrikePrecogDetections at the boundary when the API returns a string (possibly double-encoded).
        const hasReachability = !!resultResponse.ReachabilityAnalysis;
        const hasAccess = !!resultResponse.AccessAnalysis;
        let parsedCrowdstrike: unknown = resultResponse.CrowdstrikePrecogDetections;
        if (typeof resultResponse.CrowdstrikePrecogDetections === 'string') {
          try {
            parsedCrowdstrike = JSON.parse(resultResponse.CrowdstrikePrecogDetections);
            if (typeof parsedCrowdstrike === 'string') {
              parsedCrowdstrike = JSON.parse(parsedCrowdstrike);
            }
          } catch {
            core.warning(
              'Failed to parse CrowdstrikePrecogDetections from API, omitting from scan result'
            );
            parsedCrowdstrike = undefined;
          }
        }
        if (hasReachability || hasAccess || parsedCrowdstrike != null) {
          const scanResultObj: {
            ReachabilityAnalysis?: typeof resultResponse.ReachabilityAnalysis;
            AccessAnalysis?: typeof resultResponse.AccessAnalysis;
            CrowdstrikePrecogDetections?: unknown;
          } = {};

          if (hasReachability) {
            scanResultObj.ReachabilityAnalysis = resultResponse.ReachabilityAnalysis;
          }
          if (hasAccess) {
            scanResultObj.AccessAnalysis = resultResponse.AccessAnalysis;
          }
          if (parsedCrowdstrike != null) {
            scanResultObj.CrowdstrikePrecogDetections = parsedCrowdstrike;
          }

          core.info('Scan result received and validated');
          const resultJson = JSON.stringify(scanResultObj);
          core.debug(`Scan result length: ${resultJson.length} chars`);
          return resultJson;
        } else {
          // Unusual: scan succeeded but no result data
          core.warning('Scan completed but no result data was returned');
          return '';
        }
      } else if (resultResponse.Status === 'Failed') {
        // FAILURE: Scan encountered an error and will not retry
        // Re-throw as ScanStatusError so it's not retried
        core.error(`Scan failed. Error details: ${resultResponse.ReachabilityAnalysis || 'None'}`);
        throw new ScanStatusError(
          `Terraform scan failed. Job ID: ${jobId}. Result: ${resultResponse.ReachabilityAnalysis || 'No error details provided'}`,
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

function extractCloudIdFromScanResult(scanResult: string): string | undefined {
  try {
    const parsed = JSON.parse(scanResult) as {
      ReachabilityAnalysis?: {
        AddedResources?: TerraformResource[];
        RemovedResources?: TerraformResource[];
        ModifiedResources?: TerraformResource[];
      };
      AccessAnalysis?: { Resources?: TerraformResource[] };
    };
    const allResources: TerraformResource[] = [
      ...(parsed.ReachabilityAnalysis?.AddedResources ?? []),
      ...(parsed.ReachabilityAnalysis?.RemovedResources ?? []),
      ...(parsed.ReachabilityAnalysis?.ModifiedResources ?? []),
      ...(parsed.AccessAnalysis?.Resources ?? []),
    ];
    for (const resource of allResources) {
      if (resource.Asset?.CloudID) return resource.Asset.CloudID;
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/**
 * Main action entry point
 * Orchestrates the complete workflow: input validation, file uploads, scanning, and PR commenting
 *
 * @throws Error if any step fails (will be caught and reported via core.setFailed)
 */
async function run(): Promise<void> {
  try {
    core.info('Starting Averlon Infrastructure Risk PreCog Agent...');

    // === Step 1: Input Collection and Validation ===
    core.debug('Step 1: Collecting and validating inputs');
    const inputs = await _getInputs();

    // === Step 1a: Skip when no Terraform files changed in the PR (base..head) ===
    if (inputs.skipWhenNoChanges && inputs.githubToken) {
      let owner: string;
      let repo: string;
      try {
        const ctx = github.context.repo;
        owner = ctx.owner;
        repo = ctx.repo;
      } catch {
        core.debug(
          'Could not get repo from context (e.g. GITHUB_REPOSITORY unset); skipping "no Terraform file changes" check.'
        );
        owner = '';
        repo = '';
      }
      if (owner && repo) {
        const changedFiles = await _getChangedFilesBetweenCommits(
          owner,
          repo,
          inputs.baseCommitHash,
          inputs.headCommitHash,
          inputs.githubToken
        );
        const hasTerraformChanges = changedFiles.some(_hasTerraformExtension);
        if (changedFiles.length > 0 && !hasTerraformChanges) {
          core.info(
            'No Terraform files (*.tf, *.tf.json, *.tfvars, *.tfvars.json) changed in this PR; skipping upload and scan.'
          );
          const skipResult = JSON.stringify({
            skipped: true,
            reason: 'No Terraform files changed in this PR; nothing to analyze.',
          });
          core.setOutput('scan-result', skipResult);

          if (inputs.commentOnPr) {
            try {
              await postOrUpdateComment(
                inputs.githubToken,
                skipResult,
                inputs.headCommitHash,
                inputs.commentMode
              );
              core.info('✓ PR comment posted (skipped: no Terraform file changes)');
            } catch (commentError) {
              const msg =
                commentError instanceof Error ? commentError.message : String(commentError);
              core.warning(`Failed to post PR comment: ${msg}`);
            }
          }

          core.info(
            '✓ Averlon Infrastructure Risk PreCog Agent completed (skipped; no Terraform file changes).'
          );
          return;
        }
      }
    }

    // === Step 1b: Skip when base and head plans are identical ===
    if (inputs.skipWhenNoChanges) {
      const plansIdentical = await _arePlanFilesIdentical(inputs.basePlanPath, inputs.headPlanPath);
      if (plansIdentical) {
        core.info(
          'Base and head Terraform plan files are logically identical (normalized JSON); skipping upload and scan (no changes to analyze).'
        );
        const skipResult = JSON.stringify({
          skipped: true,
          reason: 'Base and head Terraform plans are logically identical; no changes to analyze.',
        });
        core.setOutput('scan-result', skipResult);

        if (inputs.commentOnPr && inputs.githubToken) {
          try {
            await postOrUpdateComment(
              inputs.githubToken,
              skipResult,
              inputs.headCommitHash,
              inputs.commentMode
            );
            core.info('✓ PR comment posted (skipped: no plan changes)');
          } catch (commentError) {
            const msg = commentError instanceof Error ? commentError.message : String(commentError);
            core.warning(`Failed to post PR comment: ${msg}`);
          }
        }

        core.info(
          '✓ Averlon Infrastructure Risk PreCog Agent completed (skipped; no plan changes).'
        );
        return;
      }
    }

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
    core.debug('Step 3: Uploading Terraform files');
    await _uploadTerraformFiles(inputs, apiClient);

    // === Step 4: Scan Execution ===
    core.debug('Step 4: Running Terraform scan');
    const scanResult = await _runTerraformScan(inputs, apiClient);

    // === Step 5: Output Results ===
    core.debug('Step 5: Setting action outputs');
    core.setOutput('scan-result', scanResult);
    core.info('Scan results set as action output');

    // === Step 6: PR Comment (Optional) ===
    if (inputs.commentOnPr && inputs.githubToken) {
      core.debug('Step 6: Posting PR comment');
      core.info('Posting scan results to PR comment...');
      try {
        await postOrUpdateComment(
          inputs.githubToken,
          scanResult,
          inputs.headCommitHash,
          inputs.commentMode
        );
        core.info('✓ PR comment posted successfully');
      } catch (commentError) {
        // Don't fail the entire action if PR commenting fails
        // The scan succeeded, so the results are still available
        const commentErrorMessage =
          commentError instanceof Error ? commentError.message : String(commentError);
        core.warning(`Failed to post PR comment: ${commentErrorMessage}`);
        core.info('Scan completed successfully despite comment failure');
      }
    } else if (inputs.commentOnPr && !inputs.githubToken) {
      // This should be prevented by input validation, but handle it gracefully
      core.warning(
        'comment-on-pr is enabled but github-token is not provided. Skipping PR comment.'
      );
    } else {
      core.debug('Step 6: Skipping PR comment (disabled or no token)');
    }

    const context = github.context;
    if (context.payload.pull_request) {
      try {
        const pr = context.payload.pull_request;
        const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(
          /\/+$/,
          ''
        );
        const prUrl =
          pr.html_url ||
          `${serverUrl}/${context.repo.owner}/${context.repo.repo}/pull/${pr.number}`;
        await registerPrWithSourceControl({
          apiClient,
          owner: context.repo.owner,
          repo: context.repo.repo,
          prNumber: pr.number,
          prUrl,
          prTitle: pr.title,
          scanResult,
          cloudId: extractCloudIdFromScanResult(scanResult),
        });
      } catch (sourceControlError) {
        const msg =
          sourceControlError instanceof Error
            ? sourceControlError.message
            : String(sourceControlError);
        core.warning(`Failed to register with source control: ${msg}`);
      }
    } else {
      core.debug('Not in a pull request context; skipping source control registration');
    }

    core.info('✓ Averlon Infrastructure Risk PreCog Agent completed successfully!');
    core.info(`Scan result available in 'scan-result' output`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Action failed: ${errorMessage}`);
    core.setFailed(`Action failed: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      core.debug(`Error stack trace: ${error.stack}`);
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  run();
}

export { run, _runTerraformScan };
