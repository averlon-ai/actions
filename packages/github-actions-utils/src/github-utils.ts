/**
 * Utilities for GitHub-specific operations
 */

export interface GitHubRepository {
  owner: string;
  repo: string;
}

/**
 * Parse GitHub repository information from GITHUB_REPOSITORY environment variable
 * GITHUB_REPOSITORY is automatically provided by GitHub Actions in the format "owner/repo"
 * @throws Error if GITHUB_REPOSITORY is not set or has invalid format
 */
export function parseGitHubRepository(): GitHubRepository {
  const repository = process.env['GITHUB_REPOSITORY'];
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable is not set');
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo || owner.includes('/') || repo.includes('/')) {
    throw new Error(
      `Invalid GITHUB_REPOSITORY format: "${repository}". Expected format: "owner/repo"`
    );
  }

  return { owner, repo };
}

/**
 * Get Git repository URL from GitHub Actions environment variables
 * @returns Full Git repository URL (e.g., "https://github.com/owner/repo")
 */
export function getGitRepoUrl(): string {
  const serverUrl = process.env['GITHUB_SERVER_URL'] || 'https://github.com';
  const repository = process.env['GITHUB_REPOSITORY'];

  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable is not set');
  }

  return `${serverUrl}/${repository}`;
}
