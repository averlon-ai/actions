# @averlon/github-copilot-utils

Shared utilities for GitHub Copilot integration in Averlon GitHub Actions.

## Features

- GitHub Copilot bot detection and assignment
- PR lifecycle management (finding, closing, tracking)
- Issue lifecycle management with Copilot reassignment
- GraphQL queries for issues, PRs, and timeline events

## Usage

```typescript
import { CopilotIssueManager, IssueConfig } from '@averlon/github-copilot-utils';
import * as github from '@actions/github';

const octokit = github.getOctokit(token);
const manager = new CopilotIssueManager(octokit, 'owner', 'repo');

// Assign Copilot to an issue
await manager.assignCopilot(issueNumber, true);

// Handle Copilot assignment for updated issues
await manager.handleCopilotAssignmentForUpdatedIssue(issueNumber, true);

// Find PRs linked to an issue
const prs = await manager.findPRsLinkedToIssue(issueNumber);

// Close a PR with a comment
await manager.closePR(prNumber, 'Closing reason');
```

## API

### CopilotIssueManager

Main class for managing Copilot assignments and PR lifecycle.

#### Methods

- `assignCopilot(issueNumber, autoAssign)` - Assign Copilot to an issue
- `handleCopilotAssignmentForUpdatedIssue(issueNumber, autoAssign)` - Handle Copilot for updated issues
- `handleCopilotAssignmentForUnchangedIssue(issueNumber, autoAssign)` - Handle Copilot for unchanged issues
- `findPRsLinkedToIssue(issueNumber)` - Find PRs connected to an issue
- `closePR(prNumber, message)` - Close a PR with a comment
- `getIssue(issueNumber)` - Get issue details

## License

See root LICENSE file.
