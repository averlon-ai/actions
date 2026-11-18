import { describe, it, expect } from 'bun:test';
import {
  checkRunTitle,
  expectedTitle,
  lastScannedCommit,
  plan,
  workflowFile,
  type RunHistory,
  type WorkflowRun,
} from '../last-scanned';
import { defaultBranch, requiredReportsPresent, withCommentedPullRequest } from '../main';
import type { EventContext } from '../target';

const HEAD = 'c'.repeat(40);

/** A run history; marked holds the runs carrying the cynos-scan-covered artifact. */
function history(
  runs: WorkflowRun[],
  title = 'cynos-scan: diff',
  marked: number[] = runs.map(run => run.id)
): RunHistory & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async runTitle() {
      return title;
    },
    async successfulRuns(workflow, branch) {
      asked.push(`${workflow}@${branch}`);
      return runs;
    },
    async hasArtifact(runId, name) {
      return name === 'cynos-scan-covered' && marked.includes(runId);
    },
  };
}

const run = (id: number, title: string, sha: string, created: string): WorkflowRun => ({
  id,
  display_title: title,
  head_sha: sha,
  created_at: created,
});
describe('last-scanned lookup', () => {
  it('reads the workflow file from GITHUB_WORKFLOW_REF', () => {
    expect(
      workflowFile('averlon-security/kca/.github/workflows/cynos-scan.yml@refs/heads/main')
    ).toBe('cynos-scan.yml');
  });

  it.each([
    ['a repository scan', { scope: 'repository' }, 'cynos-scan: full'],
    ['a diff scan', { scope: 'diff' }, 'cynos-scan: diff'],
    ['a paths scan', { scope: 'repository', paths: ['functions'] }, 'cynos-scan: paths'],
    ['a mock scan', { scope: 'diff', mock: true }, 'cynos-scan: mock'],
    ['a dry run', { scope: 'repository', dryRun: true }, 'cynos-scan: dry-run'],
    ['a mock dry run', { scope: 'repository', dryRun: true, mock: true }, 'cynos-scan: mock'],
  ] as const)('titles %s %s', (_, run, title) => {
    expect(expectedTitle({ paths: [], mock: false, dryRun: false, ...run })).toBe(title);
  });

  const lastScan = { usesLastScan: true, onDefaultBranch: true };
  const noLastScan = { usesLastScan: false, onDefaultBranch: true };

  it('explains a last-scan run without the expected run-name', async () => {
    const { problem } = await checkRunTitle(
      history([], 'cynos-scan scan'),
      9,
      'cynos-scan: diff',
      lastScan
    );
    expect(problem).toContain("titled 'cynos-scan scan', not 'cynos-scan: diff'");
    expect(problem).toContain('run-name');
    expect(await checkRunTitle(history([]), 9, 'cynos-scan: diff', lastScan)).toEqual({
      problem: '',
      startingPoint: true,
    });
  });

  it.each([
    ['a paths scan', 'cynos-scan: paths'],
    ['a mock scan', 'cynos-scan: mock'],
    ['a dry run', 'cynos-scan: dry-run'],
  ])('refuses %s titled as a full scan', async (_, expected) => {
    const { problem } = await checkRunTitle(
      history([], 'cynos-scan: full'),
      9,
      expected,
      noLastScan
    );
    expect(problem).toContain(`titled 'cynos-scan: full', not '${expected}'`);
  });

  it.each(['cynos-scan: diff', 'cynos-scan: mock'])(
    "accepts a pull request's run titled cynos-scan: pr for %s, and never as a starting point",
    async expected => {
      expect(await checkRunTitle(history([], 'cynos-scan: pr'), 9, expected, noLastScan)).toEqual({
        problem: '',
        startingPoint: false,
      });
    }
  );

  it('makes a diff a starting point only from the last covered commit', async () => {
    // A diff from any other base (here, an empty diff from HEAD) covers only its changes.
    const diff = history([], 'cynos-scan: diff');
    expect(await checkRunTitle(diff, 9, 'cynos-scan: diff', noLastScan)).toEqual({
      problem: '',
      startingPoint: false,
    });
    expect(await checkRunTitle(diff, 9, 'cynos-scan: diff', lastScan)).toEqual({
      problem: '',
      startingPoint: true,
    });
  });

  it('makes a full or diff run on the default branch a starting point', async () => {
    const full = history([], 'cynos-scan: full');
    expect(await checkRunTitle(full, 9, 'cynos-scan: full', noLastScan)).toEqual({
      problem: '',
      startingPoint: true,
    });
    expect(
      await checkRunTitle(full, 9, 'cynos-scan: full', {
        ...noLastScan,
        onDefaultBranch: false,
      })
    ).toEqual({ problem: '', startingPoint: false });
  });

  it('leaves other run titles alone unless the run uses last-scan', async () => {
    const other = history([], 'nightly security');
    expect(await checkRunTitle(other, 9, 'cynos-scan: paths', noLastScan)).toEqual({
      problem: '',
      startingPoint: false,
    });
    const unreadable: RunHistory = {
      ...other,
      async runTitle() {
        throw new Error('Resource not accessible by integration');
      },
    };
    expect(await checkRunTitle(unreadable, 9, 'cynos-scan: full', noLastScan)).toEqual({
      problem: '',
      startingPoint: false,
    });
    await expect(checkRunTitle(unreadable, 9, 'cynos-scan: diff', lastScan)).rejects.toThrow(
      'Resource not accessible'
    );
  });

  it('starts from the newest full or diff scan, never a mock, a paths run or this run', async () => {
    const runs = [
      run(9, 'cynos-scan: diff', HEAD, '2026-10-15T03:00:00Z'),
      run(8, 'cynos-scan: mock', 'd'.repeat(40), '2026-10-14T05:00:00Z'),
      run(7, 'cynos-scan: paths', 'e'.repeat(40), '2026-10-14T04:00:00Z'),
      run(6, 'cynos-scan: full', 'a'.repeat(40), '2026-10-01T04:00:00Z'),
      run(5, 'cynos-scan: diff', 'b'.repeat(40), '2026-10-13T03:00:00Z'),
    ];
    const runHistory = history(runs);
    expect(await lastScannedCommit(runHistory, 'cynos-scan.yml', 'main', 9)).toBe('b'.repeat(40));
    expect(runHistory.asked).toEqual(['cynos-scan.yml@main']);
    expect(await lastScannedCommit(history([]), 'cynos-scan.yml', 'main', 9)).toBe('');
  });

  it('skips a successful run that did not mark its commit as covered', async () => {
    // e.g. a scan that failed under continue-on-error, or a run from before the marker existed.
    const runs = [
      run(5, 'cynos-scan: diff', 'b'.repeat(40), '2026-10-13T03:00:00Z'),
      run(4, 'cynos-scan: full', 'a'.repeat(40), '2026-10-01T04:00:00Z'),
    ];
    expect(await lastScannedCommit(history(runs, 'x', [4]), 'cynos-scan.yml', 'main', 9)).toBe(
      'a'.repeat(40)
    );
    expect(await lastScannedCommit(history(runs, 'x', []), 'cynos-scan.yml', 'main', 9)).toBe('');
  });

  it.each([
    ['', true, 'full'],
    [HEAD, true, 'skip'],
    ['a'.repeat(40), true, 'diff'],
    ['a'.repeat(40), false, 'full'],
  ])('plans from %s (ancestor %s) to %s', (last, ancestor, kind) => {
    expect(plan(last, HEAD, () => ancestor).kind).toBe(kind as 'full' | 'skip' | 'diff');
  });
});

describe('defaultBranch', () => {
  it('reads the default branch from the event, and asks the API only when it is missing', async () => {
    let asked = 0;
    const api = async () => {
      asked += 1;
      return { default_branch: 'develop' };
    };
    expect(await defaultBranch({ repository: { default_branch: 'master' } }, api)).toBe('master');
    expect(asked).toBe(0);
    expect(await defaultBranch({ schedule: '0 3 * * *' }, api)).toBe('develop');
    expect(asked).toBe(1);
  });
});

describe('withCommentedPullRequest', () => {
  const base: EventContext = {
    eventName: 'issue_comment',
    repository: 'averlon-security/kca',
    sha: HEAD,
    ref: 'refs/heads/main',
    serverUrl: 'https://github.com',
    payload: { issue: { number: 7, pull_request: { url: 'u' } }, comment: { body: 'cynos scan' } },
  };

  it('fetches the pull request an issue_comment names only by number', async () => {
    const asked: number[] = [];
    const event = await withCommentedPullRequest(base, async number => {
      asked.push(number);
      return { number, state: 'open' };
    });
    expect(asked).toEqual([7]);
    expect(event.commentedPullRequest).toEqual({ number: 7, state: 'open' });
  });

  it('fetches nothing for a comment on an issue, or on any other event', async () => {
    const never = async (): Promise<unknown> => {
      throw new Error('not expected');
    };
    const onIssue = { ...base, payload: { issue: { number: 7 } } };
    expect((await withCommentedPullRequest(onIssue, never)).commentedPullRequest).toBeUndefined();
    const schedule = { ...base, eventName: 'schedule' };
    expect((await withCommentedPullRequest(schedule, never)).commentedPullRequest).toBeUndefined();
  });
});

describe('requiredReportsPresent', () => {
  it('requires the manifest and the findings, not the coverage report upstream 0.8 no longer writes', () => {
    const manifest = { 'scan-manifest.json': '/r/scan-manifest.json' };
    const findings = { 'findings.json': '/r/findings.json' };
    expect(requiredReportsPresent({ ...manifest, ...findings })).toBe(true);
    expect(requiredReportsPresent(manifest)).toBe(false);
    expect(requiredReportsPresent(findings)).toBe(false);
  });
});
