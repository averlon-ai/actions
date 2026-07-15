import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as core from '@actions/core';
import { configureActionLogging } from '@averlon/shared';
import { CopilotIssueManager } from '../src/copilot-manager';

describe('CopilotIssueManager.findPRsLinkedToIssue', () => {
  let warningSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy.mockClear();
    infoSpy.mockClear();
  });

  afterEach(() => {
    configureActionLogging({ verbose: false });
    warningSpy?.mockRestore();
    infoSpy?.mockRestore();
  });

  test('returns linked PRs when timeline includes pull request details', async () => {
    configureActionLogging({ verbose: true });
    const graphql = mock(() =>
      Promise.resolve({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: 'ConnectedEvent',
                  subject: {
                    __typename: 'PullRequest',
                    number: 273,
                    author: { login: 'copilot-swe-agent' },
                    state: 'OPEN',
                  },
                },
              ],
            },
          },
        },
      })
    );

    const manager = new CopilotIssueManager(
      { graphql } as never,
      'averlon-security',
      'averlon-goat'
    );

    const linked = await manager.findPRsLinkedToIssue(272);

    expect(linked).toEqual([{ number: 273, author: 'copilot-swe-agent', state: 'OPEN' }]);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test('warns when timeline shows pull requests the token cannot read', async () => {
    const graphql = mock(() =>
      Promise.resolve({
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: 'ConnectedEvent',
                  subject: {
                    __typename: 'PullRequest',
                  },
                },
              ],
            },
          },
        },
      })
    );

    const manager = new CopilotIssueManager(
      { graphql } as never,
      'averlon-security',
      'averlon-goat'
    );

    const linked = await manager.findPRsLinkedToIssue(272);

    expect(linked).toEqual([]);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(String(warningSpy.mock.calls[0]?.[0])).toContain('pull-requests: read');
  });
});
