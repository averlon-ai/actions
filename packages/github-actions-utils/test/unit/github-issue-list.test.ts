import { describe, it, expect, mock } from 'bun:test';
import {
  listLabeledIssues,
  listLabeledPullRequests,
  buildListForRepoParams,
  type ListForRepoParams,
} from '../../src/github-issue-list';
import { withIssuesPaginateFromListForRepo } from '../helpers/octokit-paginate';

describe('buildListForRepoParams', () => {
  it('scopes listForRepo to owner, repo, and label', () => {
    expect(
      buildListForRepoParams({
        owner: ' my-org ',
        repo: ' my-repo ',
        label: ' averlon-k8s-analysis ',
        state: 'all',
      })
    ).toEqual({
      owner: 'my-org',
      repo: 'my-repo',
      state: 'all',
      labels: 'averlon-k8s-analysis',
      per_page: 100,
    });
  });
});

describe('listLabeledIssues', () => {
  it('returns all open issues with the label across pages when state is open', async () => {
    const mockListForRepo = mock((params: ListForRepoParams) => {
      expect(params.owner).toBe('owner');
      expect(params.repo).toBe('repo');
      expect(params.labels).toBe('averlon-k8s-analysis');
      expect(params.state).toBe('open');
      if (params.page === 1) {
        return Promise.resolve({
          data: Array.from({ length: 100 }, (_, i) => ({
            number: i + 1,
            title: `Issue ${i + 1}`,
            state: 'open',
          })),
        });
      }
      return Promise.resolve({
        data: [{ number: 101, title: 'Issue 101', state: 'open' }],
      });
    });

    const issues = await listLabeledIssues(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'owner',
      'repo',
      'averlon-k8s-analysis',
      'open'
    );

    expect(issues).toHaveLength(101);
    expect(issues.every(i => i.state === 'open')).toBe(true);
  });

  it('includes closed issues when state is all', async () => {
    const mockListForRepo = mock((params: ListForRepoParams) => {
      expect(params.state).toBe('all');
      return Promise.resolve({
        data: [
          { number: 1, title: 'Open issue', state: 'open' },
          { number: 2, title: 'Closed issue', state: 'closed' },
        ],
      });
    });

    const issues = await listLabeledIssues(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'owner',
      'repo',
      'label',
      'all'
    );

    expect(issues).toEqual([
      { number: 1, title: 'Open issue', state: 'open', labels: [] },
      { number: 2, title: 'Closed issue', state: 'closed', labels: [] },
    ]);
  });

  it('extracts label names from issue labels', async () => {
    const mockListForRepo = mock(() =>
      Promise.resolve({
        data: [
          {
            number: 1,
            title: 'Issue',
            state: 'open',
            labels: [{ name: 'averlon-created' }, { name: 'averlon-k8s-analysis' }],
          },
        ],
      })
    );

    const issues = await listLabeledIssues(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'owner',
      'repo',
      'averlon-k8s-analysis',
      'all'
    );

    expect(issues[0]?.labels).toEqual(['averlon-created', 'averlon-k8s-analysis']);
  });

  it('excludes pull requests from the issues list', async () => {
    const mockListForRepo = mock(() =>
      Promise.resolve({
        data: [
          { number: 1, title: 'Real issue', state: 'open' },
          { number: 2, title: 'A PR', state: 'open', pull_request: {} },
        ],
      })
    );

    const issues = await listLabeledIssues(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'owner',
      'repo',
      'label',
      'all'
    );

    expect(issues).toEqual([{ number: 1, title: 'Real issue', state: 'open', labels: [] }]);
  });

  it('excludes issues that do not include the requested label in metadata', async () => {
    const mockListForRepo = mock(() =>
      Promise.resolve({
        data: [
          {
            number: 1,
            title: 'Wrong label',
            state: 'open',
            labels: [{ name: 'other-label' }],
          },
          {
            number: 2,
            title: 'Correct',
            state: 'open',
            labels: [{ name: 'target-label' }],
          },
        ],
      })
    );

    const issues = await listLabeledIssues(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'owner',
      'repo',
      'target-label',
      'all'
    );

    expect(issues).toEqual([
      {
        number: 2,
        title: 'Correct',
        state: 'open',
        labels: ['target-label'],
      },
    ]);
  });
});

describe('listLabeledPullRequests', () => {
  it('scopes listForRepo to owner, repo, and label and returns only labeled PRs', async () => {
    const mockListForRepo = mock((params: ListForRepoParams) => {
      expect(params.owner).toBe('org');
      expect(params.repo).toBe('repo');
      expect(params.labels).toBe('averlon-container-analysis');
      expect(params.state).toBe('all');
      return Promise.resolve({
        data: [
          { number: 1, title: 'Issue', state: 'open' },
          {
            number: 2,
            title: 'Remediation',
            state: 'open',
            pull_request: { url: 'x' },
            labels: [{ name: 'averlon-container-analysis' }],
          },
          {
            number: 3,
            title: 'Other PR',
            state: 'open',
            pull_request: { url: 'y' },
            labels: [{ name: 'other' }],
          },
        ],
      });
    });

    const prs = await listLabeledPullRequests(
      withIssuesPaginateFromListForRepo(mockListForRepo),
      'org',
      'repo',
      'averlon-container-analysis',
      'all'
    );

    expect(prs).toEqual([{ number: 2, title: 'Remediation' }]);
  });
});
