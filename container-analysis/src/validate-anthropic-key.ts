import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';

const CHECK_TIMEOUT_MS = 15_000;
const CHECK_MAX_RETRIES = 1;

const HELP = 'Update the anthropic-api-key secret with a valid Anthropic API key and re-run.';

export interface KeyCheckResult {
  valid: boolean;
  fatal: boolean;
  message: string;
}

function errorDetail(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { message?: unknown } } | undefined;
    const message = body?.error?.message;
    if (typeof message === 'string' && message) {
      return error.status ? `${error.status} ${message}` : message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function isBillingFailure(detail: string): boolean {
  return /credit balance|billing|insufficient (funds|credit)|payment/i.test(detail);
}

export function classifyKeyCheckError(error: unknown): KeyCheckResult {
  const detail = errorDetail(error);

  if (error instanceof Anthropic.AuthenticationError) {
    return {
      valid: false,
      fatal: true,
      message: `The Anthropic API key was rejected (401): it is invalid, expired, or revoked. ${HELP}`,
    };
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    return {
      valid: false,
      fatal: true,
      message: `The Anthropic API key is not permitted to use this API (403). ${HELP}`,
    };
  }

  if (error instanceof Anthropic.BadRequestError && isBillingFailure(detail)) {
    return {
      valid: false,
      fatal: true,
      message: `The Anthropic API key cannot be used. Top up the account's credit balance and re-run. Detail: ${detail}`,
    };
  }

  if (error instanceof Anthropic.RateLimitError) {
    return {
      valid: false,
      fatal: false,
      message: `Anthropic rate-limited the API key check (429). The key itself looks valid; continuing. Detail: ${detail}`,
    };
  }

  return {
    valid: false,
    fatal: false,
    message: `Could not verify the Anthropic API key (treating as usable): ${detail}`,
  };
}

export type KeyVerifier = (apiKey: string) => Promise<unknown>;

const verifyWithAnthropic: KeyVerifier = async apiKey => {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    timeout: CHECK_TIMEOUT_MS,
    maxRetries: CHECK_MAX_RETRIES,
  });
  await client.models.list({ limit: 1 });
};

export async function checkAnthropicApiKey(
  apiKey: string,
  verify: KeyVerifier = verifyWithAnthropic
): Promise<KeyCheckResult> {
  if (!apiKey.trim()) {
    return {
      valid: false,
      fatal: true,
      message: `No Anthropic API key was provided. ${HELP}`,
    };
  }

  try {
    await verify(apiKey);
    return { valid: true, fatal: false, message: 'Anthropic API key is valid' };
  } catch (error) {
    return classifyKeyCheckError(error);
  }
}

async function run(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] || '';
  const stage =
    process.env['ANTHROPIC_KEY_CHECK_STAGE'] === 'post-agent' ? 'post-agent' : 'preflight';

  if (apiKey) {
    core.setSecret(apiKey);
  }

  core.info(
    stage === 'preflight'
      ? 'Validating Anthropic API key...'
      : 'Coding Agent failed; re-validating Anthropic API key...'
  );

  const result = await checkAnthropicApiKey(apiKey);

  if (result.fatal) {
    core.setFailed(
      stage === 'preflight'
        ? result.message
        : `The Coding Agent failed and the Anthropic API key is no longer usable. ${result.message}`
    );
    return;
  }

  if (result.valid) {
    core.info(result.message);
  } else {
    core.warning(result.message);
  }
}

export { run };

if (require.main === module) {
  run();
}
