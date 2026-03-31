// ===== Source Control Types =====

/**
 * RiskStatus indicates whether risk was detected for a source control issue
 */
export enum RiskStatus {
  None = 0,
  Detected = 1,
}

/**
 * SourceControlStatus defines the status of a source control issue or PR
 */
export enum SourceControlStatus {
  Unknown = 0,
  Open = 1,
  Closed = 2,
  Merged = 3,
  Draft = 4,
  Rejected = 5,
}

/**
 * SourceControlIssueType defines the type of a source control issue
 */
export enum SourceControlIssueType {
  Unknown = 0,
  Container = 1,
  IaC = 2,
  InfrastructureRisk = 3,
  Helm = 4,
}

/**
 * SourceControlIssue represents a source control security issue/finding
 */
export interface SourceControlIssue {
  ID?: string;
  OrgID?: string;
  OrgName?: string;
  OrgURL?: string;
  RepoName?: string;
  RepoURL?: string;
  IssueNumber?: number;
  IssueURL?: string;
  PullRequestNumber?: number;
  PullRequestURL?: string;
  RiskStatus?: RiskStatus;
  RiskSummary?: string;
  Status?: SourceControlStatus;
  Type?: SourceControlIssueType;
  Labels?: string[];
  IssueIDs?: number[];
  CreatedAt?: string;
  UpdatedAt?: string;
}

/**
 * RegisterSourceControlIssueRequest registers a new source control issue
 */
export interface RegisterSourceControlIssueRequest {
  OrgName: string;
  OrgURL: string;
  RepoName: string;
  RepoURL: string;
  IssueNumber: number;
  IssueURL: string;
  IssueTitle: string;
  PullRequestNumber?: number;
  PullRequestURL?: string;
  RiskStatus?: RiskStatus;
  RiskSummary?: string;
  Status?: SourceControlStatus;
  Type: SourceControlIssueType;
  Labels?: string[];
  IssueIDs?: number[];
  /** CloudID is the Averlon cloud ID (required by backend) */
  CloudID: string;
}

/**
 * RegisterSourceControlIssueResponse returns the created/updated issue
 */
export type RegisterSourceControlIssueResponse = SourceControlIssue;

/**
 * UpdateSourceControlIssueStatusRequest updates the status of a source control issue
 */
export interface UpdateSourceControlIssueStatusRequest {
  IssueID: string;
  RepoURL: string;
  Status: SourceControlStatus;
  /** CloudID is the Averlon cloud ID (required by backend) */
  CloudID: string;
}

/**
 * SourceControlPullRequest represents a pull request associated with an issue
 */
export interface SourceControlPullRequest {
  ID?: string;
  SourceControlIssueID?: string;
  PullRequestNumber?: number;
  PullRequestURL?: string;
  Status?: SourceControlStatus;
  Author?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
}

/**
 * RegisterSourceControlPullRequestRequest registers a PR created to fix an issue
 */
export interface RegisterSourceControlPullRequestRequest {
  SourceControlIssueID: string;
  PullRequestNumber: number;
  PullRequestURL: string;
  Status: SourceControlStatus;
  Author?: string;
  /** CloudID is the Averlon cloud ID (required by backend) */
  CloudID: string;
}

/**
 * GetSourceControlPullRequestRequest gets a PR by issue ID and PR number
 */
export interface GetSourceControlPullRequestRequest {
  SourceControlIssueID: string;
  PullRequestNumber: number;
}

/**
 * GetSourceControlPullRequestResponse returns the PR directly
 * When the PR is not found, the API returns a 404 error
 * For backward compatibility, this type can also represent the PR data directly
 */
export type GetSourceControlPullRequestResponse = SourceControlPullRequest & {
  NotFound?: boolean;
};

/**
 * UpdateSourceControlPullRequestStatusRequest updates the status of a PR
 */
export interface UpdateSourceControlPullRequestStatusRequest {
  SourceControlIssueID: string;
  RepoURL: string;
  PullRequestNumber: number;
  Status: SourceControlStatus;
}

/**
 * GetSourceControlIssueRequest gets a source control issue by external identifiers
 */
export interface GetSourceControlIssueRequest {
  RepoURL: string;
  IssueNumber: number;
  /** CloudID is the Averlon cloud ID (required by backend) */
  CloudID: string;
}

/**
 * GetSourceControlIssueResponse returns the issue directly
 * When the issue is not found, the API returns a 404 error
 * For backward compatibility, this type can also represent the issue data directly
 */
export type GetSourceControlIssueResponse = SourceControlIssue & {
  NotFound?: boolean;
};

/**
 * FindSourceControlIssueRequest finds a source control issue by external identifiers
 */
export type FindSourceControlIssueRequest = GetSourceControlIssueRequest;
