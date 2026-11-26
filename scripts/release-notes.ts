#!/usr/bin/env bun
/**
 * Writes a release's notes: its CHANGELOG.md section, the table of actions, and an installation
 * example.
 *
 * The notes used to be the release step's `body:` input, and GitHub evaluates every `${{ }}`
 * expression in a step's inputs before the step runs, the example's included: its
 * `github-token: ${{ secrets.GITHUB_TOKEN }}` published the release job's token in the notes of
 * v2.1.0 and v2.1.1, and its `api-key` and `api-secret` lines would publish AVERLON_API_KEY and
 * AVERLON_API_SECRET in a repository that set them. The release step now reads this script's
 * output through `body_path`, which GitHub does not evaluate, so the example reaches the reader as
 * the text a calling workflow writes.
 *
 * Usage: bun scripts/release-notes.ts <version>   (prints the notes)
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { extractChangelog } from './extract-changelog';

const ROOT = join(import.meta.dir, '..');

/**
 * The installation example, as a calling workflow writes it. Its expressions are text here: plain
 * strings, not a template literal, which would read `${` as its own interpolation.
 */
function installationExample(version: string): string {
  return [
    '```yaml',
    `- uses: averlon-ai/actions/iac-risk-analysis@${version}`,
    '  with:',
    '    api-key: ${{ secrets.AVERLON_API_KEY }}',
    '    api-secret: ${{ secrets.AVERLON_API_SECRET }}',
    '    repo-name: ${{ github.repository }}',
    '    base-commit-hash: ${{ github.event.pull_request.base.sha }}',
    '    head-commit-hash: ${{ github.event.pull_request.head.sha }}',
    "    base-plan-path: './base-plan.json'",
    "    head-plan-path: './head-plan.json'",
    "    base-graph-path: './base-graph.dot'",
    "    head-graph-path: './head-graph.dot'",
    '    comment-on-pr: true',
    '    github-token: ${{ secrets.GITHUB_TOKEN }}',
    '```',
  ].join('\n');
}

/** The notes of `version` (vX.Y.Z), from its changelog section and the table of actions. */
export function releaseNotes(version: string, changelog: string, actionList: string): string {
  return [
    '## Changes',
    changelog,
    '',
    '## Available Actions',
    actionList,
    '_Generated from action metadata via `./scripts/generate-action-list.sh`._',
    '',
    '## Installation Example (iac-risk-analysis)',
    installationExample(version),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: bun scripts/release-notes.ts <version>');
    process.exit(1);
  }

  const changelog = extractChangelog(version, join(ROOT, 'CHANGELOG.md'));
  const actionList = spawnSync(join(ROOT, 'scripts/generate-action-list.sh'), {
    encoding: 'utf-8',
  });
  if (actionList.status !== 0) {
    console.error(`ERROR: generate-action-list.sh failed: ${actionList.stderr}`);
    process.exit(1);
  }

  process.stdout.write(releaseNotes(version, changelog, actionList.stdout.trimEnd()));
}
