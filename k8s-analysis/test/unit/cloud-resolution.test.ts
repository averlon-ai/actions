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

  it('calls GetCloud with normalized account id', async () => {
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
