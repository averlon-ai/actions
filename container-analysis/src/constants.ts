import { CodeDefectStatus } from '@averlon/shared';

// ----- API / environment defaults -----

export const DEFAULT_BASE_URL = 'https://wfe.prod.averlon.io/';
export const DEFAULT_FILTERS = 'Recommended,Critical,HighRCE';
export const DEFAULT_MCP_IMAGE = 'ghcr.io/averlon-security/averlon-mcp:sha-a8e5b91';
export const DEFAULT_MAX_TURNS = '250';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-6';

export const AVERLON_CONTAINER_LABEL = 'averlon-container-analysis';

// ----- Claude tool allowlists -----

export const ALLOWED_BASE_TOOLS = ['Bash(*)', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];

export const MCP_TOOLS = [
  'mcp__averlon-mcp__averlon_get_vulnerability',
  'mcp__averlon-mcp__averlon_get_package',
  'mcp__averlon-mcp__averlon_get_package_compatibility',
  'mcp__averlon-mcp__averlon_get_package_deprecation',
  'mcp__averlon-mcp__averlon_schedule_image_scan',
  'mcp__averlon-mcp__averlon_get_image_scan_report',
];

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
        },
        required: ['CodeDefectID', 'Status', 'Feedback'],
      },
    },
    pr_number: { type: 'integer' },
    pr_url: { type: 'string' },
  },
  required: ['feedback'],
});

// ----- Filter bitmask map (used by parseFilters) -----

export const FILTER_BITS: Record<string, number> = {
  RecommendedOrExploited: 0x1,
  Critical: 0x2,
  High: 0x4,
  HighRCE: 0x8,
  MediumApplication: 0x10,
  Recommended: 0x20,
  Exploited: 0x40,
  Medium: 0x80,
  Low: 0x100,
  LowApplication: 0x200,
};
