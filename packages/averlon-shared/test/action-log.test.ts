import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as core from '@actions/core';
import {
  configureActionLogging,
  isVerboseLoggingEnabled,
  logDebug,
  logVerbose,
  logInfo,
} from '../src/action-log';

describe('action-log', () => {
  let debugSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;
  let isDebugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    debugSpy = spyOn(core, 'debug').mockImplementation(() => {});
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    debugSpy.mockClear();
    infoSpy.mockClear();
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    debugSpy?.mockRestore();
    infoSpy?.mockRestore();
    isDebugSpy?.mockRestore();
  });

  test('logDebug always uses core.debug', () => {
    logDebug('trace');

    expect(debugSpy).toHaveBeenCalledWith('trace');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('logVerbose uses debug when verbose is off and runner debug is off', () => {
    isDebugSpy = spyOn(core, 'isDebug').mockReturnValue(false);

    configureActionLogging({ verbose: false });
    logVerbose('detail');

    expect(debugSpy).toHaveBeenCalledWith('detail');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('logVerbose uses info when verbose input is enabled', () => {
    configureActionLogging({ verbose: true });
    expect(isVerboseLoggingEnabled()).toBe(true);
    logVerbose('detail');

    expect(infoSpy).toHaveBeenCalledWith('detail');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test('logInfo always uses core.info', () => {
    logInfo('milestone');
    expect(infoSpy).toHaveBeenCalledWith('milestone');
  });
});
