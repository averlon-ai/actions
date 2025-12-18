import * as core from '@actions/core';
import { CopilotIssueManager, IssueState } from '@averlon/github-copilot-utils';
import { AVERLON_CREATED_LABEL } from '@averlon/github-actions-utils';
import type { GitDockerfileRecommendation } from '@averlon/shared';

// Action-specific constants
const AVERLON_CONTAINER_ANALYSIS_LABEL = 'averlon-container-analysis';
const ISSUE_LABELS = [AVERLON_CREATED_LABEL, AVERLON_CONTAINER_ANALYSIS_LABEL];

/**
 * Extracts the Dockerfile path from an Averlon issue title.
 *
 * Issue titles are formatted as: "Averlon Container Analysis: {imageRepo} - {dockerfilePath}"
 * This function safely extracts the dockerfilePath part, handling edge cases where
 * the imageRepo might contain dashes or other special characters
 */
export function extractDockerfilePathFromTitle(title: string): string {
  if (!title || typeof title !== 'string') {
    return '';
  }

  const averlonPrefix = 'Averlon Container Analysis: ';
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

  const path = afterPrefix.substring(lastSeparatorIndex + pathSeparator.length).trim();
  return path;
}

/**
 * Normalizes a file path for comparison purposes.
 * This handles different path separators and ensures consistent comparison.
 */
export function normalizePathForComparison(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }

  return filePath
    .trim()
    .replace(/\\/g, '/') // Convert backslashes to forward slashes
    .replace(/\/+/g, '/') // Collapse multiple slashes into single slash
    .replace(/\/$/, '') // Remove trailing slash
    .toLowerCase();
}

/**
 * GitHub Issues Service for code analysis
 * Extends CopilotIssueManager with container-analysis-specific logic
 */
export class GithubIssuesService extends CopilotIssueManager {
  async createOrUpdateIssue(
    rec: GitDockerfileRecommendation,
    autoAssignCopilot: boolean = false
  ): Promise<void> {
    const imageRepo = rec.ImageRepository?.RepositoryName || 'Unknown';
    const title = this.formatIssueTitle(imageRepo, rec.Path);
    const body = this.formatIssueBody(rec);

    const existingIssueNumber = await this.findExistingAverlonIssue(rec.Path);
    if (existingIssueNumber) {
      const currentIssue = await this.getIssue(existingIssueNumber);
      const currentBody = currentIssue?.body || '';

      // Note: Improve body comparison logic
      const normalizedCurrentBody = currentBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      const normalizedNewBody = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      const bodyChanged = normalizedCurrentBody !== normalizedNewBody;

      core.info(`Security Recommendation Changed: ${bodyChanged}`);

      if (bodyChanged) {
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: existingIssueNumber,
          title,
          body,
        });
        core.info(`Updated security recommendation #${existingIssueNumber} for ${rec.Path}`);
        await this.handleCopilotAssignmentForUpdatedIssue(existingIssueNumber, autoAssignCopilot);
      } else {
        await this.handleCopilotAssignmentForUnchangedIssue(existingIssueNumber, autoAssignCopilot);
      }
    } else {
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels: ISSUE_LABELS,
      });
      core.info(`Created security recommendation #${issue.number} for ${rec.Path}`);
      await this.assignCopilot(issue.number, autoAssignCopilot);
    }
  }

  async closeIssueByPath(dockerfilePath: string, message: string): Promise<boolean> {
    const existingIssueNumber = await this.findExistingAverlonIssue(dockerfilePath);
    if (existingIssueNumber) {
      await this.closeIssue(existingIssueNumber, message);
      return true;
    }
    return false;
  }

  async cleanupOrphanedIssues(currentDockerfilePaths: string[]): Promise<void> {
    const allAverlonIssues = await this.getAllAverlonIssues();
    const errors: Error[] = [];
    for (const issue of allAverlonIssues) {
      if (!issue.path || !issue.path.trim()) continue;
      const pathExists = currentDockerfilePaths.some(
        currentPath =>
          normalizePathForComparison(currentPath) === normalizePathForComparison(issue.path)
      );
      if (!pathExists) {
        try {
          core.info(
            `Closing orphaned security recommendation #${issue.number} for Dockerfile path "${issue.path}"`
          );
          await this.closeIssueByPath(
            issue.path,
            'This issue has been automatically closed because the Dockerfile no longer exists in the repository.'
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

  private formatIssueTitle(imageRepo: string, dockerfilePath: string): string {
    return `Averlon Container Analysis: ${imageRepo} - ${dockerfilePath}`;
  }

  private formatIssueBody(rec: GitDockerfileRecommendation): string {
    const fixAll = rec.FixAllRecommendation;
    if (!fixAll) return '';
    if (!rec.Path) {
      core.warning('Dockerfile path is missing from recommendation');
      return '';
    }
    let body = `## Averlon Security Scan Results\n\n`;
    body += `**Dockerfile:** \`${rec.Path}\`\n`;
    body += `**Image Repository:** \`${rec.ImageRepository?.RepositoryName || 'Unknown'}\`\n\n`;
    if (fixAll.Prompt) body += `### Recommendation\n${fixAll.Prompt}\n\n`;
    body += `---\n*This issue was automatically created by Averlon Container Analysis.*`;
    return body;
  }

  private async findExistingAverlonIssue(dockerfilePath: string): Promise<number | null> {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_CONTAINER_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });
    const normalizedTargetPath = normalizePathForComparison(dockerfilePath);

    for (const issue of issues) {
      const extractedPath = extractDockerfilePathFromTitle(issue.title);
      if (extractedPath && normalizePathForComparison(extractedPath) === normalizedTargetPath) {
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
    core.info(`Closed security recommendation #${issueNumber}`);
  }

  private async getAllAverlonIssues(): Promise<
    Array<{ number: number; title: string; path: string }>
  > {
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: AVERLON_CONTAINER_ANALYSIS_LABEL,
      state: IssueState.OPEN,
      per_page: 100,
    });
    return issues.map(issue => {
      const path = extractDockerfilePathFromTitle(issue.title);
      return { number: issue.number, title: issue.title, path };
    });
  }
}
