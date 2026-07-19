import * as core from '@actions/core';
import * as github from '@actions/github';

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createApiClient,
  TerraformResource,
  getCallerInfo,
  IssueSeverityEnum,
} from '@averlon/shared';
import {
  getInputSafe,
  parseBoolean,
  parseGitHubRepository,
  parseIssueSeverityFilters,
} from '@averlon/github-actions-utils';
import { GithubIssuesService } from './github-issues';
import { correlatePulumiStack } from './pulumi';
import { correlateTerraformPlan } from './terraform-local';

type IacType = 'terraform' | 'pulumi';

export function gitLikeHash(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

export interface ActionInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  commit: string;
  planPath: string;
  iacType: IacType;
  pulumiStackPath?: string;
  cloudId?: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  autoAssignCopilot: boolean;
  resourceTypeFilter?: string[];
  severityFilters?: IssueSeverityEnum[];
}

async function _getInputs(): Promise<ActionInputs> {
  core.info('Collecting and validating action inputs...');

  const explicitGithubToken = getInputSafe('github-token', false);
  const fallbackGithubToken = process.env['GITHUB_TOKEN'] || '';
  const githubToken = explicitGithubToken || fallbackGithubToken;
  const autoAssignCopilot = parseBoolean(getInputSafe('auto-assign-copilot', false) || 'false');
  const resourceTypeFilterRaw = getInputSafe('resource-type-filter', false);
  const resourceTypeFilter = resourceTypeFilterRaw
    ? resourceTypeFilterRaw
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    : undefined;
  const severityFiltersRaw = getInputSafe('filters', false) || 'Critical,High';
  const severityFilters = severityFiltersRaw
    ? parseIssueSeverityFilters(severityFiltersRaw)
    : undefined;

  const { owner: githubOwner, repo: githubRepo, commit: defaultCommit } = parseGitHubRepository();
  const commitInput = getInputSafe('commit', false) || defaultCommit;
  const iacTypeRaw = (getInputSafe('iac-type', false) || 'terraform').toLowerCase();
  if (iacTypeRaw !== 'terraform' && iacTypeRaw !== 'pulumi') {
    throw new Error(`Invalid iac-type: "${iacTypeRaw}". Supported values: terraform, pulumi.`);
  }
  const iacType = iacTypeRaw as IacType;
  const pulumiStackPath = getInputSafe('pulumi-stack-path', false) || undefined;
  const planPath = getInputSafe('plan-path', false) || '';

  if (iacType === 'terraform' && !planPath) {
    throw new Error('plan-path is required when iac-type is terraform');
  }
  if (iacType === 'pulumi' && !pulumiStackPath) {
    throw new Error('pulumi-stack-path is required when iac-type is pulumi');
  }

  const commitHashInput =
    iacType === 'pulumi'
      ? `commit:${commitInput}githubRepo:${githubRepo}githubOwner:${githubOwner}pulumiStackPath:${pulumiStackPath}`
      : `commit:${commitInput}githubRepo:${githubRepo}githubOwner:${githubOwner}planPath:${planPath}`;
  const commit = gitLikeHash(commitHashInput);

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
    commit,
    iacType,
    pulumiStackPath,
    cloudId: getInputSafe('cloud-id', false) || undefined,
    planPath,
    githubToken,
    githubOwner,
    githubRepo,
    autoAssignCopilot,
    resourceTypeFilter,
    severityFilters,
  };
}

function extractCloudIdFromResources(resources: TerraformResource[]): string | undefined {
  for (const resource of resources) {
    if (resource.Asset?.CloudID) return resource.Asset.CloudID;
    for (const issue of resource.Issues ?? []) {
      if (issue.CloudID) return issue.CloudID;
    }
  }
  return undefined;
}

async function run(): Promise<void> {
  try {
    core.info('Starting Averlon IaC correlation with existing misconfigurations...');
    const inputs = await _getInputs();

    const apiClient = createApiClient({
      apiKey: inputs.apiKey,
      apiSecret: inputs.apiSecret,
      baseUrl: inputs.baseUrl,
    });

    if (core.isDebug()) {
      const callerInfo = await getCallerInfo(apiClient);
      core.debug(`Caller info: ${JSON.stringify(callerInfo, null, 2)}`);
    }

    let scanResult: TerraformResource[];
    if (inputs.iacType === 'pulumi') {
      core.info('Correlating Pulumi stack resources with existing Averlon issues...');
      const pulumiStackPath = inputs.pulumiStackPath;
      if (!pulumiStackPath) {
        throw new Error('pulumi-stack-path is required when iac-type is pulumi');
      }
      const pulumiStackContent = await readFile(pulumiStackPath, 'utf-8');
      scanResult = await correlatePulumiStack({
        content: pulumiStackContent,
        apiClient,
        cloudId: inputs.cloudId,
        severityFilters: inputs.severityFilters,
        resourceTypeFilter: inputs.resourceTypeFilter,
      });
    } else {
      core.info('Correlating Terraform plan resources with existing Averlon issues...');
      const terraformPlanContent = await readFile(inputs.planPath, 'utf-8');
      scanResult = await correlateTerraformPlan({
        content: terraformPlanContent,
        apiClient,
        cloudId: inputs.cloudId,
        severityFilters: inputs.severityFilters,
        resourceTypeFilter: inputs.resourceTypeFilter,
      });
    }

    const sortedScanResult = [...scanResult].sort((a, b) => {
      const idA = a.ID || '';
      const idB = b.ID || '';
      return idA.localeCompare(idB);
    });
    core.setOutput('scan-result', JSON.stringify(sortedScanResult));
    core.info(`Correlation results set as action output (${sortedScanResult.length} resources)`);

    try {
      const outputPath =
        process.env['SCAN_RESULT_JSON_PATH'] || join(process.cwd(), 'scan-result.json');
      writeFileSync(outputPath, JSON.stringify(sortedScanResult, null, 2), 'utf8');
      core.info(`Scan result JSON written to ${outputPath}`);
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      core.warning(`Failed to write scan result JSON: ${message}`);
    }

    if (inputs.githubToken && sortedScanResult.length > 0) {
      core.info('Creating GitHub issues for correlated resources...');
      const cloudId = extractCloudIdFromResources(sortedScanResult);
      const octokit = github.getOctokit(inputs.githubToken);
      const issuesService = new GithubIssuesService(
        octokit,
        inputs.githubOwner,
        inputs.githubRepo,
        apiClient,
        cloudId
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
      let touchedIssueNumbers: number[] = [];
      try {
        touchedIssueNumbers = await issuesService.createBatchedIssues(
          sortedScanResult,
          `${inputs.githubOwner}/${inputs.githubRepo}`,
          inputs.commit,
          inputs.autoAssignCopilot,
          workflowRunUrl
        );
        core.info('✓ GitHub issues created/updated successfully');
      } catch (issueError) {
        const issueErrorMessage =
          issueError instanceof Error ? issueError.message : String(issueError);
        core.warning(`Failed to create GitHub issues: ${issueErrorMessage}`);
        core.info('Scan completed successfully despite issue creation failure');
      }

      try {
        await issuesService.syncOpenIssuesToBackend(touchedIssueNumbers);
      } catch (syncError) {
        const syncErrorMessage = syncError instanceof Error ? syncError.message : String(syncError);
        core.warning(
          `Failed to sync labeled issues to source control backend: ${syncErrorMessage}`
        );
        core.info('Scan completed successfully despite backend sync failure');
      }
    } else if (!inputs.githubToken) {
      core.info('GitHub token not provided. Skipping issue creation.');
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

export { run };

if (require.main === module) {
  run();
}
