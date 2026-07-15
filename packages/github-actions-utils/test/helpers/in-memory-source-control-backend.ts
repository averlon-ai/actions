import { mock } from 'bun:test';
import type { ApiClient } from '@averlon/shared';
import { SourceControlStatus } from '@averlon/shared';

export interface RegisteredPullRequest {
  sourceControlIssueId: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: SourceControlStatus;
  author: string;
  cloudId?: string;
}

export interface InMemorySourceControlBackend {
  client: ApiClient;
  repoUrl: string;
  isIssueTracked: (issueNumber: number) => boolean;
  getIssueStatus: (issueNumber: number) => SourceControlStatus | undefined;
  getPullRequestsForIssue: (issueNumber: number) => RegisteredPullRequest[];
  registeredIssueCount: () => number;
}

/**
 * In-memory ApiClient for e2e tests: issues are unknown until registerSourceControlIssue runs.
 */
export function createInMemorySourceControlBackend(
  orgName: string,
  repo: string
): InMemorySourceControlBackend {
  const repoUrl = `https://github.com/${orgName}/${repo}`;
  const issues = new Map<number, { id: string; title: string; status: SourceControlStatus }>();
  const pullRequests: RegisteredPullRequest[] = [];

  const client = {
    getSourceControlIssue: mock(
      async (req: { RepoURL: string; IssueNumber: number; CloudID?: string }) => {
        if (req.RepoURL !== repoUrl) {
          return { NotFound: true };
        }
        const issue = issues.get(req.IssueNumber);
        if (!issue) {
          return { NotFound: true };
        }
        return {
          ID: issue.id,
          IssueNumber: req.IssueNumber,
          IssueTitle: issue.title,
          Status: issue.status,
        };
      }
    ),
    registerSourceControlIssue: mock(
      async (req: {
        IssueNumber: number;
        IssueTitle: string;
        RepoURL: string;
        Status?: SourceControlStatus;
      }) => {
        if (req.RepoURL !== repoUrl) {
          throw new Error(`Unexpected repo URL: ${req.RepoURL}`);
        }
        const id = `backend-sc-issue-${req.IssueNumber}`;
        issues.set(req.IssueNumber, {
          id,
          title: req.IssueTitle,
          status: req.Status ?? SourceControlStatus.Open,
        });
        return { ID: id, IssueNumber: req.IssueNumber };
      }
    ),
    registerSourceControlPullRequest: mock(
      async (req: {
        SourceControlIssueID: string;
        PullRequestNumber: number;
        PullRequestURL: string;
        Status: SourceControlStatus;
        Author: string;
        CloudID?: string;
      }) => {
        pullRequests.push({
          sourceControlIssueId: req.SourceControlIssueID,
          pullRequestNumber: req.PullRequestNumber,
          pullRequestUrl: req.PullRequestURL,
          status: req.Status,
          author: req.Author,
          cloudId: req.CloudID,
        });
      }
    ),
    updateSourceControlIssueStatus: mock(async () => undefined),
  } as unknown as ApiClient;

  return {
    client,
    repoUrl,
    isIssueTracked: (issueNumber: number) => issues.has(issueNumber),
    getIssueStatus: (issueNumber: number) => issues.get(issueNumber)?.status,
    getPullRequestsForIssue: (issueNumber: number) => {
      const issue = issues.get(issueNumber);
      if (!issue) {
        return [];
      }
      return pullRequests.filter(pr => pr.sourceControlIssueId === issue.id);
    },
    registeredIssueCount: () => issues.size,
  };
}
