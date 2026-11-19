import { CodeDefectStatus } from '@averlon/shared';

// ----- API / environment defaults -----

export const DEFAULT_BASE_URL = 'https://wfe.prod.averlon.io/';
export const DEFAULT_MCP_IMAGE = 'ghcr.io/averlon-security/averlon-mcp:sha-a8e5b91';
export const DEFAULT_MAX_TURNS = '250';

// ----- Claude tool allowlist -----

export const ALLOWED_BASE_TOOLS = ['Bash(*)', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];

// ----- JSON schema for structured agent output -----

export const FEEDBACK_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    feedback: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          CodeDefectID: { type: 'string' },
          Status: { type: 'number', enum: [CodeDefectStatus.Fixed, CodeDefectStatus.NoFix] },
          Feedback: { type: 'string' },
          // URL of the PR that fixed the defect, for a Fixed entry fixed by a PR
          pr_url: { type: 'string' },
        },
        required: ['CodeDefectID', 'Status', 'Feedback'],
      },
    },
    // Every PR the agent opened (e.g. a runtime upgrade and a dependency upgrade).
    pull_requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pr_number: { type: 'integer' },
          pr_url: { type: 'string' },
        },
        required: ['pr_number', 'pr_url'],
      },
    },
  },
  required: ['feedback'],
});
