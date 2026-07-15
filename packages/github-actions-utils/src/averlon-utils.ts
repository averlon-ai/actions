import * as core from '@actions/core';
import { getInputSafe, parseBoolean } from './input-utils';
import { logDebug, logInfo } from './log-utils';
import { parseGitHubRepository } from './github-utils';

/**
 * Common Averlon action inputs
 */
export interface AverlonCommonInputs {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  githubToken: string;
  autoAssignCopilot: boolean;
  githubOwner: string;
  githubRepo: string;
}

/**
 * Get common Averlon action inputs
 * These inputs are shared across all Averlon actions
 */
export function getAverlonCommonInputs(): AverlonCommonInputs {
  // Required inputs with backward compatibility
  const apiKey = getInputSafe('averlon-api-key', false) || getInputSafe('api-key', false);
  const apiSecret = getInputSafe('averlon-api-secret', false) || getInputSafe('api-secret', false);
  const githubToken = getInputSafe('github-token', true);

  if (!apiKey) {
    throw new Error(
      'Averlon API key required: provide averlon-api-key (preferred) or api-key (deprecated)'
    );
  }
  if (!apiSecret) {
    throw new Error(
      'Averlon API secret required: provide averlon-api-secret (preferred) or api-secret (deprecated)'
    );
  }

  // Optional inputs with defaults
  const baseUrl = getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/';
  const autoAssignCopilotStr = getInputSafe('auto-assign-copilot', false) || 'false';
  const autoAssignCopilot = parseBoolean(autoAssignCopilotStr);

  // Parse GitHub repository info
  const { owner: githubOwner, repo: githubRepo } = parseGitHubRepository();

  // Debug logging
  logDebug(`Base URL: ${baseUrl}`);
  logInfo(`Auto-assign Copilot ${autoAssignCopilot ? 'enabled' : 'disabled'}`);

  // Mask sensitive values
  if (githubToken) {
    core.setSecret(githubToken);
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    githubToken,
    autoAssignCopilot,
    githubOwner,
    githubRepo,
  };
}
