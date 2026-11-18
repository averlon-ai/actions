/**
 * The run's evidence: what each helper was given and what it saved, kept after the workspace is
 * discarded.
 *
 * Explaining a scan's misses and false positives needs the briefs, checklists, index and threat
 * model the helpers worked from, the result each helper saved, and the architecture review's own
 * log. They live in the stage, which every run discards; rebuilding them for one review of
 * secdi-ai-harness took 570 MB of gateway payloads. So a run copies them out first:
 *
 *   knowledge-base/output       the lead's index and the threat model
 *   knowledge-base/kb           every brief and checklist, the file and function index, the reader
 *   knowledge-base/*.json|.txt  the architecture review's debug record and evidence pack
 *   knowledge-base/review       the review agent's checklist, event log and answer (not its home,
 *                               which holds Codex session state)
 *   out/scan/artifacts/helpers  each helper's saved result, from the scan dir (ScanResult.scanDir),
 *                               under the name the docker runtime's scan dir has in the stage
 *
 * The copy goes to RUNNER_TEMP (kept for a local run), and is uploaded as an artifact when
 * upload-evidence allows: it holds source excerpts and unfixed findings, so by default only for a
 * private repository. Only a leak-clean stage is copied (main.ts checks it for both keys).
 */
import { DefaultArtifactClient } from '@actions/artifact';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const KNOWLEDGE_BASE = 'knowledge-base';
const REVIEW_FILES = ['checklist.json', 'events.jsonl', 'answer.txt'];
/** The scan dir's place in the evidence, and in the stage on the docker runtime. */
const SCAN_DIR = join('out', 'scan');
const HELPER_RESULTS = join('artifacts', 'helpers');

/** One evidence file: where it is, and its path in the evidence. */
interface EvidenceFile {
  source: string;
  path: string;
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The evidence of a stage and its scan dir. The knowledge base is the stage's; the helper results
 * are the scan dir's, which the native runtime keeps outside <stage>/out.
 */
function evidence(stage: string, scanDir: string): EvidenceFile[] {
  const kb = join(stage, KNOWLEDGE_BASE);
  const top = existsSync(kb)
    ? readdirSync(kb)
        .filter(name => /\.(json|txt)$/.test(name))
        .map(name => join(kb, name))
    : [];
  const fromStage = [
    ...walk(join(kb, 'output')),
    ...walk(join(kb, 'kb')),
    ...top,
    ...REVIEW_FILES.map(name => join(kb, 'review', name)).filter(p => existsSync(p)),
  ].map(source => ({ source, path: relative(stage, source) }));
  const fromScanDir = walk(join(scanDir, HELPER_RESULTS)).map(source => ({
    source,
    path: join(SCAN_DIR, relative(scanDir, source)),
  }));
  return [...fromStage, ...fromScanDir];
}

/** The evidence files of a stage and its scan dir (default <stage>/out/scan), as absolute paths. */
export function evidenceFiles(stage: string, scanDir = join(stage, SCAN_DIR)): string[] {
  return evidence(stage, scanDir).map(file => file.source);
}

/** Copies the evidence to `destination` with its paths in the evidence; returns the copies. */
export function keepEvidence(
  stage: string,
  destination: string,
  scanDir = join(stage, SCAN_DIR)
): string[] {
  return evidence(stage, scanDir).map(({ source, path }) => {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target);
    return target;
  });
}

/** Whether to upload: always, never, or (auto) only for a private repository. */
export function shouldUploadEvidence(
  setting: 'auto' | 'true' | 'false',
  privateRepository: boolean | undefined
): boolean {
  return setting === 'true' || (setting === 'auto' && privateRepository === true);
}

export async function uploadEvidence(
  directory: string,
  files: string[],
  name: string,
  retentionDays: number
): Promise<void> {
  await new DefaultArtifactClient().uploadArtifact(name, files, directory, { retentionDays });
}
