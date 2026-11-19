import { describe, it, expect, mock } from 'bun:test';
import { getExistingState } from '../src/sync';
import { embedBatchStateInBody } from '../src/state';
import type { ListForRepoIssue, OctokitLike } from '../src/types';

const LABEL = 'averlon-iac-misconfiguration-analysis';

function issue(number: number, key: string): ListForRepoIssue {
  return {
    number,
    body: embedBatchStateInBody('body', {
      v: 1,
      keys: [key],
      fingerprints: { [key]: `fp-${key}` },
    }),
    labels: [{ name: LABEL }],
  };
}

function pullRequest(number: number): ListForRepoIssue {
  return { number, body: '', labels: [{ name: LABEL }], pull_request: {} };
}

describe('getExistingState', () => {
  it('reads every page, also when PRs with the label fill the first one', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => pullRequest(i + 1)),
      [issue(101, 'a'), pullRequest(102)],
    ];
    const listForRepo = mock((opts: { page?: number }) =>
      Promise.resolve({ data: pages[(opts.page ?? 1) - 1] ?? [] })
    );
    const octokit = { rest: { issues: { listForRepo } } } as unknown as OctokitLike;

    const state = await getExistingState(octokit, 'acme', 'infra', LABEL);

    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(listForRepo).toHaveBeenLastCalledWith(
      expect.objectContaining({ labels: LABEL, state: 'open', page: 2 })
    );
    expect(state.issues.map(existing => existing.issueNumber)).toEqual([101]);
    expect(state.byKey.get('a')).toEqual({ fingerprint: 'fp-a', issueNumber: 101 });
  });
});
