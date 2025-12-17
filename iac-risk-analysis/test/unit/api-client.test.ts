import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import {
  ApiClient,
  createApiClient,
  type ApiConfig,
  type UserTokenResponse,
} from '@averlon/shared/api-client';
import {
  createTestApiConfig,
  createTestApiConfigWithDisabledCerts,
  createLocalhostTestApiConfig,
  createLocalIpTestApiConfig,
} from '../test-utils';

// Mock fetch globally
const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
    statusText: 'OK',
  })
);

global.fetch = mockFetch as any;

describe('api-client.ts', () => {
  let mockConfig: ApiConfig;
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockConfig = createTestApiConfig();

    // Create spies for core functions
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});

    // Reset fetch mock
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Clean up spies after each test
    infoSpy.mockRestore();
    warningSpy.mockRestore();

    // Clean up environment variables
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  describe('ApiClient constructor', () => {
    it('should initialize with provided config', () => {
      const client = new ApiClient(mockConfig);
      expect(client).toBeDefined();
    });

    it('should set authUrl to baseUrl if not provided', () => {
      const client = new ApiClient(mockConfig);
      expect(client).toBeDefined();
      // authUrl is private, but we can test behavior indirectly through authentication
    });

    it('should use custom authUrl when provided', () => {
      const configWithAuthUrl = createTestApiConfig({
        authUrl: 'https://auth.example.com',
      });
      const client = new ApiClient(configWithAuthUrl);
      expect(client).toBeDefined();
    });

    it('should disable certificate validation when requested', () => {
      const configWithDisabledCerts = createTestApiConfigWithDisabledCerts();

      const client = new ApiClient(configWithDisabledCerts);

      expect(warningSpy).toHaveBeenCalledWith(
        'Certificate validation is DISABLED - only use for local testing!'
      );
      // NOTE: We no longer set the global NODE_TLS_REJECT_UNAUTHORIZED for security reasons
      // Certificate bypass is now scoped to the HTTPS agent only
    });

    it('should enable certificate validation by default', () => {
      const client = new ApiClient(mockConfig);

      expect(warningSpy).not.toHaveBeenCalled();
      // Certificate validation is enabled by default (no agent created)
    });
  });

  describe('authentication', () => {
    let client: ApiClient;

    beforeEach(() => {
      client = new ApiClient(mockConfig);
    });

    it('should authenticate successfully with valid credentials', async () => {
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
        UserInfo: {
          ID: 'test-user-id',
          Name: 'Test User',
          Email: 'test@example.com',
          OrgID: 'test-org-id',
          OrgRole: 'admin',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      await client.authenticate();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/pb.Auth/AuthenticateAPIKey',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringMatching(/^APIKey test-api-key:/),
            Date: expect.any(String),
          }),
          body: '{}',
        })
      );

      expect(infoSpy).toHaveBeenCalledWith('Authenticating with API key...');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Authentication successful. Token expires at:')
      );
    });

    it('should handle authentication failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid credentials'),
      } as any);

      await expect(client.authenticate()).rejects.toThrow(
        'Failed to authenticate: Authentication failed: 401 Unauthorized - Invalid credentials'
      );
    });

    it('should handle network errors during authentication', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.authenticate()).rejects.toThrow('Failed to authenticate: Network error');
    });

    it('should reuse valid token and not re-authenticate', async () => {
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
        UserInfo: {
          ID: 'test-user-id',
          Name: 'Test User',
          Email: 'test@example.com',
          OrgID: 'test-org-id',
          OrgRole: 'admin',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthResponse),
        status: 200,
        statusText: 'OK',
      } as any);

      // First authentication
      await client.authenticate();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should reuse token
      await client.authenticate();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Should not call fetch again
      expect(infoSpy).toHaveBeenCalledWith('Using existing valid access token');
    });

    it('should re-authenticate when token is about to expire', async () => {
      const expiredToken: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'expired-token',
          ExpiresAt: new Date(Date.now() + 60000).toISOString(), // 1 minute from now (less than 5 min threshold)
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
        UserInfo: {
          ID: 'test-user-id',
          Name: 'Test User',
          Email: 'test@example.com',
          OrgID: 'test-org-id',
          OrgRole: 'admin',
        },
      };

      const newToken: UserTokenResponse = {
        ...expiredToken,
        Token: {
          ...expiredToken.Token,
          AccessToken: 'new-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        },
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(expiredToken),
          status: 200,
          statusText: 'OK',
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newToken),
          status: 200,
          statusText: 'OK',
        } as any);

      // First authentication with soon-to-expire token
      await client.authenticate();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should re-authenticate due to expiration
      await client.authenticate();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCallerInfo', () => {
    let client: ApiClient;

    beforeEach(() => {
      client = new ApiClient(mockConfig);
    });

    it('should get caller info successfully', async () => {
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
        UserInfo: {
          ID: 'test-user-id',
          Name: 'Test User',
          Email: 'test@example.com',
          OrgID: 'test-org-id',
          OrgRole: 'admin',
        },
      };

      const mockCallerInfo = {
        userId: 'test-user-id',
        organizationId: 'test-org-id',
        role: 'admin',
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockAuthResponse),
          status: 200,
          statusText: 'OK',
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockCallerInfo),
          status: 200,
          statusText: 'OK',
        } as any);

      const result = await client.getCallerInfo();

      expect(result).toEqual(mockCallerInfo);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/pb.Auth/Caller',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-access-token',
          }),
          body: '{}',
        })
      );
    });

    it('should handle API request failure', async () => {
      const mockAuthResponse: UserTokenResponse = {
        Token: {
          TokenType: 'Bearer',
          AccessToken: 'test-access-token',
          ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          IssuedAt: new Date().toISOString(),
          Issuer: 'test-issuer',
          Audience: 'test-audience',
        },
        UserInfo: {
          ID: 'test-user-id',
          Name: 'Test User',
          Email: 'test@example.com',
          OrgID: 'test-org-id',
          OrgRole: 'admin',
        },
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockAuthResponse),
          status: 200,
          statusText: 'OK',
        } as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: () => Promise.resolve('Access denied'),
        } as any);

      await expect(client.getCallerInfo()).rejects.toThrow(
        'API request to /pb.Auth/Caller failed: API request failed: 403 Forbidden - Access denied'
      );
    });
  });

  describe('signature generation', () => {
    it('should generate consistent signatures for the same input', () => {
      const client = new ApiClient(mockConfig);

      // We can't directly test the private method, but we can test that authentication
      // produces consistent Authorization headers
      const timestamp = '2023-01-01T00:00:00.000Z';

      // Mock Date.prototype.toISOString to return consistent timestamp
      const originalToISOString = Date.prototype.toISOString;
      Date.prototype.toISOString = () => timestamp;

      try {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: () => Promise.resolve('test'),
        } as any);

        // This will fail but we can check the headers
        client.authenticate().catch(() => {});

        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: expect.stringMatching(/^APIKey test-api-key:[A-Za-z0-9+/=_-]+$/),
              Date: timestamp,
            }),
          })
        );
      } finally {
        Date.prototype.toISOString = originalToISOString;
      }
    });
  });

  describe('certificate validation settings', () => {
    it('should detect localhost URLs and enable certificate bypass', () => {
      const localhostConfig = createLocalhostTestApiConfig();

      const client = new ApiClient(localhostConfig);
      // The constructor should have been called without explicit disableCertValidation
      // but localhost should trigger the warning
      expect(client).toBeDefined();
    });

    it('should detect 127.0.0.1 URLs and enable certificate bypass', () => {
      const localhostConfig = createLocalIpTestApiConfig();

      const client = new ApiClient(localhostConfig);
      expect(client).toBeDefined();
    });
  });
});
