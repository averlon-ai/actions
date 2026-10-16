import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import {
  ApiClient,
  ApiRequestError,
  parseRetryAfterMs,
  type ApiConfig,
  type UserTokenResponse,
} from '../../src/api-client';

const mockFetch = mock(() => Promise.resolve(jsonResponse(200, {})));

global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'OK',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

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

const tooManyRequests = 'You have reached maximum request limit.';

class TestApiClient extends ApiClient {
  waits: number[] = [];
  protected override async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

describe('ApiClient rate limit retry', () => {
  const config: ApiConfig = {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://wfe.prod.averlon.io',
  };
  const request = { CodeDefectID: 'cd-1', Status: 3, Feedback: '' };

  beforeEach(() => {
    mockFetch.mockReset();
    spyOn(core, 'info').mockImplementation(() => {});
    spyOn(core, 'debug').mockImplementation(() => {});
    spyOn(core, 'setSecret').mockImplementation(() => {});
  });

  it('retries a 429 and returns the next successful response', async () => {
    const client = new TestApiClient(config);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, authResponse))
      .mockResolvedValueOnce(jsonResponse(429, tooManyRequests))
      .mockResolvedValueOnce(jsonResponse(429, tooManyRequests))
      .mockResolvedValueOnce(jsonResponse(200, { ID: 'cd-1' }));

    const result = await client.updateCodeDefectFeedback(request);

    expect(result).toEqual({ ID: 'cd-1' } as never);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(client.waits).toHaveLength(2);
    expect(client.waits[0]).toBeGreaterThanOrEqual(1000);
    expect(client.waits[0]).toBeLessThan(2000);
    expect(client.waits[1]).toBeGreaterThanOrEqual(2000);
    expect(client.waits[1]).toBeLessThan(4000);
  });

  it('waits for Retry-After when the server sends it', async () => {
    const client = new TestApiClient(config);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, authResponse))
      .mockResolvedValueOnce(jsonResponse(429, tooManyRequests, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(jsonResponse(200, { ID: 'cd-1' }));

    await client.updateCodeDefectFeedback(request);

    expect(client.waits).toEqual([3000]);
  });

  it('gives up without waiting when Retry-After is too long', async () => {
    const client = new TestApiClient(config);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, authResponse))
      .mockResolvedValueOnce(jsonResponse(429, tooManyRequests, { 'Retry-After': '600' }));

    await expect(client.updateCodeDefectFeedback(request)).rejects.toThrow('429');
    expect(client.waits).toEqual([]);
  });

  it('throws the 429 error after the last attempt', async () => {
    const client = new TestApiClient(config);
    mockFetch.mockResolvedValueOnce(jsonResponse(200, authResponse));
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce(jsonResponse(429, tooManyRequests));
    }

    const error = await client.updateCodeDefectFeedback(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(429);
    expect((error as ApiRequestError).message).toContain(
      `429 Too Many Requests - ${tooManyRequests}`
    );
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(client.waits).toHaveLength(5);
    expect(Math.max(...client.waits)).toBeLessThanOrEqual(30000);
  });

  it('does not retry other errors', async () => {
    const client = new TestApiClient(config);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, authResponse))
      .mockResolvedValueOnce({ ...jsonResponse(500, 'boom'), ok: false } as Response);

    await expect(client.updateCodeDefectFeedback(request)).rejects.toThrow('500');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(client.waits).toEqual([]);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
  });

  it('parses an HTTP-date', () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(parseRetryAfterMs('Fri, 09 Oct 2026 00:00:04 GMT', now)).toBe(4000);
  });

  it('returns undefined for a missing or invalid header', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});
