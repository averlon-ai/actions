export interface ApiConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  disableCertValidation?: boolean;
}

export interface UserToken {
  TokenType: string;
  AccessToken: string;
  ExpiresAt: string;
  IssuedAt: string;
  Issuer: string;
  Audience: string;
}

export interface UserTokenResponse {
  Token: UserToken;
}

export interface CallerInfo {
  userId?: string;
  organizationId?: string;
  role?: string;
  email?: string;
  [key: string]: unknown; // Allow additional properties from the API
}

export interface KVPair {
  Key: string;
  Value: string;
}

export const TerraformFileType = {
  Plan: 'Plan',
  Graph: 'Graph',
} as const;
export type TerraformFileType = (typeof TerraformFileType)[keyof typeof TerraformFileType];

export interface UploadTerraformFileRequest {
  FileData: string; // base64 encoded bytes
  FileType: string;
  RepoName: string;
  Commit: string;
}

export interface UploadTerraformFileResponse {
  success?: boolean;
  message?: string;
}

export interface AnalyzeTerraformRequest {
  RepoName: string;
  BaseCommit: string;
  HeadCommit: string;
}

export interface JobStatusNotification {
  JobID: string;
}

export type JobStatus =
  | 'Unknown'
  | 'Scheduled'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Cancelled'
  | 'Ready';

export interface AnalyzeTerraformResult {
  JobID: string;
  Status: JobStatus;
  ReachabilityAnalysis: TerraformReachabilityAnalysis;
}

export interface ScanTerraformRequest {
  RepoName: string;
  Commit: string;
  ResourceTypes?: string[];
}

export interface ScanTerraformResult {
  JobID: string;
  Status: JobStatus;
  Resources?: TerraformResource[];
}

export interface GetGitProjectRecommendationsRequest {
  Requests: GitFileRecommendationRequest[];
  GitRepo: string;
  Filters: number;
}

export interface GitFileRecommendationRequest {
  Path: string;
  Type: number;
  Content: string;
  Metadata: KVPair[];
  ImageRepository: string;
}

export interface GetGitProjectRecommendationsResponse {
  DockerfileRecommendations: GitDockerfileRecommendation[];
  TerraformRecommendations: GitTerraformRecommendation[];
}

export interface GitDockerfileRecommendation {
  CloudID: string;
  AccountID: string;
  Path: string;
  ImageRepository?: ImageRepository;
  Recommendations?: GitFileRecommendation[];
  FixAllRecommendation?: GitFileRecommendation;
}

export interface GitTerraformRecommendation {
  CloudID: string;
  AccountID: string;
  Path: string;
  Recommendations?: GitFileRecommendation[];
}

export interface ImageRepository {
  RepositoryName?: string;
}

export interface GitFileRecommendation {
  Prompt?: string;
  Summary?: string;
  Hint?: KVPair;
  Command?: string;
}

export enum OpenSearchNamedQueryEnum {
  Any = 0,
  Asset = 1,
  Issue = 2,
}

export enum IssueSeverityEnum {
  Invalid = 0,
  Unknown = 1,
  Low = 2,
  Medium = 4,
  High = 8,
  Critical = 16,
}

export enum IssueTypeEnum {
  Unknown = 0,
  Vulnerability = 1,
  Misconfiguration = 2,
  Secret = 4,
  License = 8,
  Entitlement = 16,
}

export enum VulnerabilityClassEnum {
  RemoteCodeExecution = 0x1,
  PrivilegeEscalation = 0x2,
  DenialOfService = 0x4,
  CrossSiteRequestForgery = 0x8,
  ServerSideRequestForgery = 0x10,
  PathTraversal = 0x20,
  CrossSiteScripting = 0x40,
  SQLInjectionAttack = 0x80,
  XEEInjection = 0x200,
  InformationDisclosure = 0x400,
  AuthenticationBypass = 0x800,
  NotDetermined = 0x4000,
}

export interface ListIssuesRequest {
  CloudID: string;
  BatchID?: string;
  ResourceID?: string;
  AssetID?: string;
  VulnID?: string;
  CVE?: string;
  Offset?: number;
  Limit?: number;
  Filter?: number;
  Options?: number;
  Severities?: IssueSeverityEnum[];
  Types?: IssueTypeEnum[];
}

export interface IssueRecord {
  ID?: string;
  OrgID?: string;
  CloudID?: string;
  BatchID?: string;
  ResourceID?: string;
  AssetID?: string;
  Severity?: IssueSeverityEnum;
  Type?: IssueTypeEnum;
  Classification?: number;
  Title?: string;
  Summary?: string;
  Namespace?: string;
  Status?: number;
  Provider?: number;
  Metadata?: Record<string, unknown>;
}

export interface ListIssuesResponse {
  Issues?: IssueRecord[];
  NextOffset?: number;
}

export interface OrgOpenSearchQueryRequest {
  CloudIDs?: string[];
  Limit?: number;
  Offset?: number;
  QueryID: OpenSearchNamedQueryEnum;
  Args?: KVPair[];
  FilterQuery?: string;
  Aggregations?: string;
  Sort?: string;
  IncludeFields?: string[];
  ExcludeFields?: string[];
  PipeFilterQuery?: string;
}

export interface OpenSearchIssue {
  ID?: string;
  ResourceID?: string;
  Severity?: number;
  Classification?: number;
  Title?: string;
  Summary?: string;
  Type?: number;
  Status?: number;
}

export interface OpenSearchResponse {
  Issues?: OpenSearchIssue[];
  NextOffset?: number;
}

/**
 * Cloud object as returned by GetCloud API
 */
export interface Cloud {
  ID: string;
  OrgID?: string;
  AccountID?: string;
  Type?: number;
  Status?: number;
  Name?: string;
  CurrentBatchID?: string;
  CurrentBatchAt?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  [key: string]: unknown;
}

/**
 * Request payload for GetCloud API
 */
export interface CloudRequest {
  CloudID?: string;
  AccountID?: string;
  WithSettings?: boolean;
}

export interface CloudSummary {
  id: string;
  name?: string;
  accountId?: string;
  currentBatchId?: string;
}
// AssetV2 matches the proto definition
// Note: All fields are optional since we may not use all of them in PR comments
export interface AssetV2 {
  ID?: string;
  OrgID?: string;
  CloudID?: string;
  ResourceID?: string;
}

// IssueV2 matches the proto definition
// Note: All fields are optional since we may not use all of them in PR comments
export interface IssueV2 {
  ID?: string;
  OrgID?: string;
  CloudID?: string;
}

// TerraformResource matches the proto definition
export interface TerraformResource {
  ID?: string;
  Type?: string;
  Name?: string;
  Asset?: AssetV2;
  Issues?: IssueV2[];
  Reachability?: TerraformReachability;
  PreviousReachability?: TerraformReachability;
}

// TerraformReachability matches the proto definition
export interface TerraformReachability {
  IsReachableFromInternet?: boolean;
  CanReachInternet?: boolean;
  PathFromInternet?: string[];
  PathToInternet?: string[];
  CanReach?: string[];
}

// TerraformReachabilityAnalysis matches the proto definition
// Note: Proto message name is TerraformReachabilityAnalysis
export interface TerraformReachabilityAnalysis {
  AddedResources?: TerraformResource[];
  RemovedResources?: TerraformResource[];
  ModifiedResources?: TerraformResource[];
  Summary?: TerraformReachabilityAnalysisSummary;
}

// TerraformReachabilityAnalysisSummary matches the proto definition
export interface TerraformReachabilityAnalysisSummary {
  NewInternetExposures?: string[];
  NewInternetEgressExposures?: string[];
  TextSummary?: string;
  // RiskSummary is a JSON string that unmarshals to RiskAssessment[]
  RiskSummary?: string;
}

// Legacy ResultSummary (for backward compatibility)
export interface ResultSummary {
  TextSummary?: string;
  RiskSummary?: string;
  NewInternetExposures?: string[];
}

export interface RiskAssessment {
  terraformResource?: string;
  cloudResource?: string;
  riskAssessment?: {
    riskLevel?: string;
    issuesSummary?: string;
    impactAssessment?: string;
    vulnerabilities?: Array<{
      cve?: string;
      severity?: string;
      riskAnalysis?: string;
    }>;
  };
}

export interface AccessRiskAssessment {
  principalId?: string;
  targetResource?: string;
  riskAssessment?: {
    riskLevel?: string;
    issuesSummary?: string;
    impactAssessment?: string;
    vulnerabilities?: Array<{
      cve?: string;
      severity?: string;
      riskAnalysis?: string;
    }>;
  };
}
