import * as core from '@actions/core';
import * as github from '@actions/github';
import { CopilotIssueManager, IssueState } from '@averlon/github-copilot-utils';
import { AVERLON_CREATED_LABEL } from '@averlon/github-actions-utils';
import {
  getExistingState,
  getNewIssueIds,
  selectItemsNeedingUpdateSplit,
  syncBatchedIssues,
  type OctokitLike,
} from '@averlon/copilot-issue-batching';
import type { ParsedResource } from './resource-parser';
import { generateIssueBody, generateIssueTitle } from './issue-template';

// Action-specific constants
const AVERLON_K8S_ANALYSIS_LABEL = 'averlon-k8s-analysis';
const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_K8S_ANALYSIS_LABEL];

/** One resource with chart context for batching (enables overflow into multiple issues) */
export interface ChartResourceItem {
  chartName: string;
  releaseName: string;
  namespace: string;
  resource: ParsedResource;
}

function getResourceItemKey(item: ChartResourceItem): string {
  const { kind, name, namespace } = item.resource;
  return `${item.chartName}/${kind}/${namespace}/${name}`;
}

function getResourceItemFingerprint(item: ChartResourceItem): string {
  const ids = (item.resource.issues ?? [])
    .map(issue => issue.id)
    .filter((id): id is string => Boolean(id))
    .sort();
  return ids.join(',');
}

function getResourceItemWeight(item: ChartResourceItem): number {
  return item.resource.issues?.length ?? 0;
}

/**
 * Extracts the resource identifier from an Averlon Helm issue title
 */
export function extractResourceIdentifierFromTitle(title: string): string {
  if (!title || typeof title !== 'string') {
    return '';
  }

  // Look for pattern: "Averlon Misconfiguration Remediation Agent for Kubernetes: {chartName} - {resourceIdentifier}"
  const averlonPrefix = 'Averlon Misconfiguration Remediation Agent for Kubernetes: ';
  const pathSeparator = ' - ';

  const prefixIndex = title.indexOf(averlonPrefix);
  if (prefixIndex === -1) {
    return '';
  }

  const afterPrefix = title.substring(prefixIndex + averlonPrefix.length);
  const lastSeparatorIndex = afterPrefix.lastIndexOf(pathSeparator);

  if (lastSeparatorIndex === -1) {
    return '';
  }

  return afterPrefix.substring(lastSeparatorIndex + pathSeparator.length).trim();
}

/**
 * Normalizes a resource identifier for comparison
 */
export function normalizeResourceIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== 'string') {
    return '';
  }

  return identifier.trim().toLowerCase();
}

/**
 * GitHub Issues Service for Helm analysis
 * Extends CopilotIssueManager with Helm-specific logic
 */
export class GithubIssuesService extends CopilotIssueManager {
  constructor(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string) {
    super(octokit, owner, repo);
  }

  /**
   * Create or update GitHub issues for the Helm chart's resources.
   * Tries one issue with all resources first; only when the body would overflow
   * GitHub's limit do we break it down into multiple issues (Batch 1 of N, 2 of N, ...).
   */
  async createResourceListIssue(options: {
    chartName: string;
    releaseName: string;
    namespace: string;
    resources: ParsedResource[];
    assignCopilot: boolean;
    workflowRunUrl?: string;
    artifactsUrl?: string;
  }): Promise<void> {
    const {
      chartName,
      releaseName,
      namespace,
      resources,
      assignCopilot,
      workflowRunUrl,
      artifactsUrl,
    } = options;

    const items: ChartResourceItem[] = resources.map(resource => ({
      chartName,
      releaseName,
      namespace,
      resource,
    }));

    if (items.length === 0) {
      core.info(`No resources for chart ${chartName}; skipping issue creation`);
      return;
    }

    const accessors = {
      getKey: getResourceItemKey,
      getFingerprint: getResourceItemFingerprint,
      getWeight: getResourceItemWeight,
    };

    // Only create or update when needed: check existing state and diff by fingerprint
    const existing = await getExistingState(
      this.octokit as unknown as OctokitLike,
      this.owner,
      this.repo,
      AVERLON_K8S_ANALYSIS_LABEL
    );
    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);
    // For changed resources, show only the new issues in the new batch (like main)
    const filteredChanged: ChartResourceItem[] = changedItems.map(item => {
      const existingFp = existing.byKey.get(getResourceItemKey(item))?.fingerprint ?? '';
      const newIds = getNewIssueIds(getResourceItemFingerprint(item), existingFp);
      const newIssues = (item.resource.issues ?? []).filter(
        issue => issue.id && newIds.has(issue.id)
      );
      return {
        ...item,
        resource: { ...item.resource, issues: newIssues },
      };
    });
    const itemsToSync: ChartResourceItem[] = [...newItems, ...filteredChanged];

    if (itemsToSync.length === 0) {
      core.info(`No batches to create or update for chart ${chartName} (already up to date)`);
      return;
    }

    // One issue per namespace — no batching by size; unlikely to have so many resources in one namespace.
    const byNamespace = new Map<string, ChartResourceItem[]>();
    for (const item of itemsToSync) {
      const ns = item.resource.namespace ?? item.namespace ?? 'default';
      const list = byNamespace.get(ns) ?? [];
      list.push(item);
      byNamespace.set(ns, list);
    }

    core.info(
      `Creating/updating issues for ${itemsToSync.length} resource(s) in chart ${chartName} (${byNamespace.size} namespace(s))`
    );

    const allIssueNumbers: number[] = [];
    for (const [ns, group] of byNamespace) {
      const issueNumbers = await syncBatchedIssues({
        octokit: this.octokit as unknown as OctokitLike,
        owner: this.owner,
        repo: this.repo,
        label: AVERLON_K8S_ANALYSIS_LABEL,
        labels: ISSUE_LABELS,
        items: group,
        accessors,
        config: {
          maxItemsPerBatch: group.length,
          maxWeightPerBatch: Number.MAX_SAFE_INTEGER,
        },
        existingState: existing,
        newIssuesInSeparateBatches: true,
        generateTitle: (batch, batchIndex, totalBatches) => {
          const chartName = batch[0]?.chartName ?? 'Kubernetes resources';
          const base = generateIssueTitle(chartName);
          const nsLabel = batch[0]?.resource.namespace ?? ns;
          return totalBatches > 1
            ? `${base} - ${nsLabel} (Batch ${batchIndex + 1} of ${totalBatches})`
            : `${base} - ${nsLabel}`;
        },
        generateBody: batch => {
          if (batch.length === 0) {
            return generateIssueBody({
              chartName: '',
              releaseName: '',
              namespace: '',
              issueIds: [],
              totalResources: 0,
              resourcesWithIssues: 0,
              resources: [],
              workflowRunUrl,
              artifactsUrl,
            });
          }
          const batchResources = batch.map(i => i.resource);
          const first = batch[0]!;
          const issueIds = new Set<string>();
          let resourcesWithIssues = 0;
          for (const resource of batchResources) {
            if (resource.issues && resource.issues.length > 0) {
              resourcesWithIssues++;
              for (const issue of resource.issues) {
                if (issue.id) issueIds.add(issue.id);
              }
            }
          }
          return generateIssueBody({
            chartName: first.chartName,
            releaseName: first.releaseName,
            namespace: first.namespace ?? ns,
            issueIds: Array.from(issueIds),
            totalResources: batchResources.length,
            resourcesWithIssues,
            resources: batchResources,
            workflowRunUrl,
            artifactsUrl,
          });
        },
      });
      allIssueNumbers.push(...issueNumbers);
    }

    for (const issueNumber of allIssueNumbers) {
      await this.assignCopilot(issueNumber, assignCopilot);
    }

    core.info(
      `GitHub issue(s) for chart ${chartName} created/updated: #${allIssueNumbers.join(', #')}`
    );
  }

  async closeIssueByResourceIdentifier(
    resourceIdentifier: string,
    message: string
  ): Promise<boolean> {
    const existingIssueNumber = await this.findExistingAverlonIssue(resourceIdentifier);
    if (existingIssueNumber) {
      await this.closeIssue(existingIssueNumber, message);
      return true;
    }
    return false;
  }

  async cleanupOrphanedIssues(currentResourceIdentifiers: string[]): Promise<void> {
    const allAverlonIssues = await this.getAllAverlonIssues();
    const errors: Error[] = [];

    for (const issue of allAverlonIssues) {
      if (!issue.resourceIdentifier || !issue.resourceIdentifier.trim()) continue;

      const resourceExists = currentResourceIdentifiers.some(
        currentId =>
          normalizeResourceIdentifier(currentId) ===
          normalizeResourceIdentifier(issue.resourceIdentifier)
      );

      if (!resourceExists) {
        try {
          core.info(
            `Closing orphaned Helm recommendation #${issue.number} for resource "${issue.resourceIdentifier}"`
          );
          await this.closeIssueByResourceIdentifier(
            issue.resourceIdentifier,
            'This issue has been automatically closed because the Kubernetes resource no longer exists in the Helm chart.'
          );
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to clean up some orphaned issues:\n${errors.map(e => e.message).join('\n')}`
      );
    }
  }

  private async findExistingAverlonIssue(resourceIdentifier: string): Promise<number | null> {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_K8S_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });

    const normalizedTargetId = normalizeResourceIdentifier(resourceIdentifier);

    for (const issue of issues) {
      const extractedId = extractResourceIdentifierFromTitle(issue.title);
      if (extractedId && normalizeResourceIdentifier(extractedId) === normalizedTargetId) {
        return issue.number;
      }
    }
    return null;
  }

  private async closeIssue(issueNumber: number, message: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: message,
    });
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: IssueState.CLOSED,
    });
    core.info(`Closed Helm recommendation #${issueNumber}`);
  }

  private async getAllAverlonIssues(): Promise<
    Array<{ number: number; title: string; resourceIdentifier: string }>
  > {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_K8S_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });

    return issues.map(issue => {
      const resourceIdentifier = extractResourceIdentifierFromTitle(issue.title);
      return { number: issue.number, title: issue.title, resourceIdentifier };
    });
  }
}
