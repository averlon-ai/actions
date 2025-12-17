import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  buildDockerfileRequests,
  findDockerfiles,
  getGitRepoUrl,
  parseFilters,
  parseImageMap,
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
  const filtersRaw = getInputSafe('filters', false) || 'RecommendedOrExploited,Critical,HighRCE';
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
  core.info(`Received ${dockerRecs.length} recommendation${dockerRecs.length !== 1 ? 's' : ''}`);

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
        const fixAll = rec.FixAllRecommendation;

        if (fixAll) {
          // If there are recommendations, create or update an issue for this Dockerfile (and assign to Copilot if configured).
          await issuesService.createOrUpdateIssue(rec, inputs.autoAssignCopilot);
        } else {
          // If there are no recommendations, close any existing issue related to this Dockerfile.
          core.info(
            `No security recommendations for ${dockerfilePath}; closing any existing issue if necessary.`
          );
          await issuesService.closeIssueByPath(
            dockerfilePath,
            'This issue has been automatically closed because no security recommendations are available for this Dockerfile in the latest scan.'
          );
        }
      } else {
        // No recommendation returned, which means we were not able to find the mapped image repository for this Dockerfile.
        // We should not close the issue in this case.
        core.warning(
          `Skipping Dockerfile ${dockerfilePath} as we are not able to map it to an image repository. Closing any opened issues for it.`
        );
        await issuesService.closeIssueByPath(
          dockerfilePath,
          'This issue has been automatically closed because we were not able to map the Dockerfile to an image repository.'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.error(`Failed to process issues for ${dockerfilePath}: ${message}`);
      throw error; // Fail the entire action as requested
    }
  }
  core.summary.addTable(tableRows);

  // Clean up issues for Dockerfiles that no longer exist in repo
  try {
    await issuesService.cleanupOrphanedIssues(dockerfiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Failed to cleanup orphaned issues: ${message}`);
    throw error; // Fail the entire action as requested
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
