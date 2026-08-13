import { describe, it, expect } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { checkAnthropicApiKey, classifyKeyCheckError } from '../validate-anthropic-key';

function apiError(status: number, type: string, message: string): unknown {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    new Headers()
  );
}

describe('classifyKeyCheckError', () => {
  it('treats a 401 as fatal', () => {
    const result = classifyKeyCheckError(
      apiError(401, 'authentication_error', 'invalid x-api-key')
    );

    expect(result).toMatchObject({ valid: false, fatal: true });
    expect(result.message).toContain('invalid, expired, or revoked');
  });

  it('treats a 403 as fatal', () => {
    const result = classifyKeyCheckError(
      apiError(403, 'permission_error', 'not permitted to use this model')
    );

    expect(result).toMatchObject({ valid: false, fatal: true });
    expect(result.message).toContain('403');
  });

  it('treats a credit-exhausted 400 as fatal', () => {
    const result = classifyKeyCheckError(
      apiError(
        400,
        'invalid_request_error',
        'Your credit balance is too low to access the Anthropic API.'
      )
    );

    expect(result).toMatchObject({ valid: false, fatal: true });
    expect(result.message).toContain('credit balance');
  });

  it('reports the API message rather than the raw JSON body', () => {
    const result = classifyKeyCheckError(apiError(429, 'rate_limit_error', 'slow down'));

    expect(result.message).toContain('429 slow down');
    expect(result.message).not.toContain('{');
  });

  it('does not fail on an unrelated 400', () => {
    const result = classifyKeyCheckError(
      apiError(400, 'invalid_request_error', 'limit: must be less than or equal to 1000')
    );

    expect(result).toMatchObject({ valid: false, fatal: false });
  });

  it('does not fail on a 429 — the key is valid, just rate limited', () => {
    const result = classifyKeyCheckError(apiError(429, 'rate_limit_error', 'rate limit exceeded'));

    expect(result).toMatchObject({ valid: false, fatal: false });
    expect(result.message).toContain('continuing');
  });

  it('does not fail on a 500 from Anthropic', () => {
    const result = classifyKeyCheckError(apiError(500, 'api_error', 'internal server error'));

    expect(result).toMatchObject({ valid: false, fatal: false });
  });

  it('does not fail on a network error', () => {
    const result = classifyKeyCheckError(
      new Anthropic.APIConnectionError({ message: 'Connection error.' })
    );

    expect(result).toMatchObject({ valid: false, fatal: false });
  });

  it('does not fail on a non-Error rejection', () => {
    const result = classifyKeyCheckError('boom');

    expect(result).toMatchObject({ valid: false, fatal: false });
    expect(result.message).toContain('boom');
  });
});

describe('checkAnthropicApiKey', () => {
  it('reports a valid key when the API accepts it', async () => {
    let seenKey = '';
    const result = await checkAnthropicApiKey('sk-ant-valid', async key => {
      seenKey = key;
    });

    expect(seenKey).toBe('sk-ant-valid');
    expect(result).toMatchObject({ valid: true, fatal: false });
  });

  it('fails fatally on a missing key without calling the API', async () => {
    let called = false;
    const result = await checkAnthropicApiKey('', async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ valid: false, fatal: true });
    expect(result.message).toContain('No Anthropic API key');
  });

  it('fails fatally on a whitespace-only key', async () => {
    const result = await checkAnthropicApiKey('   ', async () => {
      throw new Error('should not be called');
    });

    expect(result).toMatchObject({ valid: false, fatal: true });
  });

  it('fails fatally on an expired key', async () => {
    const result = await checkAnthropicApiKey('sk-ant-expired', async () => {
      throw apiError(401, 'authentication_error', 'invalid x-api-key');
    });

    expect(result).toMatchObject({ valid: false, fatal: true });
  });

  it('does not fail when Anthropic is unreachable', async () => {
    const result = await checkAnthropicApiKey('sk-ant-valid', async () => {
      throw new Anthropic.APIConnectionError({ message: 'Connection error.' });
    });

    expect(result).toMatchObject({ valid: false, fatal: false });
  });
});
