import * as core from '@actions/core';
import * as github from '@actions/github';

// Constants
export const COPILOT_SWE_AGENT = 'copilot-swe-agent';

// Enums
export enum PRState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum IssueState {
  OPEN = 'open',
  CLOSED = 'closed',
}

// GraphQL response types
export interface SuggestedActor {
  login: string;
  __typename: string;
  id?: string;
}

export interface CopilotBotResponse {
  repository?: {
    suggestedActors?: {
      nodes: SuggestedActor[];
    };
  };
}

export interface IssueNodeIdResponse {
  repository?: {
    issue?: {
      id: string;
    };
  };
}

export interface TimelineItem {
  __typename: string;
  subject?: {
    __typename: string;
    number?: number;
    author?: {
      login: string;
    };
    state?: string;
  };
  source?: {
    __typename: string;
    number?: number;
    author?: {
      login: string;
    };
    state?: string;
  };
}

export interface TimelineResponse {
  repository?: {
    issue?: {
      timelineItems?: {
        nodes: TimelineItem[];
      };
    };
  };
}

export interface LinkedPR {
  number: number;
  author: string;
  state: string;
}

/**
 * Manager class for GitHub Copilot integration and PR lifecycle management
 * This class contains common logic shared across all Averlon actions
 */
export class CopilotIssueManager {
  protected readonly octokit: ReturnType<typeof github.getOctokit>;
  protected readonly owner: string;
  protected readonly repo: string;

  constructor(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Get the Copilot bot ID for this repository
   */
  async getCopilotBotId(): Promise<string | null> {
    if (!this.owner || !this.repo) return null;

    const query = `
      query GetCopilotBot($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) { 
            nodes { 
              login 
              __typename 
              ... on Bot { 
                id 
              } 
            } 
          }
        }
      }
    `;

    const variables = { owner: this.owner, repo: this.repo };
    const response = (await this.octokit.graphql(query, variables)) as CopilotBotResponse;
    const actors = response?.repository?.suggestedActors?.nodes || [];
    const copilotBot = actors.find(a => a.login === COPILOT_SWE_AGENT);
    return copilotBot?.id || null;
  }

  /**
   * Get the GraphQL node ID for an issue
   */
  async getIssueNodeId(issueNumber: number): Promise<string | null> {
    const issueQuery = `
      query GetIssueId($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { 
          issue(number: $number) { 
            id 
          } 
        }
      }
    `;

    const issueResponse = (await this.octokit.graphql(issueQuery, {
      owner: this.owner,
      repo: this.repo,
      number: issueNumber,
    })) as IssueNodeIdResponse;

    return issueResponse.repository?.issue?.id || null;
  }

  /**
   * Assign an issue to the Copilot bot using GraphQL mutation
   */
  async assignIssueToCopilot(issueId: string, copilotBotId: string): Promise<void> {
    const mutation = `
      mutation AssignIssue($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable { 
            ... on Issue { 
              id 
              title 
              assignees(first: 10) { 
                nodes { 
                  login 
                } 
              } 
            } 
          }
        }
      }
    `;

    const variables = { assignableId: issueId, actorIds: [copilotBotId] };
    await this.octokit.graphql(mutation, variables);
  }

  /**
   * Clear all assignees from an issue using GraphQL mutation
   */
  async clearAllAssignees(issueId: string): Promise<void> {
    const mutation = `
      mutation ClearAssignees($assignableId: ID!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: [] }) {
          assignable { 
            __typename 
          }
        }
      }
    `;

    const variables = { assignableId: issueId };
    await this.octokit.graphql(mutation, variables);
  }

  /**
   * Assign Copilot to an issue
   */
  async assignCopilot(issueNumber: number, autoAssign: boolean): Promise<void> {
    if (!autoAssign) return;

    try {
      const copilotBotId = await this.getCopilotBotId();
      if (!copilotBotId) {
        core.warning(
          'Copilot assignment skipped: GitHub token must have access to GitHub Copilot to assign the bot.'
        );
        return;
      }

      const issueId = await this.getIssueNodeId(issueNumber);
      if (!issueId) {
        core.warning(`Failed to get issue node ID for issue #${issueNumber}`);
        return;
      }

      await this.clearAllAssignees(issueId);
      await this.assignIssueToCopilot(issueId, copilotBotId);
      core.info(`Copilot assigned to issue #${issueNumber}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`Copilot assignment failed (non-fatal): ${message}`);
    }
  }

  /**
   * Find PRs linked to an issue via timeline events
   */
  async findPRsLinkedToIssue(issueNumber: number): Promise<LinkedPR[]> {
    try {
      const query = `
        query FindLinkedPRs($owner: String!, $repo: String!, $issueNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issueNumber) {
              timelineItems(first: 100, itemTypes: [CONNECTED_EVENT, DISCONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
                nodes {
                  __typename
                  ... on ConnectedEvent {
                    __typename
                    subject {
                      __typename
                      ... on PullRequest {
                        number
                        author {
                          login
                        }
                        state
                      }
                    }
                  }
                  ... on CrossReferencedEvent {
                    __typename
                    source {
                      __typename
                      ... on PullRequest {
                        number
                        author {
                          login
                        }
                        state
                      }
                    }
                  }
                  ... on DisconnectedEvent {
                    __typename
                    subject {
                      __typename
                      ... on PullRequest {
                        number
                        author {
                          login
                        }
                        state
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response = (await this.octokit.graphql(query, {
        owner: this.owner,
        repo: this.repo,
        issueNumber,
      })) as TimelineResponse;

      const timelineItems = response?.repository?.issue?.timelineItems?.nodes || [];
      const linkedPRs: LinkedPR[] = [];

      for (const item of timelineItems) {
        let pr: TimelineItem['subject'] | TimelineItem['source'] | null = null;

        if (
          (item.subject && item.subject.__typename === 'PullRequest') ||
          (item.source && item.source.__typename === 'PullRequest')
        ) {
          pr =
            item.subject && item.subject.__typename === 'PullRequest' ? item.subject : item.source;
        }

        if (pr && pr.number && pr.state) {
          linkedPRs.push({
            number: pr.number,
            author: pr.author?.login || 'unknown',
            state: pr.state,
          });
        }
      }

      core.info(`Found ${linkedPRs.length} PRs from timeline events`);
      return linkedPRs;
    } catch (err) {
      core.warning(
        `Timeline query failed for issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /**
   * Close a PR with a comment explaining why
   */
  async closePR(prNumber: number, message: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      state: 'closed',
    });

    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body: message,
    });
  }

  /**
   * Get issue details
   */
  async getIssue(issueNumber: number): Promise<{ body: string } | null> {
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return { body: issue.body || '' };
  }

  /**
   * Handle Copilot assignment for updated issues
   * Closes existing Copilot PRs and reassigns Copilot
   */
  async handleCopilotAssignmentForUpdatedIssue(
    issueNumber: number,
    autoAssignCopilot: boolean
  ): Promise<void> {
    try {
      const linkedPRs = await this.findPRsLinkedToIssue(issueNumber);
      const copilotPRs = linkedPRs.filter(pr => pr.author === COPILOT_SWE_AGENT);

      if (copilotPRs.length === 0) {
        core.info(`No existing Copilot PRs found for issue #${issueNumber}`);
      }

      const openPRs = copilotPRs.filter(pr => pr.state === PRState.OPEN);
      const closedPRs = copilotPRs.filter(pr => pr.state === PRState.CLOSED);

      if (openPRs.length > 0) {
        core.info(`Found ${openPRs.length} open Copilot PR(s) for issue #${issueNumber}`);

        for (const pr of openPRs) {
          await this.closePR(
            pr.number,
            `Closing PR #${pr.number} because the associated recommendation has been updated and Copilot is being reassigned.`
          );
          core.info(`Closed PR #${pr.number}`);
        }
      }

      if (closedPRs.length > 0) {
        core.info(
          `Found ${closedPRs.length} closed Copilot PR(s) for issue #${issueNumber}: ${closedPRs.map(pr => `#${pr.number}`).join(', ')}`
        );
      }

      await this.assignCopilot(issueNumber, autoAssignCopilot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(
        `Failed to handle Copilot assignment for updated issue #${issueNumber} (non-fatal): ${message}`
      );
    }
  }

  /**
   * Handle Copilot assignment for unchanged issues
   * Only assigns Copilot if there are no open PRs
   */
  async handleCopilotAssignmentForUnchangedIssue(
    issueNumber: number,
    autoAssignCopilot: boolean
  ): Promise<void> {
    try {
      const linkedPRs = await this.findPRsLinkedToIssue(issueNumber);
      const copilotPRs = linkedPRs.filter(pr => pr.author === COPILOT_SWE_AGENT);
      const openPRs = copilotPRs.filter(pr => pr.state === PRState.OPEN);
      const closedPRs = copilotPRs.filter(pr => pr.state === PRState.CLOSED);

      // Only assign Copilot if there are no open PRs
      if (openPRs.length === 0) {
        await this.assignCopilot(issueNumber, autoAssignCopilot);
      }

      if (closedPRs.length > 0) {
        core.info(
          `Found ${closedPRs.length} closed Copilot PR(s) for issue #${issueNumber}: ${closedPRs.map(pr => `#${pr.number}`).join(', ')}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(
        `Failed to handle Copilot assignment for unchanged issue #${issueNumber} (non-fatal): ${message}`
      );
    }
  }
}
