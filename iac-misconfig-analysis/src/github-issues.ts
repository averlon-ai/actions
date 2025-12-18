import * as core from '@actions/core';
import { CopilotIssueManager, IssueState } from '@averlon/github-copilot-utils';
import { AVERLON_CREATED_LABEL } from '@averlon/github-actions-utils';
import type { TerraformResource } from '@averlon/shared';
import { generateIssueBody, generateIssueTitle } from './issue-template';

// Action-specific constants
const AVERLON_MISCONFIG_ANALYSIS_LABEL = 'averlon-iac-misconfiguration-analysis';
const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_MISCONFIG_ANALYSIS_LABEL];
const RESOURCES_PER_ISSUE = 10;

/**
 * Extracts the batch number from an Averlon Terraform issue title
 */
export function extractBatchNumberFromTitle(title: string): number | null {
  if (!title || typeof title !== 'string') {
    return null;
  }

  // Look for pattern: "Averlon Misconfiguration Remediation Agent for IaC: Batch {number}"
  const averlonPrefix = 'Averlon Misconfiguration Remediation Agent for IaC: Batch ';
  const prefixIndex = title.indexOf(averlonPrefix);
  if (prefixIndex === -1) {
    return null;
  }

  const afterPrefix = title.substring(prefixIndex + averlonPrefix.length);
  const match = afterPrefix.match(/^(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * GitHub Issues Service for Terraform misconfiguration scan
 * Extends CopilotIssueManager with Terraform-specific logic
 */
export class GithubIssuesService extends CopilotIssueManager {
  /**
   * Create GitHub issues for Terraform resources, batching 10 resources per issue
   */
  async createBatchedIssues(
    resources: TerraformResource[],
    repoName: string,
    commit: string,
    assignCopilot: boolean = false,
    workflowRunUrl?: string
  ): Promise<void> {
    if (resources.length === 0) {
      core.info('No Terraform resources to create issues for');
      return;
    }

    // Filter resources that have issues
    const resourcesWithIssues = resources.filter(
      resource => resource.Issues && resource.Issues.length > 0
    );

    if (resourcesWithIssues.length === 0) {
      core.info('No Terraform resources with issues found');
      return;
    }

    // Check existing issues and filter resources that need new issues
    // (resources where issues increased or don't exist in existing issues)
    const resourcesNeedingNewIssues =
      await this.filterResourcesNeedingNewIssues(resourcesWithIssues);

    if (resourcesNeedingNewIssues.length === 0) {
      core.info(
        'All resources already have issues with same or fewer issue counts. No new issues needed.'
      );
      return;
    }

    // Sort resources by ID to ensure consistent batching
    resourcesNeedingNewIssues.sort((a, b) => {
      const idA = a.ID || '';
      const idB = b.ID || '';
      return idA.localeCompare(idB);
    });

    core.info(
      `Creating GitHub issues (batching ${RESOURCES_PER_ISSUE} resources per issue) for ${resourcesNeedingNewIssues.length} resources ....`
    );

    // Find the highest existing batch number to continue from
    const existingBatches = await this.getAllExistingBatchNumbers();
    const maxBatchNumber = existingBatches.length > 0 ? Math.max(...existingBatches) : 0;
    const startBatchNumber = maxBatchNumber + 1;

    // Batch resources into groups of RESOURCES_PER_ISSUE
    const batches: TerraformResource[][] = [];
    for (let i = 0; i < resourcesNeedingNewIssues.length; i += RESOURCES_PER_ISSUE) {
      batches.push(resourcesNeedingNewIssues.slice(i, i + RESOURCES_PER_ISSUE));
    }

    core.info(
      `Created ${batches.length} batch(es) of resources (starting from batch ${startBatchNumber})`
    );

    // Create or update one issue per batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchNumber = startBatchNumber + batchIndex;

      core.info(
        `Processing batch ${batchNumber} (${batch.length} resources) - creating one issue for this batch`
      );

      try {
        await this.createBatchIssue({
          batchNumber,
          resources: batch,
          repoName,
          commit,
          totalBatches: batches.length + maxBatchNumber, // Total includes existing batches
          assignCopilot,
          workflowRunUrl,
        });
        core.info(`✓ Successfully created/updated issue for batch ${batchNumber}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        core.error(`Failed to create/update issue for batch ${batchNumber}: ${errorMessage}`);
        // Continue with other batches even if one fails
      }
    }

    core.info(`Completed processing all ${batches.length} batch(es) - one issue per batch`);
  }

  /**
   * Get all existing batch numbers from open issues
   */
  private async getAllExistingBatchNumbers(): Promise<number[]> {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_MISCONFIG_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });

    const batchNumbers: number[] = [];
    for (const issue of issues) {
      const batchNumber = extractBatchNumberFromTitle(issue.title);
      if (batchNumber !== null) {
        batchNumbers.push(batchNumber);
      }
    }

    return batchNumbers;
  }

  /**
   * Create or update a GitHub Gist with JSON content for a batch of resources
   */
  private async createGist(
    resources: TerraformResource[],
    batchNumber: number,
    repoName: string,
    commit: string
  ): Promise<string> {
    const jsonContent = JSON.stringify(resources, null, 2);
    const fileName = `terraform-resources-batch-${batchNumber}.json`;
    const description = `Terraform resources for ${repoName} (commit: ${commit.substring(0, 7)}) - Batch ${batchNumber}`;

    try {
      const { data: gist } = await this.octokit.rest.gists.create({
        description,
        public: false, // Private gist
        files: {
          [fileName]: {
            content: jsonContent,
          },
        },
      });
      core.info(`Created Gist ${gist.id} for batch ${batchNumber}`);
      return gist.html_url || '';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to create/update Gist for batch ${batchNumber}: ${errorMessage}`);
      // Return empty string if gist creation fails - don't fail the entire issue creation
      return '';
    }
  }

  /**
   * Extract Gist ID from issue body if it exists
   */
  private extractGistIdFromBody(body: string): string | undefined {
    // Look for pattern: [View Resources JSON](https://gist.github.com/.../gist-id)
    const gistUrlMatch = body.match(/https:\/\/gist\.github\.com\/[^\/]+\/([a-f0-9]+)/);
    if (gistUrlMatch && gistUrlMatch[1]) {
      return gistUrlMatch[1];
    }
    return undefined;
  }

  /**
   * Fetch all open issues with averlon-terraform label and extract their Gist IDs
   */
  private async fetchAllOpenIssuesWithGists(): Promise<
    Array<{ GitHubIssueNumber: number; gistId: string }>
  > {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_MISCONFIG_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });

    const issuesWithGists: Array<{ GitHubIssueNumber: number; gistId: string }> = [];

    for (const issue of issues) {
      if (issue.body) {
        const gistId = this.extractGistIdFromBody(issue.body);
        if (gistId) {
          issuesWithGists.push({
            GitHubIssueNumber: issue.number,
            gistId,
          });
        }
      }
    }

    core.debug(`Found ${issuesWithGists.length} open issues with Gists`);
    return issuesWithGists;
  }

  /**
   * Download JSON content from a Gist
   */
  private async downloadGistJson(gistId: string): Promise<TerraformResource[] | null> {
    try {
      const { data: gist } = await this.octokit.rest.gists.get({
        gist_id: gistId,
      });

      // Find the JSON file in the gist (should be terraform-resources-batch-*.json)
      const jsonFile = Object.values(gist.files || {}).find(
        file =>
          file?.filename?.endsWith('.json') &&
          (file?.type === 'application/json' || file?.type === 'text/plain')
      );

      if (!jsonFile || !jsonFile.content) {
        core.warning(`No JSON file found in Gist ${gistId}`);
        return null;
      }

      const resources = JSON.parse(jsonFile.content) as TerraformResource[];
      return Array.isArray(resources) ? resources : null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to download Gist ${gistId}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Get a unique identifier for a resource/asset for comparison
   */
  private getResourceKey(resource: TerraformResource): string {
    // Use Asset ID if available, otherwise use Resource ID
    if (resource.Asset?.ID) {
      return `asset:${resource.Asset.ID}`;
    }
    if (resource.Asset?.ResourceID) {
      return `resource:${resource.Asset.ResourceID}`;
    }
    // Fallback to Terraform resource ID
    return `terraform:${resource.ID || ''}`;
  }

  /**
   * Count issues for a resource
   */
  private countIssuesForResource(resource: TerraformResource): number {
    return resource.Issues?.length || 0;
  }

  /**
   * Extract issue IDs from a resource
   */
  private getIssueIdsForResource(resource: TerraformResource): Set<string> {
    const issueIds = new Set<string>();
    if (resource.Issues && Array.isArray(resource.Issues)) {
      for (const issue of resource.Issues) {
        if (issue.ID) {
          issueIds.add(issue.ID);
        }
      }
    }
    return issueIds;
  }

  /**
   * Check if resources in a batch exist in existing issues and determine if new issues are needed
   * Returns resources that need new issues (where new issue IDs exist for existing assets)
   */
  private async filterResourcesNeedingNewIssues(
    resources: TerraformResource[]
  ): Promise<TerraformResource[]> {
    if (resources.length === 0) {
      return [];
    }

    core.info('Checking existing issues for resource conflicts...');

    // Fetch all open issues with Gists
    const issuesWithGists = await this.fetchAllOpenIssuesWithGists();

    if (issuesWithGists.length === 0) {
      core.info('No existing open issues found, all resources will be processed normally');
      return resources;
    }

    // Download all Gists and build a map of existing resources
    const existingResourcesMap = new Map<
      string,
      { resource: TerraformResource; GitHubIssueNumber: number; issueIds: Set<string> }
    >();

    for (const { gistId, GitHubIssueNumber } of issuesWithGists) {
      const gistResources = await this.downloadGistJson(gistId);
      if (gistResources) {
        for (const resource of gistResources) {
          const key = this.getResourceKey(resource);
          const issueIds = this.getIssueIdsForResource(resource);
          // Consolidate issue if resource is contained by two gists
          const existing = existingResourcesMap.get(key);
          if (!existing) {
            existingResourcesMap.set(key, {
              resource,
              GitHubIssueNumber,
              issueIds: new Set(issueIds),
            });
          } else {
            // Merge issue IDs from both occurrences
            const mergedIssueIds = new Set([...existing.issueIds, ...issueIds]);
            // Use the resource (and Github issue) from the latest occurrence, but keep all merged issueIds
            existingResourcesMap.set(key, {
              resource,
              GitHubIssueNumber,
              issueIds: mergedIssueIds,
            });
          }
        }
      }
    }

    core.debug(`Found ${existingResourcesMap.size} unique resources/assets in existing issues`);

    // Check each resource in the current batch
    const resourcesNeedingNewIssues: TerraformResource[] = [];
    const resourcesToSkip: TerraformResource[] = [];

    for (const resource of resources) {
      const key = this.getResourceKey(resource);
      const existing = existingResourcesMap.get(key);

      if (existing) {
        // For existing assets, compare issue IDs (not just counts)
        const currentIssueIds = this.getIssueIdsForResource(resource);
        const existingIssueIds = existing.issueIds;

        // Check if there are any NEW issue IDs (not present in existing issues)
        const newIssueIds = new Set<string>();
        for (const issueId of currentIssueIds) {
          if (!existingIssueIds.has(issueId)) {
            newIssueIds.add(issueId);
          }
        }

        if (newIssueIds.size > 0) {
          // New issue IDs found for existing asset - need to create new issue
          core.info(
            `Asset ${key} has ${newIssueIds.size} new issue(s) (IDs: ${Array.from(newIssueIds).join(', ')}), will create new issue`
          );
          // Only include the new issue IDs in the resource's Issues array
          const newIssues = resource.Issues?.filter(issue => newIssueIds.has(issue.ID!)) || [];
          resourcesNeedingNewIssues.push({
            ...resource,
            Issues: newIssues,
          });
        } else {
          // No new issue IDs - skip (even if some issues were removed, we don't update)
          core.debug(
            `Asset ${key} has no new issues (existing: ${existingIssueIds.size}, current: ${currentIssueIds.size}), skipping`
          );
          resourcesToSkip.push(resource);
        }
      } else {
        // Resource doesn't exist in any existing issue - process normally (new asset)
        resourcesNeedingNewIssues.push(resource);
      }
    }

    if (resourcesToSkip.length > 0) {
      core.info(
        `Skipping ${resourcesToSkip.length} resource(s) that have no new issues in existing assets`
      );
    }

    if (resourcesNeedingNewIssues.length > 0) {
      core.info(
        `Processing ${resourcesNeedingNewIssues.length} resource(s) that need new issues (new assets or existing assets with new issue IDs)`
      );
    }

    return resourcesNeedingNewIssues;
  }

  /**
   * Create or update a single batch issue
   */
  private async createBatchIssue(options: {
    batchNumber: number;
    resources: TerraformResource[];
    repoName: string;
    commit: string;
    totalBatches: number;
    assignCopilot: boolean;
    workflowRunUrl?: string;
  }): Promise<void> {
    const {
      batchNumber,
      resources,
      repoName,
      commit,
      totalBatches,
      assignCopilot,
      workflowRunUrl,
    } = options;

    // Collect all issue IDs from this batch
    const issueIds = new Set<string>();
    for (const resource of resources) {
      if (resource.Issues && Array.isArray(resource.Issues)) {
        for (const issue of resource.Issues) {
          if (issue.ID) {
            issueIds.add(issue.ID);
          }
        }
      }
    }

    // Create or update Gist with JSON content
    const gistUrl = await this.createGist(resources, batchNumber, repoName, commit);

    const title = generateIssueTitle(batchNumber, totalBatches);
    const body = generateIssueBody({
      batchNumber,
      totalBatches,
      resources,
      repoName,
      commit,
      issueIds: Array.from(issueIds),
      workflowRunUrl,
      gistUrl,
    });

    const { data: issue } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      labels: ISSUE_LABELS,
    });
    core.info(`Created Terraform scan issue #${issue.number} for batch ${batchNumber}`);
    await this.assignCopilot(issue.number, assignCopilot);
  }

  /**
   * Close an issue with a comment
   */
  private async closeIssue(issueNumber: number, options: { message: string }): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: options.message,
    });
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: IssueState.CLOSED,
    });
    core.info(`Closed Terraform scan issue #${issueNumber}`);
  }
}
