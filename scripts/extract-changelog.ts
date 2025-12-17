#!/usr/bin/env bun
/**
 * Extract changelog for a specific version from CHANGELOG.md
 * Usage: bun scripts/extract-changelog.ts <version> [changelog-path]
 * Example: bun scripts/extract-changelog.ts 1.0.0
 * Example: bun scripts/extract-changelog.ts 1.0.0 ./CHANGELOG.md
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';

/**
 * Extract changelog section for a specific version
 * Supports Keep a Changelog format: ## [VERSION] - DATE
 */
export function extractChangelog(version: string, changelogPath: string): string {
  if (!existsSync(changelogPath)) {
    throw new Error(`CHANGELOG.md not found at: ${changelogPath}`);
  }

  const content = readFileSync(changelogPath, 'utf-8');
  const lines = content.split('\n');

  // Remove 'v' prefix if present
  const versionNumber = version.startsWith('v') ? version.slice(1) : version;

  // Find the section for this version
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    // Check if we're at the start of the target version section
    if (
      line.match(new RegExp(`^## \\[${versionNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`))
    ) {
      inSection = true;
      continue; // Skip the header line itself
    }

    // Check if we've hit the next version section
    if (inSection && line.match(/^## \[/)) {
      break;
    }

    // Collect lines in the current section
    if (inSection) {
      sectionLines.push(line);
    }
  }

  // If we didn't find the version, try [Unreleased]
  if (sectionLines.length === 0) {
    inSection = false;
    for (const line of lines) {
      if (line.match(/^## \[Unreleased\]/i)) {
        inSection = true;
        continue;
      }

      if (inSection && line.match(/^## \[/)) {
        break;
      }

      if (inSection) {
        sectionLines.push(line);
      }
    }
  }

  // Clean up and format the output
  const changelog = sectionLines
    .map(line => line.replace(/\r$/, ''))
    .join('\n')
    .trim();

  if (changelog.length === 0) {
    return 'No changelog available for this version';
  }

  return changelog;
}

// Main execution (only run when called directly, not when imported)
if (import.meta.main) {
  const version = process.argv[2];
  const customPath = process.argv[3];

  if (!version) {
    console.error('Usage: bun scripts/extract-changelog.ts <version> [changelog-path]');
    console.error('Example: bun scripts/extract-changelog.ts 1.0.0');
    console.error('Example: bun scripts/extract-changelog.ts 1.0.0 ./CHANGELOG.md');
    process.exit(1);
  }

  const changelogPath = customPath
    ? resolve(customPath)
    : join(process.cwd(), DEFAULT_CHANGELOG_FILE);

  try {
    const changelog = extractChangelog(version, changelogPath);
    console.log(changelog);
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`ERROR: ${error.message}`);
    } else {
      console.error('ERROR: An unknown error occurred');
    }
    process.exit(1);
  }
}
