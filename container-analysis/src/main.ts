import * as core from '@actions/core';
import {
  createApiClient,
  GetContainerRecommendationsRequest,
  GitDockerfile,
  CodeDefectRef,
  CodeDefectStatus,
} from '@averlon/shared';
import {
  buildDockerfileRequests,
  getGitRepoUrl,
  parseFilters,
  toRelativePath,
} from './recommendations';
import {
  DEFAULT_BASE_URL,
  DEFAULT_FILTERS,
  ALLOWED_BASE_TOOLS,
  MCP_TOOLS,
  FEEDBACK_JSON_SCHEMA,
} from './constants';

/**
 * Collects all CodeDefectRef entries from every package in the Dockerfile.
 */
function collectCodeDefects(dockerfile: GitDockerfile): CodeDefectRef[] {
  const refs: CodeDefectRef[] = [];
  for (const layer of dockerfile.Layers ?? []) {
    for (const pkg of layer.Packages ?? []) {
      for (const cd of pkg.CodeDefects ?? []) {
        refs.push(cd);
      }
    }
  }
  return refs;
}

/**
 * Returns a shallow clone of the dockerfile with CodeDefects stripped to only { ID, PublicID }.
 */
function stripToCodeDefectRefs(dockerfile: GitDockerfile): GitDockerfile {
  return {
    ...dockerfile,
    Layers: dockerfile.Layers?.map(layer => ({
      ...layer,
      Packages: layer.Packages?.map(pkg => ({
        ...pkg,
        CodeDefects: pkg.CodeDefects?.map(cd => ({
          ID: cd.ID,
          PublicID: cd.PublicID,
        })),
      })),
    })),
  };
}

/**
 * Builds a prompt string for a single Dockerfile to be consumed by the /remediate-container skill.
 */
function buildDockerfilePrompt(dockerfile: GitDockerfile): string {
  const json = JSON.stringify(stripToCodeDefectRefs(dockerfile), null, 2);
  const codeDefects = collectCodeDefects(dockerfile);

  return `Use /remediate-container skill to resolve issues in ${dockerfile.Path} and create respective PRs.

The package data includes CodeDefects with IDs. Your structured output must include a
"feedback" array with one entry per CodeDefect ID. For each entry:
- Status ${CodeDefectStatus.Fixed} = Fixed (CVE was resolved in a PR or by base image rebuild)
- Status ${CodeDefectStatus.NoFix} = NoFix (could not be fixed)
- Feedback = empty string for Fixed when a PR changed code; use "Rebuild would fix it" when fixed by base image rebuild with no Dockerfile change; concise reason for NoFix

There are ${codeDefects.length} CodeDefect IDs to report on. Every one MUST appear in the output.

If you created any PRs, list EVERY one of them in "pull_requests", an array of
{"pr_number": <integer>, "pr_url": <string>} objects (for example both the base image or
runtime upgrade PR and the dependency upgrade PR).

IMPORTANT: The structured JSON output MUST be the very last thing you produce.
Do NOT output any additional text, summary, or commentary after emitting the structured JSON.
Once you emit the JSON, stop immediately.

Here is the container recommendations data:

\`\`\`json
${json}
\`\`\``;
}

/**
 * Describes how Averlon mapped the one requested Dockerfile to an image, and
 * whether that image has package upgrades. The action sends a single
 * Dockerfile, so the response has at most one entry: none means no image was
 * mapped, one means an image was mapped (it may still have nothing to fix).
 */
function describeMapping(
  dockerfilePath: string,
  imageRepository: string,
  dockerfileRecs: GitDockerfile[]
): string[] {
  const mapped = dockerfileRecs[0];
  if (!mapped) {
    const repo = imageRepository ? ` (image repository: ${imageRepository})` : '';
    return [
      `Averlon could not map ${dockerfilePath}${repo} to an image.`,
      'Check that the image is pushed and scanned by Averlon in a cloud of your organization.',
    ];
  }

  const repo = imageRepository || mapped.ImageRepository?.RepositoryName || 'an image';
  const details = [
    mapped.ImageID && `image ID ${mapped.ImageID}`,
    mapped.CloudID && `cloud ${mapped.CloudID}`,
  ].filter(Boolean);
  const lines = [
    `Averlon mapped ${dockerfilePath} to ${repo}${details.length ? ` (${details.join(', ')})` : ''}.`,
  ];

  const layers = mapped.Layers ?? [];
  const packages = layers.reduce((sum, layer) => sum + (layer.Packages?.length ?? 0), 0);
  lines.push(
    packages > 0
      ? `Found ${packages} package(s) to upgrade in ${layers.length} layer(s).`
      : 'No package upgrades are recommended for this image.'
  );
  return lines;
}

async function main(): Promise<void> {
  // Collect inputs from environment
  const apiKey = process.env['AVERLON_API_KEY'];
  const apiSecret = process.env['AVERLON_API_SECRET'];
  const baseUrl = process.env['AVERLON_BASE_URL'] || DEFAULT_BASE_URL;
  const dockerfilePath = process.env['INPUT_DOCKERFILE'] || '';
  const imageRepository = process.env['INPUT_IMAGE_REPOSITORY'] || '';
  const filtersRaw = process.env['INPUT_FILTERS'] || DEFAULT_FILTERS;

  if (!apiKey) {
    throw new Error('AVERLON_API_KEY environment variable is required');
  }
  if (!apiSecret) {
    throw new Error('AVERLON_API_SECRET environment variable is required');
  }
  if (!dockerfilePath) {
    throw new Error('INPUT_DOCKERFILE environment variable is required');
  }

  // Register secrets to prevent them from appearing in logs
  core.setSecret(apiKey);
  core.setSecret(apiSecret);

  core.info(`Processing Dockerfile: ${dockerfilePath}`);

  // Build a single request for the provided Dockerfile
  const imageMap: Record<string, string> = {};
  if (imageRepository) {
    imageMap[toRelativePath(dockerfilePath)] = imageRepository;
  }
  const requests = buildDockerfileRequests([dockerfilePath], imageMap);

  // Call Averlon API with getContainerRecommendations
  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });
  const payload: GetContainerRecommendationsRequest = {
    Requests: requests,
    GitRepo: getGitRepoUrl(),
    Filters: parseFilters(filtersRaw),
  };

  core.info('Calling Averlon API for container recommendations...');
  const response = await apiClient.getContainerRecommendations(payload);
  const dockerfileRecs = response?.Dockerfiles || [];
  for (const line of describeMapping(dockerfilePath, imageRepository, dockerfileRecs)) {
    core.info(line);
  }

  // Find the Dockerfile with actionable packages
  const actionable = dockerfileRecs.find(df => {
    const totalPackages = df.Layers?.reduce((sum, layer) => sum + (layer.Packages?.length || 0), 0);
    return totalPackages > 0;
  });

  if (!actionable) {
    core.info('Nothing to remediate.');
    core.setOutput('has-recommendations', 'false');
    core.setOutput('prompt', '');
    core.setOutput('allowed-tools', '');
    core.setOutput('cloud-id', dockerfileRecs.find(df => df.CloudID)?.CloudID ?? '');
    return;
  }

  // Build the prompt
  const prompt = buildDockerfilePrompt(actionable);

  // Build allowed tools list
  const baseTools = [...ALLOWED_BASE_TOOLS];
  const disableWebSearch = process.env['INPUT_DISABLE_WEBSEARCH']?.toLowerCase() === 'true';
  if (!disableWebSearch) {
    baseTools.push('WebSearch');
  }
  const allowedTools = [...baseTools, ...MCP_TOOLS].join(',');

  // Collect all code defect IDs so submit-feedback can detect missing ones
  const codeDefectIds = collectCodeDefects(actionable).map(cd => cd.ID);
  core.setOutput('code-defect-ids', codeDefectIds.join(','));

  core.setOutput('has-recommendations', 'true');
  core.setOutput('prompt', prompt);
  core.setOutput('json-schema', FEEDBACK_JSON_SCHEMA);
  core.setOutput('allowed-tools', allowedTools);
  core.setOutput('cloud-id', actionable.CloudID ?? '');

  core.debug(
    `Outputs set: has-recommendations=true, prompt length=${prompt.length}, code defect IDs=${codeDefectIds.length}`
  );
}

async function run(): Promise<void> {
  try {
    core.info('Starting Averlon Container Analysis action...');
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

export { run, buildDockerfilePrompt, collectCodeDefects, describeMapping, FEEDBACK_JSON_SCHEMA };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
