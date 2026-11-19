/**
 * What a daily (diff-base: last-scan) scan covers: the commits since the last completed scan.
 *
 * A run keeps no memory of earlier runs; codex-security's own history lives in a state
 * directory each run starts fresh. GitHub does remember: every run records the commit it ran
 * on (head_sha), and the calling workflow's run title names the kind of scan
 * ("cynos-scan: full" or "cynos-scan: diff"). So the latest successful full or diff run
 * on the default branch is the last commit known to be covered, and a day whose scan failed is
 * folded into the next day's diff.
 *
 * That holds only if a successful run with one of those titles really scanned the code its
 * title names, so the current run's title is checked against the scan it runs (and every scan
 * fails on partial coverage). A successful run is still not
 * proof on its own: a caller's continue-on-error, or a run from before these checks, succeeds
 * without covering anything. So a starting-point run that covered its commit (a completed scan,
 * or nothing to scan) uploads the cynos-scan-covered marker artifact, and the lookup takes
 * the newest titled run that carries it.
 */
import { COVERED_ARTIFACT, TITLE_PREFIX } from './constants';

/** Run titles of scans that covered the whole repository up to their commit. */
export const COVERING_TITLES = new Set([`${TITLE_PREFIX}full`, `${TITLE_PREFIX}diff`]);
const RUNS_LOOKED_AT = 100;
/** Titled runs checked for the marker, newest first, before falling back to a full scan. */
const MARKERS_LOOKED_AT = 20;

export interface WorkflowRun {
  id: number;
  display_title: string;
  head_sha: string;
  created_at: string;
}

/** The GitHub API calls the lookup needs. */
export interface RunHistory {
  runTitle(runId: number): Promise<string>;
  successfulRuns(workflow: string, branch: string, limit: number): Promise<WorkflowRun[]>;
  /** Whether the run has an unexpired artifact with this name. */
  hasArtifact(runId: number, name: string): Promise<boolean>;
}

export interface ScanPlan {
  kind: 'diff' | 'full' | 'skip';
  /** The diff's starting commit: the last scanned commit for diff and skip, empty for full. */
  base: string;
  reason: string;
}

/** The calling workflow's file name, from GITHUB_WORKFLOW_REF. */
export function workflowFile(workflowRef: string): string {
  const match = /\/\.github\/workflows\/([^/@]+)@/.exec(workflowRef);
  if (!match?.[1]) throw new Error(`not a workflow ref: ${workflowRef}`);
  return match[1];
}

/** The run title a run of this kind must have. */
export function expectedTitle(run: {
  scope: 'repository' | 'diff';
  paths: string[];
  mock: boolean;
  dryRun: boolean;
}): string {
  const kind = run.mock
    ? 'mock'
    : run.dryRun
      ? 'dry-run'
      : run.paths.length
        ? 'paths'
        : run.scope === 'diff'
          ? 'diff'
          : 'full';
  return `${TITLE_PREFIX}${kind}`;
}

export interface TitleCheck {
  /** What is wrong with the run's title and how to fix it, or ''. */
  problem: string;
  /** Whether this run, if it succeeds, marks its commit as scanned for later last-scan diffs. */
  startingPoint: boolean;
}

/**
 * Checks the current run's title against the scan it runs.
 *
 * A successful run titled full or diff on the default branch is where the next last-scan diff
 * can start, so such a run must be the scan its title names, not a paths, mock or dry run. A
 * diff-base: last-scan run must be titled as expected too, since it finds its starting point by
 * title. Other runs need no particular title, and are not checked when the title cannot be read
 * (the job has no actions: read).
 *
 * Only a run that leaves its whole commit covered is a starting point: a full scan, or a diff
 * from the last covered commit (diff-base: last-scan). A diff from any other base covers only
 * the changes since that base, which nothing shows were scanned before.
 */
export async function checkRunTitle(
  history: RunHistory,
  runId: number,
  expected: string,
  run: { usesLastScan: boolean; onDefaultBranch: boolean }
): Promise<TitleCheck> {
  let title: string;
  try {
    title = await history.runTitle(runId);
  } catch (error) {
    if (run.usesLastScan) throw error;
    return { problem: '', startingPoint: false };
  }
  const covering = COVERING_TITLES.has(title);
  if (title !== expected && (run.usesLastScan || covering))
    return {
      problem:
        `this run is titled '${title}', not '${expected}'. A successful run titled ` +
        `'${TITLE_PREFIX}full' or '${TITLE_PREFIX}diff' marks its commit as scanned for later ` +
        'diff-base: last-scan runs, which find it by title, so the calling workflow must set run-name ' +
        `to '${TITLE_PREFIX}<full|diff|paths|mock|dry-run>' for the scan it runs; see the action's ` +
        'README for the run-name to copy',
      startingPoint: false,
    };
  const coversItsCommit = title === `${TITLE_PREFIX}full` || run.usesLastScan;
  return { problem: '', startingPoint: covering && run.onDefaultBranch && coversItsCommit };
}

/** The head commit of the latest successful full or diff scan on branch that covered it, or ''. */
export async function lastScannedCommit(
  history: RunHistory,
  workflow: string,
  branch: string,
  currentRunId: number
): Promise<string> {
  const runs = await history.successfulRuns(workflow, branch, RUNS_LOOKED_AT);
  const titled = [...runs]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .filter(run => run.id !== currentRunId && COVERING_TITLES.has(run.display_title))
    .slice(0, MARKERS_LOOKED_AT);
  for (const run of titled)
    if (await history.hasArtifact(run.id, COVERED_ARTIFACT)) return run.head_sha;
  return '';
}

/**
 * What to scan, given the last covered commit and this run's head.
 *
 * @param isAncestor Whether last is an ancestor of head: the diff last..head only means "what
 *   changed since" then; after a force-push it does not, so the scan starts over.
 */
export function plan(last: string, head: string, isAncestor: (last: string) => boolean): ScanPlan {
  if (!last)
    return {
      kind: 'full',
      base: '',
      reason: 'no earlier full or daily scan on the default branch; scanning the whole repository',
    };
  if (last === head)
    return {
      kind: 'skip',
      base: last,
      reason: `nothing new since the last scan at ${last.slice(0, 12)}`,
    };
  if (!isAncestor(last))
    return {
      kind: 'full',
      base: '',
      reason: `${last.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}; scanning the whole repository`,
    };
  return {
    kind: 'diff',
    base: last,
    reason: `changes since the last scan at ${last.slice(0, 12)}`,
  };
}
