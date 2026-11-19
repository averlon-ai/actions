/**
 * The run's artifacts: the reports a caller asked to keep, and the threat model handed from the
 * scan job to the update-threat-model job.
 *
 * Only the reports that passed validation are uploaded, from the action's own copies
 * (reports.ts), as upstream does, plus this action's run record, versions and issues. Never
 * Codex's state: its session logs hold full transcripts and can hold credentials.
 */
import { DefaultArtifactClient } from '@actions/artifact';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COVERED_ARTIFACT } from './constants';
import { isFile, type ValidatedReports } from '@averlon-ai/cynos-scan-engine';

export const THREAT_MODEL_ARTIFACT = 'cynos-scan-threat-model';

/**
 * The files to upload: the validated reports when they may be published (resultsAvailable), as
 * upstream uploads only the reports it published, then the action's records that exist, which
 * explain a failed scan too.
 */
export function reportFiles(
  stage: string,
  reports: ValidatedReports,
  available: boolean
): string[] {
  const records = ['run.json', 'versions.json', 'issues.json'].map(name => join(stage, name));
  return [...(available ? Object.values(reports.paths) : []), ...records.filter(isFile)];
}

export async function uploadReports(
  stage: string,
  reports: ValidatedReports,
  available: boolean,
  name: string,
  retentionDays: number
): Promise<void> {
  const files = reportFiles(stage, reports, available);
  if (!files.length) throw new Error('Artifact upload requested, but no reports are available.');
  await new DefaultArtifactClient().uploadArtifact(name, files, stage, { retentionDays });
}

export async function uploadThreatModel(reports: ValidatedReports): Promise<void> {
  const path = reports.paths['threatmodel.md'];
  if (!path) throw new Error('The full scan wrote no valid threatmodel.md.');
  await new DefaultArtifactClient().uploadArtifact(
    THREAT_MODEL_ARTIFACT,
    [path],
    reports.directory,
    {
      retentionDays: 7,
    }
  );
}

/**
 * Marks this run as having covered scannedSha, for later diff-base: last-scan runs
 * (last-scanned.ts). It holds no report, only the commit and how it was covered, and outlives
 * the monthly full scan's interval.
 */
export async function uploadCoveredMarker(scannedSha: string, coveredBy: string): Promise<void> {
  const directory = mkdtempSync(
    join(process.env['RUNNER_TEMP'] || tmpdir(), 'cynos-scan-covered-')
  );
  const path = join(directory, 'covered.json');
  writeFileSync(path, `${JSON.stringify({ scanned_sha: scannedSha, covered_by: coveredBy })}\n`);
  await new DefaultArtifactClient().uploadArtifact(COVERED_ARTIFACT, [path], directory, {
    retentionDays: 35,
  });
}

/** Downloads this run's threat model into directory; returns the file's path. */
export async function downloadThreatModel(directory: string): Promise<string> {
  const client = new DefaultArtifactClient();
  const { artifact } = await client.getArtifact(THREAT_MODEL_ARTIFACT);
  await client.downloadArtifact(artifact.id, { path: directory });
  return join(directory, 'threatmodel.md');
}
