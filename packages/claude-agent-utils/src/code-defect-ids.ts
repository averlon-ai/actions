import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logWarn } from '@averlon/github-actions-utils';

/**
 * Writes the IDs of all code defects of the run to a new file under
 * RUNNER_TEMP and returns its path, for the Submit Agent Feedback step
 * (ALL_CODE_DEFECT_IDS_FILE). A long list does not fit in one environment
 * variable: Linux limits one to 128 KiB.
 */
export function writeCodeDefectIdsFile(ids: string[]): string {
  const dir = fs.mkdtempSync(
    path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'averlon-code-defects-')
  );
  const file = path.join(dir, 'ids');
  fs.writeFileSync(file, ids.join(','), 'utf8');
  return file;
}

/**
 * Returns the IDs of all code defects of the run: from the file in
 * ALL_CODE_DEFECT_IDS_FILE, else from ALL_CODE_DEFECT_IDS. Comma-separated.
 */
export function readAllCodeDefectIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env['ALL_CODE_DEFECT_IDS_FILE'];
  let raw = env['ALL_CODE_DEFECT_IDS'] || '';
  if (file) {
    if (!fs.existsSync(file)) {
      logWarn(`Code defect ID file ${file} not found`);
      return [];
    }
    raw = fs.readFileSync(file, 'utf8');
  }
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
