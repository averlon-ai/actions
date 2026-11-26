import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseNotes } from './release-notes';

const RELEASE_WORKFLOW = join(import.meta.dir, '..', '.github/workflows/release.yml');

interface Workflow {
  jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
}

/** The release workflow's create-release step inputs, which GitHub evaluates before the step runs. */
function releaseStepInputs(): Record<string, string> {
  const workflow = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, 'utf8')) as Workflow;
  const step = Object.values(workflow.jobs)
    .flatMap(job => job.steps ?? [])
    .find(s => s.uses?.startsWith('actions/create-release@'));
  expect(step?.with).toBeDefined();
  return step?.with ?? {};
}

describe('release-notes', () => {
  test('keeps the installation example expressions as text', () => {
    // The version goes in through a variable: each release rewrites every literal
    // `averlon-ai/actions/<action>@v<version>` in the repository (update-action-versions.ts).
    const version = 'v1.2.3';
    const notes = releaseNotes(version, '### Fixed\n- A fix', '| Action |');

    expect(notes).toContain(`- uses: averlon-ai/actions/iac-risk-analysis@${version}`);
    expect(notes).toContain('github-token: ${{ secrets.GITHUB_TOKEN }}');
    expect(notes).toContain('api-key: ${{ secrets.AVERLON_API_KEY }}');
    expect(notes).toContain('repo-name: ${{ github.repository }}');
  });

  test('includes the changelog section and the table of actions', () => {
    const notes = releaseNotes('v1.2.3', '### Fixed\n- A fix', '| Action |');

    expect(notes).toContain('## Changes\n### Fixed\n- A fix');
    expect(notes).toContain('## Available Actions\n| Action |');
  });

  // GitHub evaluates the release step's inputs, so a secret or the job's token named in them
  // (in `body:`, say) is published in the release notes.
  test('the release step passes no secret or token in its inputs', () => {
    const secretInputs = Object.entries(releaseStepInputs()).filter(([, value]) =>
      /\$\{\{\s*(secrets\.|github\.token)/.test(String(value))
    );

    expect(secretInputs).toEqual([]);
  });
});
