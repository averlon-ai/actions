import * as core from '@actions/core';
import * as github from '@actions/github';
import { CopilotIssueManager } from '@averlon/github-copilot-utils';
import {
  AVERLON_CREATED_LABEL,
  createOrUpdateIssue,
  createPRForIssue,
  closeIssue,
  listLabeledIssues,
  syncOpenLabeledIssuesToBackend,
} from '@averlon/github-actions-utils';
import {
  getExistingState,
  getNewIssueIds,
  selectItemsNeedingUpdateSplit,
  syncBatchedIssues,
  type OctokitLike,
} from '@averlon/copilot-issue-batching';
import type { ParsedResource } from './resource-parser';
import { generateIssueBody, generateIssueTitle } from './issue-template';
import type { ApiClient } from '@averlon/shared';
import { GitIssueType } from '@averlon/shared';

// Action-specific constants
export const AVERLON_K8S_ANALYSIS_LABEL = 'averlon-k8s-analysis';
export const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_K8S_ANALYSIS_LABEL];

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
  private apiClient?: ApiClient;
  private cloudId?: string;

  constructor(
    octokit: ReturnType<typeof github.getOctokit>,
    owner: string,
    repo: string,
    apiClient?: ApiClient,
    cloudId?: string
  ) {
    // Type cast needed: k8s-analysis uses @actions/github ^9, CopilotIssueManager uses ^7
    super(octokit as never, owner, repo);
    this.apiClient = apiClient;
    this.cloudId = cloudId;
  }

  /**
   * Create or update GitHub issues for the Helm chart's resources.
   * Tries one issue with all resources first; only when the body would overflow
   * GitHub's limit do we break it down into multiple issues (Batch 1 of N, 2 of N, ...).
   */
  /**
   * Sync labeled Averlon Helm issues (open and closed, not touched this run) to the source-control backend.
   */
  async syncOpenIssuesToBackend(touchedIssueNumbers: number[]): Promise<void> {
    if (!this.apiClient) {
      core.debug('apiClient required for open-issue source control sync; skipping');
      return;
    }
    await syncOpenLabeledIssuesToBackend({
      octokit: this.octokit,
      orgName: this.owner,
      repo: this.repo,
      label: AVERLON_K8S_ANALYSIS_LABEL,
      issueLabels: ISSUE_LABELS,
      type: GitIssueType.Helm,
      apiClient: this.apiClient,
      cloudId: this.cloudId || '',
      touchedIssueNumbers,
      findPRsLinkedToIssue: issueNumber => this.findPRsLinkedToIssue(issueNumber),
    });
  }

  async createResourceListIssue(options: {
    chartName: string;
    releaseName: string;
    namespace: string;
    resources: ParsedResource[];
    assignCopilot: boolean;
    workflowRunUrl?: string;
    artifactsUrl?: string;
  }): Promise<number[]> {
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

    // Collect issue IDs for dashboard registration (from incoming)
    const issueIds = new Set<string>();
    for (const resource of resources) {
      if (resource.issues && resource.issues.length > 0) {
        for (const issue of resource.issues) {
          if (issue.id) issueIds.add(issue.id);
        }
      }
    }
    const relatedIssueIDs: number[] = [];
    for (const id of issueIds) {
      const numId = parseInt(id, 10);
      if (!isNaN(numId)) relatedIssueIDs.push(numId);
    }

    if (items.length === 0) {
      core.info(`No resources for chart ${chartName}; skipping issue creation`);
      return [];
    }

    // Create GI only when at least one resource has issues (derived from issueIds collected above).
    if (issueIds.size === 0) {
      core.info(
        `No issues (misconfiguration or image) found for chart ${chartName}; skipping GitHub issue creation`
      );
      return [];
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
    // Only sync items that have at least one issue; avoid creating issues for namespaces
    // where the only "new" resources have no issues (e.g. new key with empty fingerprint).
    const itemsToSync: ChartResourceItem[] = [...newItems, ...filteredChanged].filter(
      item => (item.resource.issues?.length ?? 0) > 0
    );

    if (itemsToSync.length === 0) {
      core.info(`No batches to create or update for chart ${chartName} (already up to date)`);
      return [];
    }

    // One issue per namespace that has at least one resource with issues (no issue if no resources in that namespace have issues).
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

    // Register each issue with backend and link PRs (from incoming dashboard changes)
    for (const issueNumber of allIssueNumbers) {
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });
      const issueTitle = (issue.title?.trim() ?? '') || `Issue #${issueNumber}`;
      await createOrUpdateIssue({
        apiClient: this.apiClient,
        orgName: this.owner,
        repo: this.repo,
        issueNumber,
        issueTitle,
        riskSummary: '',
        type: GitIssueType.Helm,
        labels: ISSUE_LABELS,
        issueIDs: relatedIssueIDs,
        cloudId: this.cloudId || '',
      });
      const linkedPRs = await this.findPRsLinkedToIssue(issueNumber);
      if (linkedPRs.length > 0) {
        await createPRForIssue({
          apiClient: this.apiClient,
          orgName: this.owner,
          repo: this.repo,
          issueNumber,
          linkedPRs,
          cloudId: this.cloudId || '',
        });
      }
      await this.assignCopilot(issueNumber, assignCopilot).catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        core.warning(
          `Copilot assignment failed (non-fatal): ${message} for issue #${issueNumber} and chart ${chartName}`
        );
      });
    }

    core.info(
      `GitHub issue(s) for chart ${chartName} created/updated: #${allIssueNumbers.join(', #')}`
    );
    return allIssueNumbers;
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
    const issues = await listLabeledIssues(
      this.octokit,
      this.owner,
      this.repo,
      AVERLON_K8S_ANALYSIS_LABEL,
      'open'
    );

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
    await closeIssue({
      octokit: this.octokit,
      owner: this.owner,
      repo: this.repo,
      issueNumber,
      message,
      apiClient: this.apiClient,
      type: GitIssueType.Helm,
      findPRsLinkedToIssue: (num: number) => this.findPRsLinkedToIssue(num),
      logMessage: `Closed Helm recommendation #${issueNumber}`,
      cloudId: this.cloudId || '',
    });
  }

  private async getAllAverlonIssues(): Promise<
    Array<{ number: number; title: string; resourceIdentifier: string }>
  > {
    const issues = await listLabeledIssues(
      this.octokit,
      this.owner,
      this.repo,
      AVERLON_K8S_ANALYSIS_LABEL,
      'open'
    );

    return issues.map(issue => {
      const resourceIdentifier = extractResourceIdentifierFromTitle(issue.title);
      return { number: issue.number, title: issue.title, resourceIdentifier };
    });
  }
}
