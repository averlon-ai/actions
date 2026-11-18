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
 * GitPullRequest represents a pull request. A PR has one GitPullRequest for
 * each repository URL and number. GitIssueID is the Git issue that the PR was
 * registered for last; it is empty for a PR with no Git issue.
 */
export interface GitPullRequest {
  ID?: string;
  GitIssueID?: string;
  OrgName?: string;
  OrgURL?: string;
  RepoName?: string;
  RepoURL?: string;
  Title?: string;
  Type?: GitIssueType;
  Number?: number;
  URL?: string;
  Status?: GitPullRequestStatus;
  Author?: string;
  Labels?: string[];
  IssueIDs?: string[];
  RiskStatus?: GitIssueRiskStatus;
  RiskSummary?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  OrgID?: string;
  CloudID?: string;
  /** Key of the Jira or Linear ticket Averlon created, for example SEC-123; empty until created. */
  Ticket?: string;
  /** URL of the ticket; empty until created. */
  TicketURL?: string;
  /** Why Averlon could not create the requested ticket; empty once it is created. */
  TicketError?: string;
}

/**
 * TicketRequest asks Averlon to create a Jira or Linear ticket for a registered PR.
 * Every field is optional; an unset field takes the integration default. Averlon
 * creates the ticket after the call returns.
 */
export interface TicketRequest {
  Labels?: string[];
  /** Jira only. */
  Components?: string[];
  Priority?: string;
  /** Key of the parent ticket, for example an epic. */
  Parent?: string;
  /** Jira issue type, for example Task or Bug. */
  IssueType?: string;
  AssigneeEmail?: string;
  /** Jira only. */
  ReporterEmail?: string;
  /** Ticket summary after the type prefix; empty uses the PR title. */
  Summary?: string;
  /** Added in brackets before the ticket summary. */
  Prefix?: string;
}

/**
 * RegisterGitPullRequestRequest registers a PR. A PR that fixes a Git issue
 * names it with GitIssueID or IssueNumber; a PR with no Git issue (opened by a
 * coding agent) sends RepoURL and its own repo, title and type.
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
  OrgName?: string;
  OrgURL?: string;
  RepoName?: string;
  Title?: string;
  Type?: GitIssueType;
  Labels?: string[];
  IssueIDs?: string[];
  RiskStatus?: GitIssueRiskStatus;
  RiskSummary?: string;
  /** Creates a ticket for the PR; leave unset for no ticket. */
  Ticket?: TicketRequest;
}
