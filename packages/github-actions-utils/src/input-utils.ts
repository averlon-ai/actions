import * as core from '@actions/core';
import { IssueSeverityEnum } from '@averlon/shared/types';

/**
 * Safely get input from GitHub Actions or environment variables
 *
 * @param name - The input name (e.g., 'api-key')
 * @param required - Whether the input is required
 * @returns The input value or empty string if not required and not found
 * @throws Error if required input is missing
 */
export function getInputSafe(name: string, required: boolean = true): string {
  // Try GitHub Actions core first (when running in GitHub Actions)
  try {
    const value = core.getInput(name, { required: false });
    if (value) {
      core.debug(`Got input '${name}' from GitHub Actions core`);
      return value;
    }
  } catch {
    // Ignore errors when not in GitHub Actions environment (e.g., local testing)
    core.debug('GitHub Actions core not available, falling back to env vars');
  }

  // Fallback to environment variables (for local testing)
  // Converts 'api-key' to 'INPUT_API_KEY' format
  const envName = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const value = process.env[envName];

  if (!value && required) {
    // Required input missing from both sources
    throw new Error(`Input required and not supplied: ${name} (${envName})`);
  }

  if (value) {
    core.debug(`Got input '${name}' from environment variable ${envName}`);
  }

  return value || '';
}

/**
 * Parses a boolean input string.
 *
 * @param input - The input string to parse.
 * @returns The parsed boolean value.
 */
export function parseBoolean(input: string | undefined): boolean {
  if (typeof input !== 'string') return false;
  const v = input.trim().toLowerCase();
  return v === 'true' || v === 't' || v === '1' || v === 'yes';
}

/**
 * Parses a comma-separated list of issue severity filters.
 *
 * @param filtersRaw - The input string to parse.
 * @returns The parsed issue severity filters.
 */
export function parseIssueSeverityFilters(filtersRaw: string): IssueSeverityEnum[] {
  const severitySet = new Set<IssueSeverityEnum>();

  const tokens = filtersRaw
    .split(',')
    .map(token => token.trim())
    .filter(token => token.length > 0);

  if (tokens.length === 0) {
    tokens.push('Critical', 'High');
  }

  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case 'critical':
        severitySet.add(IssueSeverityEnum.Critical);
        break;
      case 'high':
        severitySet.add(IssueSeverityEnum.High);
        break;
      case 'medium':
        severitySet.add(IssueSeverityEnum.Medium);
        break;
      case 'low':
        severitySet.add(IssueSeverityEnum.Low);
        break;
      default:
        core.warning(
          `Unknown filter "${token}" ignored. Supported values: Critical, High, Medium, Low.`
        );
    }
  }

  if (severitySet.size === 0) {
    severitySet.add(IssueSeverityEnum.Critical);
    severitySet.add(IssueSeverityEnum.High);
  }

  return Array.from(severitySet);
}
