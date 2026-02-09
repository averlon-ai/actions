import * as core from '@actions/core';
import { CopilotIssueManager } from '@averlon/github-copilot-utils';
import { AVERLON_CREATED_LABEL } from '@averlon/github-actions-utils';
import type { TerraformResource } from '@averlon/shared';
import {
  getExistingState,
  getNewIssueIds,
  selectItemsNeedingUpdateSplit,
  syncBatchedIssues,
  type OctokitLike,
} from '@averlon/copilot-issue-batching';
import { generateIssueBody, generateIssueTitle } from './issue-template';

// Action-specific constants
const AVERLON_MISCONFIG_ANALYSIS_LABEL = 'averlon-iac-misconfiguration-analysis';
const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_MISCONFIG_ANALYSIS_LABEL];
const RESOURCES_PER_ISSUE = 10;
const MAX_WEIGHT_PER_BATCH = 200;

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

function getResourceKey(resource: TerraformResource): string {
  if (resource.Asset?.ID) {
    return `asset:${resource.Asset.ID}`;
  }
  if (resource.Asset?.ResourceID) {
    return `resource:${resource.Asset.ResourceID}`;
  }
  return `terraform:${resource.ID || ''}`;
}

function getFingerprint(resource: TerraformResource): string {
  const ids = (resource.Issues ?? [])
    .map(issue => issue.ID)
    .filter((id): id is string => Boolean(id))
    .sort();
  return ids.join(',');
}

function getWeight(resource: TerraformResource): number {
  return resource.Issues?.length ?? 0;
}

/**
 * GitHub Issues Service for Terraform misconfiguration scan
 * Uses @averlon/copilot-issue-batching for batching and state-in-body sync (no Gist)
 */
export class GithubIssuesService extends CopilotIssueManager {
  /**
   * Create or update GitHub issues for Terraform resources via the shared batching package
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

    const resourcesWithIssues = resources.filter(
      resource => resource.Issues && resource.Issues.length > 0
    );

    if (resourcesWithIssues.length === 0) {
      core.info('No Terraform resources with issues found');
      return;
    }

    const accessors = {
      getKey: getResourceKey,
      getFingerprint,
      getWeight,
    };

    // Only create or update when needed: check existing state and diff by fingerprint
    const existing = await getExistingState(
      this.octokit as unknown as OctokitLike,
      this.owner,
      this.repo,
      AVERLON_MISCONFIG_ANALYSIS_LABEL
    );
    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(
      resourcesWithIssues,
      accessors,
      existing
    );
    // For changed resources, show only the new issues in the new batch (like main)
    const filteredChanged = changedItems.map(resource => {
      const existingFp = existing.byKey.get(getResourceKey(resource))?.fingerprint ?? '';
      const newIds = getNewIssueIds(getFingerprint(resource), existingFp);
      const newIssues = (resource.Issues ?? []).filter(issue => issue.ID && newIds.has(issue.ID));
      return { ...resource, Issues: newIssues };
    });
    const itemsToSync = [...newItems, ...filteredChanged];

    if (itemsToSync.length === 0) {
      core.info('No batches to create or update (all items already up to date)');
      return;
    }

    core.info(
      `Creating/updating issues only for ${itemsToSync.length} resource(s) that are new or changed`
    );
    const issueNumbers = await syncBatchedIssues({
      octokit: this.octokit as unknown as OctokitLike,
      owner: this.owner,
      repo: this.repo,
      label: AVERLON_MISCONFIG_ANALYSIS_LABEL,
      labels: ISSUE_LABELS,
      items: itemsToSync,
      accessors,
      config: {
        maxItemsPerBatch: RESOURCES_PER_ISSUE,
        maxWeightPerBatch: MAX_WEIGHT_PER_BATCH,
      },
      existingState: existing,
      newIssuesInSeparateBatches: true,
      generateTitle: (_batch, batchIndex, totalBatches) => {
        const batchNumber = batchIndex + 1;
        return generateIssueTitle(batchNumber, totalBatches);
      },
      generateBody: (batch, batchIndex, totalBatches) => {
        const batchNumber = batchIndex + 1;
        const issueIds = new Set<string>();
        for (const r of batch) {
          for (const issue of r.Issues ?? []) {
            if (issue.ID) issueIds.add(issue.ID);
          }
        }
        return generateIssueBody({
          batchNumber,
          totalBatches,
          resources: batch,
          repoName,
          commit,
          issueIds: Array.from(issueIds),
          workflowRunUrl,
        });
      },
    });

    for (const issueNumber of issueNumbers) {
      await this.assignCopilot(issueNumber, assignCopilot);
    }

    core.info(`✓ GitHub issues created/updated: #${issueNumbers.join(', #')}`);
  }
}
