import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'node:fs';
import { IssueSeverityEnum, createApiClient } from '@averlon/shared';
import { getInputSafe, parseBoolean } from '@averlon/github-actions-utils';
import {
  parseHelmDryRunOutput,
  parseHelmManifest,
  getResourceSummary,
  groupResourcesByKind,
  annotateResourceIds,
} from './resource-parser';
import {
  DeploymentMetadata,
  extractDeploymentMetadata,
  extractMetadataFromResources,
  logDeploymentMetadata,
} from './deployment-metadata';
import { GithubIssuesService } from './github-issues';
import { generateIssueTitle, generateIssueBody } from './issue-template';
import {
  buildAnalysisResult,
  buildConsolidatedIssuesJson,
  writeConsolidatedIssuesJson,
  writeJsonOutput,
  writeSummarySafe,
} from './output';
import { annotateIssuesFromOpenSearch } from './opensearch-issues';
import { resolveCloudIdIfNeeded } from './cloud-id';

interface ActionInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  githubToken: string;
  copilotAssignmentEnabled: boolean;
  githubOwner: string;
  githubRepo: string;
  releaseName?: string;
  namespace?: string;
  manifestFilePath: string;
  cloudId?: string;
  region?: string;
  cluster?: string;
  filtersRaw: string;
  severityFilters: IssueSeverityEnum[];
  resourceTypeFilter?: string[];
  namespaceFilter?: string[];
  verbose: boolean;
}

/**
 * Collect and validate all action inputs
 */
async function getInputs(): Promise<ActionInputs> {
  core.info('Collecting and validating action inputs...');

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
  const explicitGithubToken = getInputSafe('github-token', false);
  const fallbackGithubToken = process.env['GITHUB_TOKEN'] || '';
  const githubToken = explicitGithubToken || fallbackGithubToken;
  const manifestFilePath = getInputSafe('manifest-file', true);

  if (!githubToken) {
    throw new Error(
      'GitHub token is required. Provide the github-token input or ensure GITHUB_TOKEN is available.'
    );
  }

  const copilotAssignmentEnabled = Boolean(explicitGithubToken);

  const baseUrl = getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/';
  const releaseName = getInputSafe('release-name', false) || undefined;
  const namespace = getInputSafe('namespace', false) || undefined;
  const cloudId = getInputSafe('cloud-id', false) || undefined;
  const region = getInputSafe('region', false) || undefined;
  const cluster = getInputSafe('cluster', false) || undefined;
  const filtersRaw = getInputSafe('filters', false) || 'Critical,High';
  const severityFilters = parseIssueFilters(filtersRaw);
  const verboseInput = getInputSafe('verbose', false) || 'false';
  const verbose = parseBoolean(verboseInput);

  const resourceTypeFilterRaw = getInputSafe('resource-type-filter', false);
  const namespaceFilterRaw = getInputSafe('namespace-filter', false);
  const resourceTypeFilter = resourceTypeFilterRaw
    ? resourceTypeFilterRaw
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    : undefined;
  const namespaceFilter = namespaceFilterRaw
    ? namespaceFilterRaw
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0)
    : undefined;

  const repository = process.env['GITHUB_REPOSITORY'];
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable is not set');
  }

  const [githubOwner, githubRepo] = repository.split('/');
  if (!githubOwner || !githubRepo || githubOwner.includes('/') || githubRepo.includes('/')) {
    throw new Error(
      `Invalid GITHUB_REPOSITORY format: "${repository}". Expected format: "owner/repo"`
    );
  }

  core.debug(`Base URL: ${baseUrl}`);
  core.debug(`Filters: ${filtersRaw}`);
  core.info(
    copilotAssignmentEnabled
      ? 'Copilot assignment enabled (custom GitHub token provided).'
      : 'Copilot assignment disabled (using default GITHUB_TOKEN).'
  );

  if (githubToken) {
    core.setSecret(githubToken);
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    githubToken,
    releaseName,
    namespace,
    copilotAssignmentEnabled,
    githubOwner,
    githubRepo,
    cloudId,
    region,
    cluster,
    manifestFilePath,
    filtersRaw,
    severityFilters,
    resourceTypeFilter,
    namespaceFilter,
    verbose,
  };
}

async function main(): Promise<void> {
  core.info('Starting Averlon Misconfiguration Remediation Agent for Kubernetes...');

  const inputs = await getInputs();
  const apiClient = createApiClient({
    apiKey: inputs.apiKey,
    apiSecret: inputs.apiSecret,
    baseUrl: inputs.baseUrl,
  });

  core.info(`Reading manifest file: ${inputs.manifestFilePath}`);
  if (!fs.existsSync(inputs.manifestFilePath)) {
    throw new Error(`Manifest file not found: ${inputs.manifestFilePath}`);
  }

  const manifestContent = fs.readFileSync(inputs.manifestFilePath, 'utf-8');
  core.info('Parsing Helm manifest YAML...');

  let parsed: ReturnType<typeof parseHelmDryRunOutput>;
  try {
    parsed = parseHelmDryRunOutput(manifestContent);
  } catch (error) {
    const snippet = manifestContent.slice(0, 1000);
    const message = error instanceof Error ? error.message : String(error);
    core.error(`Failed to parse manifest file: ${inputs.manifestFilePath}`);
    core.error(`Parser error: ${message}`);
    core.error('First 1000 characters of manifest for debugging:');
    core.error(snippet.length > 0 ? snippet : '<empty file>');

    await core.summary
      .addHeading('Averlon Misconfiguration Remediation Agent for Kubernetes')
      .addRaw(
        [
          '❌ Failed to parse manifest file.',
          `File: ${inputs.manifestFilePath}`,
          `Error: ${message}`,
          'Shown below: first 1000 characters of the manifest for debugging.',
        ].join('\n')
      )
      .addCodeBlock(snippet.length > 0 ? snippet : '<empty file>')
      .write();

    core.setFailed(`Failed to parse manifest file: ${message}`);
    return;
  }

  const manifestYaml = parsed.manifestYaml;
  const userSuppliedValues = parsed.userSuppliedValues;
  const derivedReleaseName = parsed.releaseName;
  const derivedNamespace = parsed.namespace;
  const chartName = derivedReleaseName || 'helm-chart';

  const releaseName = inputs.releaseName || derivedReleaseName || 'helm-release';
  const namespace = inputs.namespace || derivedNamespace || 'default';

  core.info(`✓ Parsed dry run output successfully`);
  core.info(`Chart name: ${chartName}`);
  core.info(`userSuppliedValues length: ${userSuppliedValues?.length || 0} characters`);
  if (userSuppliedValues) {
    core.debug(
      `userSuppliedValues content (first 500 chars): ${userSuppliedValues.substring(0, 500)}`
    );
  }
  core.info(`Release name: ${releaseName}`);
  core.info(`Namespace: ${namespace}`);

  core.info('═══ Extracting Deployment Metadata ═══');
  core.info(`Input cloudId: ${inputs.cloudId || 'not provided'}`);
  core.info(`Input region: ${inputs.region || 'not provided'}`);
  core.info(`Input cluster: ${inputs.cluster || 'not provided'}`);

  const extractedMetadata = extractDeploymentMetadata(userSuppliedValues);
  if (extractedMetadata) {
    core.info(`Extracted from user-supplied values: ${JSON.stringify(extractedMetadata, null, 2)}`);
  }

  core.info('Parsing Kubernetes manifests...');
  let resources = parseHelmManifest(manifestYaml);
  core.info(`✓ Parsed ${resources.length} Kubernetes resources`);

  core.info('Extracting region/cluster/accountId from resources...');
  const resourceMetadata = extractMetadataFromResources(resources);

  const azureRegionPattern =
    /^(eastus|eastus2|westus|westus2|centralus|northeurope|westeurope|uksouth|southeastasia|eastasia|australiaeast|canadacentral|brazilsouth|japaneast|japanwest)$/i;
  const userIntentAzure =
    inputs.region?.match(azureRegionPattern) || inputs.cluster?.toLowerCase().includes('azure');

  const provider: 'aws' | 'azure' | undefined = userIntentAzure
    ? 'azure'
    : resourceMetadata.provider;

  let accountId = extractedMetadata?.accountId ?? resourceMetadata.accountId;
  if (userIntentAzure && accountId && /^\d{12}$/.test(accountId)) {
    core.info('Using Azure context; ignoring detected AWS account ID');
    accountId = undefined;
  }

  const region = inputs.region ?? extractedMetadata?.region ?? resourceMetadata.region;
  const cluster = inputs.cluster ?? extractedMetadata?.cluster ?? resourceMetadata.cluster;
  const resourceGroup = resourceMetadata.resourceGroup;
  // For Azure, use cleared accountId first; only use extracted/resource if not a 12-digit AWS ID.
  const rejectAwsId = (id: string | undefined) => (id && !/^\d{12}$/.test(id) ? id : undefined);
  const accountIdResolved =
    provider === 'azure'
      ? (accountId ??
        rejectAwsId(extractedMetadata?.accountId) ??
        rejectAwsId(resourceMetadata.accountId))
      : accountId;

  const deploymentMetadata: DeploymentMetadata = {
    provider,
    accountId: accountIdResolved ?? undefined,
    resourceGroup: provider === 'azure' ? resourceGroup : undefined,
    region,
    cluster,
    environment: extractedMetadata?.environment,
  };
  const detectedAccountId = deploymentMetadata.accountId;

  logDeploymentMetadata(deploymentMetadata);

  const cloudIdForIssues = await resolveCloudIdIfNeeded({
    client: apiClient,
    providedCloudId: inputs.cloudId,
    detectedAccountId,
  });
  if (!cloudIdForIssues) {
    core.warning('⚠️  Unable to determine secdi Cloud ID; skipping Averlon issue lookup');
    core.info('Provide cloud-id input to enable issue lookup');
  }

  if (!deploymentMetadata.region || !deploymentMetadata.cluster) {
    core.warning('⚠️  Region or cluster not provided; resource IDs will not be generated');
    core.info(
      'Provide region and cluster inputs to enable resource ID generation and issue lookup'
    );
  }

  annotateResourceIds(resources, deploymentMetadata);

  if (inputs.namespaceFilter && inputs.namespaceFilter.length > 0) {
    const beforeCount = resources.length;
    resources = resources.filter(r => inputs.namespaceFilter!.includes(r.namespace));
    core.info(`✓ Applied namespace filter: ${beforeCount} → ${resources.length} resources`);
    core.info(`  Included namespaces: ${inputs.namespaceFilter.join(', ')}`);
  }

  if (inputs.resourceTypeFilter && inputs.resourceTypeFilter.length > 0) {
    const beforeCount = resources.length;
    resources = resources.filter(r => inputs.resourceTypeFilter!.includes(r.kind));
    core.info(`✓ Applied resource type filter: ${beforeCount} → ${resources.length} resources`);
    core.info(`  Included types: ${inputs.resourceTypeFilter.join(', ')}`);
  }

  if (cloudIdForIssues) {
    await annotateIssuesFromOpenSearch({
      client: apiClient,
      cloudId: cloudIdForIssues,
      resources,
      severityFilters: inputs.severityFilters,
      verbose: inputs.verbose,
    });
  }

  if (resources.length === 0) {
    core.warning('No Kubernetes resources found in Helm template output');
    core.summary.addHeading('Averlon Misconfiguration Remediation Agent for Kubernetes');
    core.summary.addRaw('No Kubernetes resources found in Helm chart');
    await core.summary.write();
    return;
  }

  const summary = getResourceSummary(resources);
  core.info('Resource summary:');
  for (const [kind, count] of Object.entries(summary)) {
    core.info(`  ${kind}: ${count}`);
  }
  const podCount = summary['Pod'] ?? 0;
  if (podCount === 0) {
    core.info(
      'Note: No Pods in manifest. Helm template output typically does not include Pods (they are created at runtime by Deployments/DaemonSets). Issue lookup for Pod resource IDs will only match if Pods are present in the manifest.'
    );
  }

  // Display all resource names
  if (inputs.verbose) {
    core.info('\n=== All Resources Found ===');
    const groupedResources = groupResourcesByKind(resources);
    const sortedKinds = Array.from(groupedResources.keys()).sort();

    for (const kind of sortedKinds) {
      const kindResources = groupedResources.get(kind) || [];
      core.info(`\n${kind} (${kindResources.length}):`);
      for (const resource of kindResources.sort((a, b) => a.name.localeCompare(b.name))) {
        const resourceIdInfo = resource.resourceId ? ` | Resource ID: ${resource.resourceId}` : '';
        core.info(`  - ${resource.name} (namespace: ${resource.namespace})${resourceIdInfo}`);
        if (resource.issues && resource.issues.length > 0) {
          core.info('    Issues:');
          for (const issue of resource.issues) {
            const issueTitle = issue.title || issue.summary || issue.id;
            core.info(`      • [${issue.severity ?? 'Unknown'}] ${issueTitle} (ID: ${issue.id})`);
          }
        }
      }
    }
  } else {
    core.info('Detailed resource listing skipped (set verbose input to true to display).');
  }

  if (!process.env['SKIP_ISSUE_CREATION']) {
    core.info('\nCreating GitHub issue with all resources...');
    const octokit = github.getOctokit(inputs.githubToken);
    const issuesService = new GithubIssuesService(
      octokit,
      inputs.githubOwner,
      inputs.githubRepo,
      apiClient
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
    const artifactsUrl = workflowRunUrl ? `${workflowRunUrl}#artifacts` : undefined;

    await issuesService.createResourceListIssue({
      chartName,
      releaseName,
      namespace,
      resources,
      assignCopilot: inputs.copilotAssignmentEnabled,
      workflowRunUrl,
      artifactsUrl,
    });
  } else {
    core.info('\nSkipping issue creation (SKIP_ISSUE_CREATION is set)');
    const issueIds = new Set<string>();
    let resourcesWithIssues = 0;
    for (const resource of resources) {
      if (resource.issues && resource.issues.length > 0) {
        resourcesWithIssues++;
        for (const issue of resource.issues) {
          if (issue.id) issueIds.add(issue.id);
        }
      }
    }
    const runId = process.env['GITHUB_RUN_ID'];
    const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(
      /\/+$/,
      ''
    );
    const workflowRunUrl =
      runId && inputs.githubOwner && inputs.githubRepo
        ? `${serverUrl}/${inputs.githubOwner}/${inputs.githubRepo}/actions/runs/${runId}`
        : undefined;
    const artifactsUrl = workflowRunUrl ? `${workflowRunUrl}#artifacts` : undefined;
    const title = generateIssueTitle(chartName);
    const body = generateIssueBody({
      chartName,
      releaseName,
      namespace,
      issueIds: Array.from(issueIds),
      totalResources: resources.length,
      resourcesWithIssues,
      resources,
      workflowRunUrl,
      artifactsUrl,
    });
    core.info('\n════════════════════════════════════════════════════════════════');
    core.info('📋 GitHub Issue Preview (would be created if SKIP_ISSUE_CREATION were unset)');
    core.info('════════════════════════════════════════════════════════════════\n');
    core.info(`Title:\n${title}\n`);
    core.info('Body:\n');
    core.info(body);
    core.info('\n════════════════════════════════════════════════════════════════');
  }

  core.summary.addHeading('Averlon Misconfiguration Remediation Agent for Kubernetes');
  core.summary.addRaw(`**Chart:** \`${chartName}\`\n\n`);
  core.summary.addRaw(`**Release Name:** \`${releaseName}\`\n\n`);
  core.summary.addRaw(`**Namespace:** \`${namespace}\`\n\n`);
  core.summary.addRaw(`**Total Resources:** ${resources.length}\n\n`);

  if (deploymentMetadata) {
    core.summary.addHeading('Deployment Metadata', 2);
    const metadataLines: string[] = [];
    if (deploymentMetadata.provider) {
      metadataLines.push(`- **Provider:** \`${deploymentMetadata.provider}\``);
    }
    if (deploymentMetadata.accountId) {
      metadataLines.push(`- **Account ID:** \`${deploymentMetadata.accountId}\``);
    }
    if (deploymentMetadata.region) {
      metadataLines.push(`- **Region:** \`${deploymentMetadata.region}\``);
    }
    if (deploymentMetadata.cluster) {
      metadataLines.push(`- **Cluster:** \`${deploymentMetadata.cluster}\``);
    }
    if (deploymentMetadata.environment) {
      metadataLines.push(`- **Environment:** \`${deploymentMetadata.environment}\``);
    }
    if (metadataLines.length > 0) {
      core.summary.addRaw(metadataLines.join('\n') + '\n\n');
    }
  }

  core.summary.addHeading('Resources Analyzed', 2);
  const resourceTableRows = [
    [
      { data: 'Kind', header: true },
      { data: 'Count', header: true },
    ],
  ] as Array<Array<{ data: string; header?: boolean }>>;

  for (const [kind, count] of Object.entries(summary)) {
    resourceTableRows.push([{ data: kind }, { data: count.toString() }]);
  }
  core.summary.addTable(resourceTableRows);

  const analysisResult = buildAnalysisResult({
    chartName,
    releaseName,
    namespace,
    summary,
    resources,
    deploymentMetadata,
    filtersRaw: inputs.filtersRaw,
  });
  writeJsonOutput(analysisResult);

  const consolidatedIssues = buildConsolidatedIssuesJson({
    chartName,
    releaseName,
    namespace,
    resources,
    deploymentMetadata,
    filtersRaw: inputs.filtersRaw,
  });
  writeConsolidatedIssuesJson(consolidatedIssues);

  core.summary.addHeading('Resource Identifiers', 2);
  const identifierRows = [
    [
      { data: 'Kind', header: true },
      { data: 'Namespace', header: true },
      { data: 'Name', header: true },
      { data: 'Resource ID', header: true },
    ],
  ] as Array<Array<{ data: string; header?: boolean }>>;
  for (const resource of resources) {
    identifierRows.push([
      { data: resource.kind },
      { data: resource.namespace },
      { data: resource.name },
      { data: resource.resourceId ?? '-' },
    ]);
  }
  core.summary.addTable(identifierRows);

  const resourcesWithIssues = resources.filter(r => r.issues && r.issues.length > 0);
  if (resourcesWithIssues.length > 0) {
    core.summary.addHeading('High/Critical Issues', 2);
    const issueRows = [
      [
        { data: 'Resource ID', header: true },
        { data: 'Issue ID', header: true },
        { data: 'Severity', header: true },
        { data: 'Title', header: true },
      ],
    ] as Array<Array<{ data: string; header?: boolean }>>;
    for (const resource of resourcesWithIssues) {
      for (const issue of resource.issues ?? []) {
        const title = issue.title || issue.summary || 'Untitled';
        issueRows.push([
          { data: resource.resourceId ?? `${resource.kind}/${resource.name}` },
          { data: issue.id },
          { data: issue.severity ?? 'Unknown' },
          { data: title },
        ]);
      }
    }
    core.summary.addTable(issueRows);
  }

  await writeSummarySafe();
  core.info('✓ Averlon Misconfiguration Remediation Agent for Kubernetes completed successfully');
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

export { run };

if (require.main === module) {
  run();
}

function parseIssueFilters(filtersRaw: string): IssueSeverityEnum[] {
  const severitySet = new Set<IssueSeverityEnum>();

  const tokens = filtersRaw
    .split(',')
    .map(token => token.trim())
    .filter(token => token.length > 0);

  if (tokens.length === 0) {
    tokens.push('Critical', 'High');
  }

  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case 'critical':
        severitySet.add(IssueSeverityEnum.Critical);
        break;
      case 'high':
        severitySet.add(IssueSeverityEnum.High);
        break;
      case 'medium':
        severitySet.add(IssueSeverityEnum.Medium);
        break;
      case 'low':
        severitySet.add(IssueSeverityEnum.Low);
        break;
      default:
        core.warning(
          `Unknown filter "${token}" ignored. Supported values: Critical, High, Medium, Low.`
        );
    }
  }

  if (severitySet.size === 0) {
    severitySet.add(IssueSeverityEnum.Critical);
    severitySet.add(IssueSeverityEnum.High);
  }

  return Array.from(severitySet);
}
