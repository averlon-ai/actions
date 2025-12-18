import * as core from '@actions/core';
import * as github from '@actions/github';
import { CopilotIssueManager, IssueState } from '@averlon/github-copilot-utils';
import { AVERLON_CREATED_LABEL } from '@averlon/github-actions-utils';
import type { ParsedResource } from './resource-parser';
import { generateIssueBody, generateIssueTitle } from './issue-template';

// Action-specific constants
const AVERLON_K8S_ANALYSIS_LABEL = 'averlon-k8s-analysis';
const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_K8S_ANALYSIS_LABEL];

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
   * Create a single issue listing all resources found in the Helm chart
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

    // Collect issue IDs and stats
    const issueIds = new Set<string>();
    let resourcesWithIssues = 0;

    for (const resource of resources) {
      if (resource.issues && resource.issues.length > 0) {
        resourcesWithIssues++;
        for (const issue of resource.issues) {
          if (issue.id) {
            issueIds.add(issue.id);
          }
        }
      }
    }

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

    // Check if issue already exists
    const existingIssueNumber = await this.findExistingResourceListIssue(chartName);

    if (existingIssueNumber) {
      // Update existing issue
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: existingIssueNumber,
        title,
        body,
      });
      core.info(`Updated resource list issue #${existingIssueNumber} for chart ${chartName}`);
      await this.handleCopilotAssignmentForUpdatedIssue(existingIssueNumber, assignCopilot);
    } else {
      // Create new issue
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels: ISSUE_LABELS,
      });
      core.info(`Created resource list issue #${issue.number} for chart ${chartName}`);
      await this.assignCopilot(issue.number, assignCopilot);
    }
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

  private async findExistingResourceListIssue(chartName: string): Promise<number | null> {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_K8S_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });

    const targetTitle = generateIssueTitle(chartName);
    for (const issue of issues) {
      if (issue.title === targetTitle) {
        return issue.number;
      }
    }
    return null;
  }
}
