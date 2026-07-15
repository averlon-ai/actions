import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import { ApiClient, type ApiConfig, type UserTokenResponse } from '../../src/api-client';

const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
    statusText: 'OK',
  })
);

global.fetch = mockFetch as typeof fetch;

const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

describe('ApiClient proxy support', () => {
  const config: ApiConfig = {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://wfe.prod.averlon.io/',
  };

  beforeEach(() => {
    mockFetch.mockClear();
    spyOn(core, 'info').mockImplementation(() => {});
    spyOn(core, 'debug').mockImplementation(() => {});
    spyOn(core, 'setSecret').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of PROXY_ENV_VARS) {
      delete process.env[key];
    }
  });

  it('does not attach a proxy dispatcher when proxy env vars are unset', async () => {
    const client = new ApiClient(config);
    const authResponse: UserTokenResponse = {
      Token: {
        TokenType: 'Bearer',
        AccessToken: 'token',
        ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        IssuedAt: new Date().toISOString(),
        Issuer: 'issuer',
        Audience: 'audience',
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authResponse),
      status: 200,
      statusText: 'OK',
    } as Response);

    await client.authenticate();

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchOptions.dispatcher).toBeUndefined();
  });

  it('attaches a proxy dispatcher when HTTP_PROXY is set', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';

    const client = new ApiClient(config);
    const authResponse: UserTokenResponse = {
      Token: {
        TokenType: 'Bearer',
        AccessToken: 'token',
        ExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        IssuedAt: new Date().toISOString(),
        Issuer: 'issuer',
        Audience: 'audience',
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authResponse),
      status: 200,
      statusText: 'OK',
    } as Response);

    await client.authenticate();

    const [, fetchOptions] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { dispatcher?: unknown },
    ];
    expect(fetchOptions.dispatcher).toBeDefined();
  });
});
