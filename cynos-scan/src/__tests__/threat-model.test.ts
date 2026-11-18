import { describe, it, expect, beforeEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pushEnvironment,
  THREAT_MODEL_BRANCH,
  updateThreatModel,
  type PullsApi,
} from '../threat-model';

/**
 * update-threat-model is the one operation that pushes: the commit on its branch must hold the
 * generated threat model and nothing else from the checkout.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

let origin: string;
let checkout: string;
let generated: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cs-threat-model-'));
  origin = join(root, 'origin.git');
  checkout = join(root, 'checkout');
  spawnSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['init', '--quiet', '-b', 'main', checkout]);
  writeFileSync(join(checkout, 'app.py'), 'print(1)\n');
  git(checkout, 'add', 'app.py');
  git(checkout, 'commit', '--quiet', '-m', 'init');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '--quiet', 'origin', 'main');
  mkdirSync(join(root, 'artifact'));
  generated = join(root, 'artifact', 'threatmodel.md');
  writeFileSync(generated, '# Threat model  \n\nAssets.\n\n\n');
});

function pulls(): PullsApi & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async openPullFrom() {
      return undefined;
    },
    async createPull(base, head) {
      created.push(`${head} -> ${base}`);
      return 'https://github.com/o/r/pull/1';
    },
    async updatePullBody() {},
  };
}

const update = () => ({
  checkout,
  remote: origin,
  generated,
  target: 'docs/threatmodel.md',
  defaultBranch: 'main',
  token: 'ghs_test',
  runUrl: 'https://github.com/o/r/actions/runs/1',
  sha: git(checkout, 'rev-parse', 'HEAD'),
  ref: 'refs/heads/main',
  log: () => {},
});

describe('updateThreatModel', () => {
  it('pushes one commit holding only the normalised threat model, and opens the PR', async () => {
    writeFileSync(join(checkout, 'app.py'), 'print(2)\n'); // an unstaged change it must not take
    const api = pulls();
    expect(await updateThreatModel(update(), api)).toBe('https://github.com/o/r/pull/1');
    expect(api.created).toEqual([`${THREAT_MODEL_BRANCH} -> main`]);
    expect(git(origin, 'diff', '--name-only', 'main', THREAT_MODEL_BRANCH)).toBe(
      'docs/threatmodel.md'
    );
    expect(git(origin, 'show', `${THREAT_MODEL_BRANCH}:docs/threatmodel.md`)).toBe(
      '# Threat model\n\nAssets.'
    );
    // The push token was never stored in the checkout's Git configuration.
    expect(spawnSync('git', ['-C', checkout, 'config', '--get-regexp', 'extraheader']).status).toBe(
      1
    );
  });

  it('runs only on the default branch, at the scanned commit', async () => {
    await expect(
      updateThreatModel({ ...update(), ref: 'refs/heads/feature' }, pulls())
    ).rejects.toThrow('runs only on the default branch, main');
    await expect(updateThreatModel({ ...update(), sha: 'f'.repeat(40) }, pulls())).rejects.toThrow(
      'must be at GITHUB_SHA'
    );
  });

  it('refuses a threat-model path through a symlink', async () => {
    symlinkSync(tmpdir(), join(checkout, 'docs'));
    git(checkout, 'add', 'docs');
    git(checkout, 'commit', '--quiet', '-m', 'link');
    await expect(updateThreatModel(update(), pulls())).rejects.toThrow('symlink');
  });

  it.each([
    ['a hook directory', [['core.hooksPath', '../hooks']]],
    [
      'a transport that runs a program',
      [
        ['protocol.ext.allow', 'always'],
        ['url.ext::sh -c "env > ../ran" %S.insteadOf', 'https://github.com/'],
      ],
    ],
    ['an include', [['include.path', '../extra.config']]],
  ])('refuses a checkout configuring %s, before any program runs', async (_, entries) => {
    for (const [name, value] of entries as string[][]) git(checkout, 'config', name, value);
    await expect(updateThreatModel(update(), pulls())).rejects.toThrow(
      'Git configuration a fresh actions/checkout does not write'
    );
    expect(existsSync(join(checkout, '..', 'ran'))).toBe(false);
    expect(git(origin, 'branch', '--list', THREAT_MODEL_BRANCH)).toBe('');
  });

  it("sends the token only as a header for the remote's own origin", () => {
    const env = pushEnvironment('https://github.com/o/r.git', 'ghs_test');
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    expect(env['GIT_CONFIG_VALUE_0']).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`
    );
    expect(pushEnvironment('/tmp/origin.git', 'ghs_test')['GIT_CONFIG_VALUE_0']).toBeUndefined();
  });

  it('takes threat-model-path literally, so a glob character matches no other file', async () => {
    mkdirSync(join(checkout, 'docs'));
    writeFileSync(join(checkout, 'docs', 'other.md'), 'tracked\n');
    git(checkout, 'add', 'docs/other.md');
    git(checkout, 'commit', '--quiet', '-m', 'docs');
    git(checkout, 'push', '--quiet', 'origin', 'main');
    writeFileSync(join(checkout, 'docs', 'other.md'), 'an unstaged change it must not take\n');
    await updateThreatModel({ ...update(), target: 'docs/*.md' }, pulls());
    expect(git(origin, 'diff', '--name-only', 'main', THREAT_MODEL_BRANCH)).toBe('docs/*.md');
    // As a glob, `git add -- docs/*.md` would also have staged docs/other.md.
    expect(git(checkout, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses a checkout with staged changes', async () => {
    writeFileSync(join(checkout, 'app.py'), 'print(2)\n');
    git(checkout, 'add', 'app.py');
    await expect(updateThreatModel(update(), pulls())).rejects.toThrow('staged changes');
  });
});
