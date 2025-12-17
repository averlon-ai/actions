import type { ApiConfig } from '@averlon/shared/api-client';

/**
 * Factory function to create test API configuration objects.
 * This reduces duplication across test files and ensures consistency.
 */
export function createTestApiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://test.example.com',
    ...overrides,
  };
}

/**
 * Creates a test config with disabled certificate validation.
 */
export function createTestApiConfigWithDisabledCerts(
  overrides: Partial<ApiConfig> = {}
): ApiConfig {
  return createTestApiConfig({
    disableCertValidation: true,
    ...overrides,
  });
}

/**
 * Creates a test config for localhost testing.
 */
export function createLocalhostTestApiConfig(
  port: number = 8080,
  overrides: Partial<ApiConfig> = {}
): ApiConfig {
  return createTestApiConfig({
    baseUrl: `https://localhost:${port}`,
    ...overrides,
  });
}

/**
 * Creates a test config for 127.0.0.1 testing.
 */
export function createLocalIpTestApiConfig(
  port: number = 3000,
  overrides: Partial<ApiConfig> = {}
): ApiConfig {
  return createTestApiConfig({
    baseUrl: `https://127.0.0.1:${port}`,
    ...overrides,
  });
}
