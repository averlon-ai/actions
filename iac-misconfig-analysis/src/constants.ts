// Label on the copilot mode issues and on the PRs of the Claude agent. The
// issue sync lists only issues, and the PR sync only PRs.
export const AVERLON_MISCONFIG_ANALYSIS_LABEL = 'averlon-iac-misconfiguration-analysis';

// ----- Claude tool allowlists -----

export const MCP_TOOLS = [
  'mcp__averlon-mcp__averlon_get_issue_details',
  'mcp__averlon-mcp__averlon_get_asset',
  'mcp__averlon-mcp__averlon_list_asset_issues',
  'mcp__averlon-mcp__averlon_list_remediation_instructions',
  'mcp__averlon-mcp__averlon_get_remediation_instruction',
  'mcp__averlon-mcp__averlon_get_aws_role_policy_statements',
  'mcp__averlon-mcp__averlon_get_azure_role_definitions',
];
