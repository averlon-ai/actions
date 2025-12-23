import { createHmac } from 'node:crypto';
import { Agent } from 'node:https';
import * as core from '@actions/core';
import {
  ApiConfig,
  CallerInfo,
  GetGitProjectRecommendationsRequest,
  GetGitProjectRecommendationsResponse,
  AnalyzeTerraformResult,
  AnalyzeTerraformRequest,
  ListIssuesRequest,
  ListIssuesResponse,
  OrgOpenSearchQueryRequest,
  OpenSearchResponse,
  UploadTerraformFileRequest,
  UploadTerraformFileResponse,
  ScanTerraformRequest,
  ScanTerraformResult,
  UserTokenResponse,
  JobStatusNotification,
  CloudSummary,
  CloudRequest,
  Cloud,
  AssetV2,
  IssueV2,
} from './types';

/**
 * Token expiration buffer in milliseconds (5 minutes)
 * Tokens are refreshed if they expire within this window
 */
const TOKEN_EXPIRATION_BUFFER_MS = 5 * 60 * 1000;

export class ApiClient {
  private config: ApiConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private httpsAgent: Agent | undefined;

  constructor(config: ApiConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('API key and API secret are required');
    }

    if (!config.baseUrl) {
      throw new Error('Base URL is required');
    }

    core.setSecret(config.apiKey);
    core.setSecret(config.apiSecret);

    this.config = {
      ...config,
      disableCertValidation: config.disableCertValidation ?? false,
    };

    // Create HTTPS agent with certificate validation disabled if requested
    if (this.config.disableCertValidation) {
      core.warning('Certificate validation is DISABLED - only use for local testing!');

      // SECURITY: Use agent-specific settings instead of global process.env
      // This ensures only requests made with this agent bypass certificate validation
      this.httpsAgent = new Agent({
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined, // Skip hostname verification
      });
    }
  }

  /**
   * Generate HMAC SHA256 signature for API authentication
   * Server expects: HMAC-SHA256(secret, method + timestamp)
   * where method = "/pb.Auth/AuthenticateAPIKey" and encoding = base64url
   */
  private generateSignature(method: string, timestamp: string): string {
    const payload = method + timestamp;
    const hmac = createHmac('sha256', this.config.apiSecret);
    hmac.update(payload);

    // Server uses base64url encoding but WITH padding (Go's base64.URLEncoding.EncodeToString keeps padding)
    let signature = hmac.digest('base64url');

    // Add padding back - Go's base64.URLEncoding.EncodeToString() includes padding
    while (signature.length % 4 !== 0) {
      signature += '=';
    }

    return signature;
  }

  /**
   * Get current timestamp in RFC3339 format
   */
  private getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Check if current access token is valid and not expired
   */
  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) {
      return false;
    }

    // Check if token expires within the configured buffer time
    const expirationThreshold = new Date(Date.now() + TOKEN_EXPIRATION_BUFFER_MS);
    return this.tokenExpiresAt > expirationThreshold;
  }

  /**
   * Authenticate using API key and get access token
   */
  async authenticate(): Promise<void> {
    if (this.isTokenValid()) {
      core.info('Using existing valid access token');
      return;
    }

    core.info('Authenticating with API key...');

    const timestamp = this.getCurrentTimestamp();
    const method = '/pb.Auth/AuthenticateAPIKey';
    const signature = this.generateSignature(method, timestamp);

    const authHeaders = {
      'Content-Type': 'application/json',
      Date: timestamp,
      Authorization: `APIKey ${this.config.apiKey}:${signature}`,
    };

    try {
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      };

      // Add custom agent if certificate validation is disabled
      const finalOptions = this.httpsAgent
        ? { ...fetchOptions, agent: this.httpsAgent }
        : fetchOptions;

      const response = await fetch(
        `${this.config.baseUrl}/pb.Auth/AuthenticateAPIKey`,
        finalOptions
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Authentication failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const authResponse: UserTokenResponse = await response.json();

      this.accessToken = authResponse.Token.AccessToken;
      this.tokenExpiresAt = new Date(authResponse.Token.ExpiresAt);

      core.info(
        `Authentication successful. Token expires at: ${this.tokenExpiresAt.toISOString()}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to authenticate: ${errorMessage}`);
    }
  }

  /**
   * Make authenticated API request
   */
  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST',
    body?: unknown
  ): Promise<T> {
    // Ensure we have a valid token
    await this.authenticate();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
    };

    const requestOptions: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      requestOptions.body = JSON.stringify(body);
    }

    try {
      core.debug(`Making ${method} request to: ${endpoint}`);

      // Add custom agent if certificate validation is disabled
      const finalOptions = this.httpsAgent
        ? { ...requestOptions, agent: this.httpsAgent }
        : requestOptions;

      const response = await fetch(`${this.config.baseUrl}${endpoint}`, finalOptions);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `API request failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const result: T = await response.json();
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`API request to ${endpoint} failed: ${errorMessage}`);
    }
  }

  /**
   * Get caller information (useful for debugging auth)
   */
  async getCallerInfo(): Promise<CallerInfo> {
    return this.makeAuthenticatedRequest<CallerInfo>('/pb.Auth/Caller', 'POST', {});
  }

  /**
   * Upload Terraform file to the service
   */
  async uploadTerraformFile(
    request: UploadTerraformFileRequest
  ): Promise<UploadTerraformFileResponse> {
    return this.makeAuthenticatedRequest<UploadTerraformFileResponse>(
      '/pb.Queries/UploadTerraformFile',
      'POST',
      request
    );
  }

  /**
   * Start a Terraform scan for uploaded files
   */
  async startAnalyzeTerraform(request: AnalyzeTerraformRequest): Promise<JobStatusNotification> {
    core.info(
      `Starting Terraform scan for repo: ${request.RepoName}, base: ${request.BaseCommit}, head: ${request.HeadCommit}`
    );
    return this.makeAuthenticatedRequest<JobStatusNotification>(
      '/pb.Queries/StartAnalyzeTerraform',
      'POST',
      request
    );
  }

  /**
   * Get the result of a Terraform scan
   */
  async getAnalyzeTerraformResult(request: JobStatusNotification): Promise<AnalyzeTerraformResult> {
    return this.makeAuthenticatedRequest<AnalyzeTerraformResult>(
      '/pb.Queries/GetAnalyzeTerraformResult',
      'POST',
      request
    );
  }

  /**
   * Start a terraform scan for misconfiguration
   */
  async startScanTerraform(request: ScanTerraformRequest): Promise<JobStatusNotification> {
    return this.makeAuthenticatedRequest<JobStatusNotification>(
      '/pb.Queries/StartScanTerraform',
      'POST',
      request
    );
  }

  /**
   * Get the result of a terraform misconfiguration scan
   */
  async getScanTerraformResult(request: JobStatusNotification): Promise<ScanTerraformResult> {
    const result = await this.makeAuthenticatedRequest<ScanTerraformResult>(
      '/pb.Queries/GetScanTerraformResult',
      'POST',
      request
    );

    const sanitizeAsset = (asset?: AssetV2): AssetV2 | undefined => {
      if (!asset) {
        return undefined;
      }
      const sanitized: AssetV2 = {};
      if (asset.ID !== undefined) sanitized.ID = asset.ID;
      if (asset.OrgID !== undefined) sanitized.OrgID = asset.OrgID;
      if (asset.CloudID !== undefined) sanitized.CloudID = asset.CloudID;
      if (asset.ResourceID !== undefined) sanitized.ResourceID = asset.ResourceID;
      return Object.keys(sanitized).length > 0 ? sanitized : undefined;
    };

    const sanitizeIssue = (issue?: IssueV2): IssueV2 | undefined => {
      if (!issue) {
        return undefined;
      }
      const sanitized: IssueV2 = {};
      if (issue.ID !== undefined) sanitized.ID = issue.ID;
      if (issue.OrgID !== undefined) sanitized.OrgID = issue.OrgID;
      if (issue.CloudID !== undefined) sanitized.CloudID = issue.CloudID;
      return Object.keys(sanitized).length > 0 ? sanitized : undefined;
    };

    const sanitizedResources = result.Resources?.map(resource => {
      const { Asset, Issues, ...rest } = resource;
      const sanitizedAsset = sanitizeAsset(Asset);
      const sanitizedIssues =
        Issues?.map(issue => sanitizeIssue(issue)).filter((issue): issue is IssueV2 =>
          Boolean(issue)
        ) ?? [];

      return {
        ...rest,
        ...(sanitizedAsset ? { Asset: sanitizedAsset } : {}),
        ...(sanitizedIssues.length > 0 ? { Issues: sanitizedIssues } : {}),
      };
    });

    const { Resources, ...restResult } = result;
    const resources = sanitizedResources ?? Resources;
    return {
      ...restResult,
      ...(resources !== undefined ? { Resources: resources } : {}),
    };
  }

  /**
   * Get project recommendations for Git files (Dockerfile, Terraform, etc.)
   */
  async getGitProjectRecommendations(
    request: GetGitProjectRecommendationsRequest
  ): Promise<GetGitProjectRecommendationsResponse> {
    return this.makeAuthenticatedRequest<GetGitProjectRecommendationsResponse>(
      '/pb.Reports/GetGitProjectRecommendations',
      'POST',
      request
    );
  }

  /**
   * List issues for a cloud/resource
   */
  async listIssues(request: ListIssuesRequest): Promise<ListIssuesResponse> {
    return this.makeAuthenticatedRequest<ListIssuesResponse>(
      '/pb.Reports/ListIssuesV2',
      'POST',
      request
    );
  }

  /**
   * Execute an organization-level OpenSearch query
   */
  async orgOpenSearchQuery(request: OrgOpenSearchQueryRequest): Promise<OpenSearchResponse> {
    return this.makeAuthenticatedRequest<OpenSearchResponse>(
      '/pb.Reports/OrgOpenSearchQuery',
      'POST',
      request
    );
  }

  /**
   * Fetch a single cloud by ID or account ID
   */
  async getCloud(request: CloudRequest): Promise<CloudSummary | undefined> {
    if (!request.CloudID && !request.AccountID) {
      throw new Error('CloudID or AccountID is required to call GetCloud');
    }

    const cloud = await this.makeAuthenticatedRequest<Cloud>('/pb.Orgs/GetCloud', 'POST', request);

    if (!cloud || !cloud.ID) {
      core.warning('GetCloud returned an empty response.');
      return undefined;
    }

    const summary: CloudSummary = { id: cloud.ID };
    if (cloud.Name !== undefined) {
      summary.name = cloud.Name;
    }
    if (cloud.AccountID !== undefined) {
      summary.accountId = cloud.AccountID;
    }
    if (cloud.CurrentBatchID !== undefined) {
      summary.currentBatchId = cloud.CurrentBatchID;
    }
    return summary;
  }
}

/**
 * Create API client from configuration
 */
export function createApiClient(config: ApiConfig): ApiClient {
  return new ApiClient(config);
}

/**
 * Get caller information for debugging authentication
 *
 * @param apiClient - The API client instance
 * @returns Caller information or null if authentication fails
 */
export async function getCallerInfo(apiClient: ReturnType<typeof createApiClient>): Promise<{
  userId?: string;
  organizationId?: string;
  role?: string;
  [key: string]: unknown;
} | null> {
  // Test authentication and retrieve caller information for debugging
  // This is only called in debug mode to avoid extra API calls
  try {
    core.info('Testing authentication...');
    await apiClient.authenticate();

    // Get caller info for debugging purposes
    core.debug('Fetching caller information...');
    const callerInfoData = await apiClient.getCallerInfo();
    core.info(`Authenticated successfully. Caller: ${JSON.stringify(callerInfoData, null, 2)}`);
    return callerInfoData;
  } catch (error) {
    // Don't fail the action if authentication test fails
    // This is just for debugging, the actual operations will authenticate themselves
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`Authentication test failed: ${errorMessage}`);
    core.debug('This is not critical - operations will authenticate when needed');
    return null;
  }
}
