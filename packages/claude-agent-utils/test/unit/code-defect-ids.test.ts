import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readAllCodeDefectIds, writeCodeDefectIdsFile } from '../../src/code-defect-ids';

describe('code defect ID file', () => {
  let runnerTemp: string;
  let originalRunnerTemp: string | undefined;

  beforeEach(() => {
    originalRunnerTemp = process.env['RUNNER_TEMP'];
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
    process.env['RUNNER_TEMP'] = runnerTemp;
  });

  afterEach(() => {
    if (originalRunnerTemp === undefined) {
      delete process.env['RUNNER_TEMP'];
    } else {
      process.env['RUNNER_TEMP'] = originalRunnerTemp;
    }
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  });

  it('writes a new file under RUNNER_TEMP that the feedback step reads back', () => {
    // 19-digit IDs, more than one environment variable can hold
    const ids = Array.from({ length: 10000 }, (_, i) => `9${String(i).padStart(18, '0')}`);

    const file = writeCodeDefectIdsFile(ids);
    const second = writeCodeDefectIdsFile(['1']);

    expect(file.startsWith(runnerTemp + path.sep)).toBe(true);
    expect(second).not.toBe(file);
    expect(readAllCodeDefectIds({ ALL_CODE_DEFECT_IDS_FILE: file })).toEqual(ids);
  });

  it('reads the file before the environment variable', () => {
    const file = writeCodeDefectIdsFile(['1', '2']);

    expect(
      readAllCodeDefectIds({ ALL_CODE_DEFECT_IDS_FILE: file, ALL_CODE_DEFECT_IDS: '3' })
    ).toEqual(['1', '2']);
    expect(readAllCodeDefectIds({ ALL_CODE_DEFECT_IDS: ' 3, ,4 ' })).toEqual(['3', '4']);
    expect(readAllCodeDefectIds({})).toEqual([]);
  });

  it('reads no IDs from a missing file', () => {
    expect(
      readAllCodeDefectIds({ ALL_CODE_DEFECT_IDS_FILE: path.join(runnerTemp, 'missing') })
    ).toEqual([]);
  });

  it('writes an empty list', () => {
    expect(readAllCodeDefectIds({ ALL_CODE_DEFECT_IDS_FILE: writeCodeDefectIdsFile([]) })).toEqual(
      []
    );
  });
});
