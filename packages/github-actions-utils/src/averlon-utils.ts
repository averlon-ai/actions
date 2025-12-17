import * as core from '@actions/core';
import { getInputSafe, parseBoolean } from './input-utils';
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
  // Required inputs
  const apiKey = getInputSafe('api-key', true);
  const apiSecret = getInputSafe('api-secret', true);
  const githubToken = getInputSafe('github-token', true);

  // Optional inputs with defaults
  const baseUrl = getInputSafe('base-url', false) || 'https://wfe.prod.averlon.io/';
  const autoAssignCopilotStr = getInputSafe('auto-assign-copilot', false) || 'false';
  const autoAssignCopilot = parseBoolean(autoAssignCopilotStr);

  // Parse GitHub repository info
  const { owner: githubOwner, repo: githubRepo } = parseGitHubRepository();

  // Debug logging
  core.debug(`Base URL: ${baseUrl}`);
  core.info(`Auto-assign Copilot ${autoAssignCopilot ? 'enabled' : 'disabled'}`);

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
