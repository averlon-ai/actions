import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as core from '@actions/core';
import { run } from '../../src/main';

describe('k8s-analysis action', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let setFailedSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    setFailedSpy = spyOn(core, 'setFailed').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    setFailedSpy.mockRestore();
  });

  it('should handle errors gracefully', async () => {
    // This test will fail because inputs are not set, but it should handle the error
    await run();

    expect(setFailedSpy).toHaveBeenCalled();
  });
});
