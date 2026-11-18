// ----- API / environment defaults -----

export const DEFAULT_FILTERS = 'Recommended,Critical,HighRCE';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export const AVERLON_CONTAINER_LABEL = 'averlon-container-analysis';

// ----- Claude tool allowlists -----

export const MCP_TOOLS = [
  'mcp__averlon-mcp__averlon_get_vulnerability',
  'mcp__averlon-mcp__averlon_get_package',
  'mcp__averlon-mcp__averlon_get_package_compatibility',
  'mcp__averlon-mcp__averlon_get_package_deprecation',
];

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
