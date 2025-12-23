import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  buildDockerfileRequests,
  findDockerfiles,
  getGitRepoUrl,
  parseFilters,
  parseImageMap,
  toRelativePath,
} from './recommendations';
import { createApiClient, GetGitProjectRecommendationsRequest } from '@averlon/shared';
import { getInputSafe, parseBoolean } from '@averlon/github-actions-utils';
import { GithubIssuesService } from './github-issues';

interface ActionInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  imageMapInput: string;
  filtersRaw: string;
  githubToken: string;
  autoAssignCopilot: boolean;
  githubOwner: string;
  githubRepo: string;
}

/**
 * Collect and validate all action inputs
 *
 * @returns Validated action inputs
 * @throws Error if validation fails
 */
async function _getInputs(): Promise<ActionInputs> {
  core.info('Collecting and validating action inputs...');

  // Get required inputs
  const apiKey = getInputSafe('api-key', true);
  const apiSecret = getInputSafe('api-secret', true);
  const githubToken = getInputSafe('github-token', true);

  // Get optional inputs with defaults
  const baseUrl = getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/';
  const imageMapInput = getInputSafe('image-map', false) || '';
  const filtersRaw = getInputSafe('filters', false) || 'Recommended,Critical,HighRCE';
  const autoAssignCopilotStr = getInputSafe('auto-assign-copilot', false) || 'false';
  const autoAssignCopilot = parseBoolean(autoAssignCopilotStr);

  // GITHUB_REPOSITORY is a standard environment variable automatically provided by GitHub Actions
  // It contains the repository name in the format "owner/repo" (e.g., "octocat/Hello-World")
  // Documentation: https://docs.github.com/en/actions/reference/workflows-and-actions/variables
  const repository = process.env['GITHUB_REPOSITORY'];
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable is not set');
  }

  // Parse GitHub owner and repo
  const [githubOwner, githubRepo] = repository.split('/');
  if (!githubOwner || !githubRepo || githubOwner.includes('/') || githubRepo.includes('/')) {
    throw new Error(
      `Invalid GITHUB_REPOSITORY format: "${githubRepo}". Expected format: "owner/repo"`
    );
  }

  core.debug(`Base URL: ${baseUrl}`);
  core.debug(`Filters: ${filtersRaw}`);
  core.debug(`Image map provided: ${imageMapInput ? 'yes' : 'no'}`);
  core.info(`Auto-assign Copilot ${autoAssignCopilot ? 'enabled' : 'disabled'}`);

  if (githubToken) {
    core.setSecret(githubToken);
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    imageMapInput,
    filtersRaw,
    githubToken,
    autoAssignCopilot,
    githubOwner,
    githubRepo,
  };
}

async function main(): Promise<void> {
  core.debug('Step 1: Collecting and validating inputs');
  const inputs = await _getInputs();

  const dockerfiles = await findDockerfiles();
  core.info(
    `Found ${dockerfiles.length} Dockerfile${dockerfiles.length !== 1 ? 's' : ''} in the repository`
  );

  const client = createApiClient({
    apiKey: inputs.apiKey,
    apiSecret: inputs.apiSecret,
    baseUrl: inputs.baseUrl,
  });

  const imageMap = parseImageMap(inputs.imageMapInput);
  const requests = buildDockerfileRequests(dockerfiles, imageMap);
  const gitRepo = getGitRepoUrl();
  const filters = parseFilters(inputs.filtersRaw);
  const payload: GetGitProjectRecommendationsRequest = {
    Requests: requests,
    GitRepo: gitRepo,
    Filters: filters,
  };

  const response = await client.getGitProjectRecommendations(payload);
  const dockerRecs = response?.DockerfileRecommendations || [];

  const octokit = github.getOctokit(inputs.githubToken);
  const issuesService = new GithubIssuesService(octokit, inputs.githubOwner, inputs.githubRepo);

  const recByPath = new Map<string, (typeof dockerRecs)[number]>();
  for (const rec of dockerRecs) recByPath.set(rec.Path, rec);

  core.summary.addHeading('Averlon Recommendations');
  const tableRows = [
    [
      { data: 'Dockerfile', header: true },
      { data: 'Image Repository', header: true },
    ],
  ] as Array<Array<{ data: string; header?: boolean }>>;

  for (const dockerfilePath of dockerfiles) {
    const rec = recByPath.get(dockerfilePath);
    const imageRepo = rec?.ImageRepository?.RepositoryName || 'Not Found';
    tableRows.push([{ data: dockerfilePath }, { data: imageRepo }]);

    try {
      if (rec) {
        // Successfully mapped: We got a recommendation from backend, which means we were able to map this Dockerfile to an image repository
        const mappedImageRepo = rec.ImageRepository?.RepositoryName;
        core.info(
          `[${dockerfilePath}] ✓ Successfully mapped to image repository: ${mappedImageRepo || 'Unknown'}`
        );

        const fixAll = rec.FixAllRecommendation;

        if (fixAll) {
          // Mapped AND has recommendations
          core.info(`[${dockerfilePath}] Security recommendations found`);
          // If there are recommendations, create or update an issue for this Dockerfile (and assign to Copilot if configured).
          await issuesService.createOrUpdateIssue(rec, inputs.autoAssignCopilot);
        } else {
          // Mapped BUT no recommendations
          core.info(`[${dockerfilePath}] No security recommendations available`);
          // If there are no recommendations, close any existing issue related to this Dockerfile.
          await issuesService.closeIssueByPath(
            dockerfilePath,
            'This issue has been automatically closed because no security recommendations are available for this Dockerfile in the latest scan.'
          );
        }
      } else {
        // Failed to map: No recommendation returned from backend, which means we were not able to map this Dockerfile to an image repository
        const relPath = toRelativePath(dockerfilePath);
        const mappedImageRepo = imageMap[relPath];

        if (mappedImageRepo) {
          // Dockerfile is in image-map but Averlon didn't find/scan the image repository
          core.warning(
            `[${dockerfilePath}] ✗ Failed to map: Image repository "${mappedImageRepo}" was specified in image-map but not found in Averlon or not scanned yet. Please ensure the image repository in the image-map input is correct and has been scanned by Averlon`
          );
          await issuesService.closeIssueByPath(
            dockerfilePath,
            'This issue has been automatically closed by Averlon Containers analysis GitHub action.'
          );
        } else {
          // No recommendation returned, which means we were not able to find the mapped image repository for this Dockerfile.
          // Close any existing issues for this Dockerfile since we can't analyze it without an image repository mapping.
          core.warning(
            `[${dockerfilePath}] ✗ Failed to map: Unable to map this Dockerfile to an image repository. Please use image-map input to explicitly map it to an image repository.`
          );
          await issuesService.closeIssueByPath(
            dockerfilePath,
            'This issue has been automatically closed by Averlon Containers analysis GitHub action.'
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.error(`Failed to process ${dockerfilePath}: ${message}`);
      throw error; // Fail the entire action as requested
    }
  }
  core.summary.addTable(tableRows);

  // Clean up issues for Dockerfiles that no longer exist in repo
  try {
    await issuesService.cleanupOrphanedIssues(dockerfiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Failed to cleanup orphaned github issues: ${message}`);
    throw error; // Fail the entire action as requested
  }

  // Fail the action if all Dockerfiles could not be mapped to an image repository
  if (dockerfiles.length > 0) {
    const mappedCount = dockerfiles.filter(path => {
      const rec = recByPath.get(path);
      return rec?.ImageRepository?.RepositoryName;
    }).length;
    if (mappedCount === 0) {
      throw new Error(
        `Found ${dockerfiles.length} Dockerfile(s) in the repository but could not map any of them to an image repository. ` +
          'Please provide an image-map input or ensure your images are scanned by Averlon.'
      );
    }
  }

  await core.summary.write();
}

async function run(): Promise<void> {
  try {
    core.info('Starting Averlon Vulnerability Remediation Agent for Containers...');
    await main();
    core.info('Action completed successfully');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

export { run };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
