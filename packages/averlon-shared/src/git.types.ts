// ===== Git Actions Types (aligned with gitactions.proto) =====

/**
 * GitIssueRiskStatus indicates whether risk was detected for a Git issue
 */
export enum GitIssueRiskStatus {
  None = 0,
  Detected = 1,
}

/**
 * GitPullRequestStatus defines the status of a Git issue or PR
 */
export enum GitPullRequestStatus {
  Unknown = 0,
  Open = 1,
  Closed = 2,
  Merged = 3,
  Draft = 4,
  Rejected = 5,
}

/**
 * GitIssueType defines the type of a Git issue
 */
export enum GitIssueType {
  Unknown = 0,
  Container = 1,
  IaC = 2,
  InfrastructureRisk = 3,
  Helm = 4,
}

/**
 * GitIssue represents a Git security issue/finding
 */
export interface GitIssue {
  ID?: string;
  OrgID?: string;
  OrgName?: string;
  OrgURL?: string;
  RepoName?: string;
  RepoURL?: string;
  Number?: number;
  URL?: string;
  Title?: string;
  PullRequestNumber?: number;
  PullRequestURL?: string;
  RiskStatus?: GitIssueRiskStatus;
  RiskSummary?: string;
  Status?: GitPullRequestStatus;
  Type?: GitIssueType;
  Labels?: string[];
  IssueIDs?: string[];
  CreatedAt?: string;
  UpdatedAt?: string;
  CloudID?: string;
}

/**
 * RegisterGitIssueRequest registers a new Git issue
 */
export interface RegisterGitIssueRequest {
  OrgName: string;
  OrgURL: string;
  RepoName: string;
  RepoURL: string;
  Number: number;
  URL: string;
  Title: string;
  PullRequestNumber?: number;
  PullRequestURL?: string;
  RiskStatus?: GitIssueRiskStatus;
  RiskSummary?: string;
  Status?: GitPullRequestStatus;
  Type: GitIssueType;
  Labels?: string[];
  IssueIDs?: string[];
  CloudID?: string | undefined;
}

/**
 * RegisterGitIssueResponse returns the created/updated issue
 */
export type RegisterGitIssueResponse = GitIssue;

/**
 * UpdateGitIssueStatusRequest updates the status of a Git issue
 */
export interface UpdateGitIssueStatusRequest {
  CloudID?: string;
  Number?: number;
  GitIssueID?: string;
  RepoURL: string;
  Status: GitPullRequestStatus;
}

/**
 * GitPullRequest represents a pull request associated with a Git issue
 */
export interface GitPullRequest {
  ID?: string;
  GitIssueID?: string;
  Number?: number;
  URL?: string;
  Status?: GitPullRequestStatus;
  Author?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  OrgID?: string;
  CloudID?: string;
}

/**
 * RegisterGitPullRequestRequest registers a PR created to fix an issue
 */
export interface RegisterGitPullRequestRequest {
  CloudID?: string;
  GitIssueID?: string;
  RepoURL?: string;
  IssueNumber?: number;
  Number: number;
  URL: string;
  Status: GitPullRequestStatus;
  Author?: string;
}

/**
 * GetGitPullRequestRequest gets a PR by issue ID and PR number
 */
export interface GetGitPullRequestRequest {
  Number: number;
  GitIssueID?: string;
  RepoURL?: string;
  IssueNumber?: number;
}

/**
 * GetGitPullRequestResponse returns the PR directly
 */
export type GetGitPullRequestResponse = GitPullRequest & {
  NotFound?: boolean;
};

/**
 * UpdateGitPullRequestStatusRequest updates the status of a PR
 */
export interface UpdateGitPullRequestStatusRequest {
  GitIssueID?: string;
  IssueNumber?: number;
  RepoURL: string;
  Number: number;
  Status: GitPullRequestStatus;
}

/**
 * GetGitIssueRequest gets a Git issue by external identifiers
 */
export interface GetGitIssueRequest {
  CloudID?: string;
  RepoURL: string;
  Number: number;
}

/**
 * GetGitIssueResponse returns the issue directly
 */
export type GetGitIssueResponse = GitIssue & {
  NotFound?: boolean;
};

/**
 * FindGitIssueRequest finds a Git issue by external identifiers
 */
export type FindGitIssueRequest = GetGitIssueRequest;
