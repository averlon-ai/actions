import * as core from '@actions/core';
import type { ApiClient } from '@averlon/shared';

export async function resolveCloudIdIfNeeded(options: {
  client: ApiClient;
  providedCloudId?: string;
  detectedAccountId?: string;
}): Promise<string | undefined> {
  const { client, providedCloudId, detectedAccountId } = options;

  if (providedCloudId) {
    return providedCloudId;
  }

  if (!detectedAccountId) {
    core.warning(
      'Cloud ID input not provided and no AWS account ID detected. Provide the cloud-id input to enable issue lookup.'
    );
    return undefined;
  }

  const normalizedAccountId = normalizeAccountId(detectedAccountId);
  if (!normalizedAccountId) {
    core.warning(
      `Detected account ID "${detectedAccountId}" is invalid. Provide the cloud-id input to enable issue lookup.`
    );
    return undefined;
  }

  core.info('cloud-id not provided; attempting discovery via GetCloud...');
  try {
    const cloud = await client.getCloud({
      AccountID: normalizedAccountId,
    });

    if (!cloud) {
      core.warning(
        'GetCloud returned no cloud. Provide the cloud-id input to enable issue lookup.'
      );
      return undefined;
    }

    const descriptor = cloud.name ? `${cloud.id} (${cloud.name})` : cloud.id;
    core.info(`Resolved cloud-id via GetCloud: ${descriptor}`);
    return cloud.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to fetch cloud via GetCloud: ${message}`);
    return undefined;
  }
}

function normalizeAccountId(accountId?: string): string | undefined {
  if (!accountId) {
    return undefined;
  }
  const normalized = accountId.replace(/\D/g, '');
  return normalized || accountId.trim() || undefined;
}
