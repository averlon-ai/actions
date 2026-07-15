import type { IssuesListOctokit } from '../../src/github-issue-list';

/**
 * Wraps a minimal Octokit mock so listOpenLabeledIssues can use paginate (like @actions/github).
 */
export function withIssuesPaginate(rest: IssuesListOctokit['rest']): IssuesListOctokit {
  return {
    paginate: async (method, params) => {
      const all: Awaited<ReturnType<typeof method>>['data'] = [];
      let page = 1;
      for (;;) {
        const { data } = await method({ ...params, page });
        if (data.length === 0) {
          break;
        }
        all.push(...data);
        if (data.length < params.per_page) {
          break;
        }
        page += 1;
      }
      return all;
    },
    rest,
  };
}

export function withIssuesPaginateFromListForRepo(
  listForRepo: IssuesListOctokit['rest']['issues']['listForRepo']
): IssuesListOctokit {
  return withIssuesPaginate({ issues: { listForRepo } });
}
