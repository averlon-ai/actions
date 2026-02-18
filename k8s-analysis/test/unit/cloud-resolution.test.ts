import { describe, it, expect, mock } from 'bun:test';
import { resolveCloudIdIfNeeded } from '../../src/cloud-id';

describe('cloud id resolution', () => {
  it('returns provided cloud-id without triggering lookup', async () => {
    const getCloud = mock(() => Promise.resolve(undefined));
    const result = await resolveCloudIdIfNeeded({
      client: { getCloud } as any,
      providedCloudId: 'cloud-override',
    });

    expect(result).toBe('cloud-override');
    expect(getCloud).not.toHaveBeenCalled();
  });

  it('returns undefined when no account id detected', async () => {
    const result = await resolveCloudIdIfNeeded({
      client: { getCloud: async () => undefined } as any,
    });
    expect(result).toBeUndefined();
  });

  it('calls GetCloud with normalized AWS account id (digits only)', async () => {
    const getCloud = mock(async () => ({
      id: 'cloud-b',
      accountId: '123456789012',
    }));

    const result = await resolveCloudIdIfNeeded({
      client: { getCloud } as any,
      detectedAccountId: '1234-5678-9012',
    });

    expect(getCloud).toHaveBeenCalledWith({ AccountID: '123456789012' });
    expect(result).toBe('cloud-b');
  });

  it('calls GetCloud with Azure subscription ID (UUID) unchanged', async () => {
    const getCloud = mock(async () => ({
      id: 'cloud-azure',
      accountId: '950f0467-7b8a-4993-b65e-5863bb07d5b9',
    }));

    const azureSubscriptionId = '950f0467-7b8a-4993-b65e-5863bb07d5b9';
    const result = await resolveCloudIdIfNeeded({
      client: { getCloud } as any,
      detectedAccountId: azureSubscriptionId,
    });

    expect(getCloud).toHaveBeenCalledWith({ AccountID: azureSubscriptionId });
    expect(result).toBe('cloud-azure');
  });

  it('returns undefined when GetCloud yields no result', async () => {
    const result = await resolveCloudIdIfNeeded({
      client: { getCloud: async () => undefined } as any,
      detectedAccountId: '123456789012',
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when GetCloud call fails', async () => {
    const failingClient = {
      getCloud: async () => {
        throw new Error('network error');
      },
    };

    const result = await resolveCloudIdIfNeeded({
      client: failingClient as any,
      detectedAccountId: '123456789012',
    });
    expect(result).toBeUndefined();
  });
});
