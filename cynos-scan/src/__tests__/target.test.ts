import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEvent,
  isLinkFreeFile,
  originMatches,
  pullRequestNumber,
  resolveTarget,
  TargetError,
  type EventContext,
  type Git,
} from '../target';
import type { ScanPlan } from '../last-scanned';

const HEAD = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
let repository: string;

beforeAll(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), 'cs-target-')));
  mkdirSync(join(repository, 'functions'));
  writeFileSync(join(repository, 'functions', 'a.py'), '');
  symlinkSync('/etc', join(repository, 'linked'));
});
afterAll(() => rmSync(repository, { recursive: true, force: true }));

function event(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventName: 'schedule',
    repository: 'averlon-security/kca',
    sha: HEAD,
    ref: 'refs/heads/main',
    serverUrl: 'https://github.com',
    payload: {},
    ...overrides,
  };
}

/** A fake Git: a clean checkout of HEAD from this repository, with a non-empty diff. */
function fakeGit(overrides: Record<string, { status?: number; stdout?: string }> = {}): () => Git {
  return () => args => {
    const key =
      args[0] === 'rev-parse' && args[1] === '--verify' ? `rev-parse ${args[3]}` : (args[0] ?? '');
    const answers: Record<string, { status?: number; stdout?: string }> = {
      'rev-parse': { stdout: `${repository}\n` },
      'rev-parse HEAD^{commit}': { stdout: `${HEAD}\n` },
      [`rev-parse ${BASE}^{commit}`]: { stdout: `${BASE}\n` },
      config: {
        stdout: args.includes('--get')
          ? 'https://github.com/averlon-security/kca.git\n'
          : 'local\tcore.bare\n',
      },
      status: { stdout: '' },
      'merge-base': { stdout: `${BASE}\n` },
      diff: { status: 1 },
      ...overrides,
    };
    const answer = answers[key] ?? answers[args[0] ?? ''] ?? { status: 0, stdout: '' };
    return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: '' };
  };
}

/** Pull request 7 of this repository, open, at HEAD. */
const PULL_REQUEST = {
  number: 7,
  state: 'open',
  head: { repo: { full_name: 'averlon-security/kca' }, sha: HEAD },
  base: { repo: { full_name: 'averlon-security/kca' }, sha: 'b'.repeat(40) },
};

/** A comment request: a member's comment on pull request 7, with the pull request fetched. */
function commentRequest(
  overrides: { association?: string; issue?: object; pullRequest?: object | undefined } = {}
): EventContext {
  return event({
    eventName: 'issue_comment',
    payload: {
      issue: overrides.issue ?? { number: 7, pull_request: { url: 'https://api.github.com/…' } },
      comment: { body: 'cynos scan', author_association: overrides.association ?? 'MEMBER' },
    },
    commentedPullRequest: ('pullRequest' in overrides
      ? overrides.pullRequest
      : PULL_REQUEST) as EventContext['commentedPullRequest'],
  });
}

const noLastScan = async (): Promise<ScanPlan> => {
  throw new Error('last-scan not expected');
};

describe('checkEvent', () => {
  it('refuses events upstream refuses', () => {
    expect(() => checkEvent(event({ eventName: 'pull_request_target' }))).toThrow(
      'Unsupported event'
    );
  });

  it('refuses fork pull requests', () => {
    const payload = {
      pull_request: {
        head: { repo: { full_name: 'someone/fork' }, sha: HEAD },
        base: { repo: { full_name: 'averlon-security/kca' }, sha: BASE },
      },
    };
    expect(() => checkEvent(event({ eventName: 'pull_request', payload }))).toThrow(
      'Fork PR scans are not supported'
    );
  });
});

describe('checkEvent: comment requests', () => {
  it('accepts a member, owner or collaborator commenting on an open pull request', () => {
    for (const association of ['MEMBER', 'OWNER', 'COLLABORATOR'])
      expect(() => checkEvent(commentRequest({ association }))).not.toThrow();
  });

  it('refuses a comment from anyone else, who would spend the key', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE'])
      expect(() => checkEvent(commentRequest({ association }))).toThrow(
        'can request a scan by comment'
      );
  });

  it('refuses a comment on an issue', () => {
    expect(() => checkEvent(commentRequest({ issue: { number: 7 } }))).toThrow(
      'only on a pull request'
    );
  });

  it('refuses a pull request that was not fetched, or is not the one commented on', () => {
    expect(() => checkEvent(commentRequest({ pullRequest: undefined }))).toThrow(
      'could not be read'
    );
    expect(() =>
      checkEvent(commentRequest({ pullRequest: { ...PULL_REQUEST, number: 8 } }))
    ).toThrow('could not be read');
  });

  it('refuses a closed pull request', () => {
    expect(() =>
      checkEvent(commentRequest({ pullRequest: { ...PULL_REQUEST, state: 'closed' } }))
    ).toThrow('closed');
  });

  it("refuses a fork's pull request, as on its pull_request event", () => {
    const fork = { ...PULL_REQUEST, head: { repo: { full_name: 'someone/fork' }, sha: HEAD } };
    expect(() => checkEvent(commentRequest({ pullRequest: fork }))).toThrow(
      'Fork PR scans are not supported'
    );
  });
});

describe('pullRequestNumber', () => {
  it("is the scanned pull request's number, on its event or a comment request", () => {
    expect(
      pullRequestNumber(
        event({ eventName: 'pull_request', payload: { pull_request: PULL_REQUEST } })
      )
    ).toBe('7');
    expect(pullRequestNumber(commentRequest())).toBe('7');
    expect(pullRequestNumber(event())).toBe('');
  });
});

describe('isLinkFreeFile', () => {
  it('accepts a regular file and reports a missing one', () => {
    expect(isLinkFreeFile(repository, 'functions/a.py')).toBe(true);
    expect(isLinkFreeFile(repository, 'docs/threatmodel.md')).toBe(false);
  });

  it('refuses a symlink anywhere on the path, and a directory', () => {
    // e.g. a tracked docs/threatmodel.md -> /proc/self/environ inside the scanner container.
    expect(() => isLinkFreeFile(repository, 'linked/hosts')).toThrow('symlink');
    expect(() => isLinkFreeFile(repository, 'linked')).toThrow('symlink');
    expect(() => isLinkFreeFile(repository, 'functions')).toThrow('not a regular file');
  });
});

describe('originMatches', () => {
  it.each([
    ['https://github.com/averlon-security/kca.git', true],
    ['git@github.com:averlon-security/kca.git', true],
    ['https://x-access-token:ghs_secret@github.com/averlon-security/kca.git', false],
    ['https://github.com/someone/kca.git', false],
  ])('%s -> %s', (url, expected) =>
    expect(originMatches(url, 'averlon-security/kca')).toBe(expected)
  );
});

describe('resolveTarget', () => {
  const inputs = (
    values: Partial<{
      scope: 'repository' | 'diff';
      paths: string[];
      diffBase: string;
      dryRun: boolean;
    }> = {}
  ) => ({
    repository,
    scope: values.scope ?? 'repository',
    paths: values.paths ?? [],
    diffBase: values.diffBase ?? '',
    dryRun: values.dryRun ?? false,
  });

  it('scans the repository at the event commit', async () => {
    const target = await resolveTarget(inputs(), event(), noLastScan, fakeGit());
    expect(target).toMatchObject({
      kind: 'repository',
      scannedSha: HEAD,
      analysisRef: 'refs/heads/main',
      publishable: true,
    });
  });

  it('refuses a checkout with local changes', async () => {
    await expect(
      resolveTarget(inputs(), event(), noLastScan, fakeGit({ status: { stdout: ' M a.py\0' } }))
    ).rejects.toThrow('local changes');
  });

  it('refuses a checkout that kept credentials', async () => {
    const git = fakeGit({ config: { stdout: 'local\thttp.https://github.com/.extraheader\n' } });
    await expect(resolveTarget(inputs(), event(), noLastScan, git)).rejects.toThrow(
      'retains Git authentication'
    );
  });

  it('refuses a checkout at another commit', async () => {
    await expect(
      resolveTarget(inputs(), event({ sha: BASE }), noLastScan, fakeGit())
    ).rejects.toThrow('must match GITHUB_SHA');
  });

  it('refuses paths through a symlink or outside the checkout', async () => {
    await expect(
      resolveTarget(inputs({ paths: ['linked'] }), event(), noLastScan, fakeGit())
    ).rejects.toThrow('symlinks');
    await expect(
      resolveTarget(inputs({ paths: ['missing'] }), event(), noLastScan, fakeGit())
    ).rejects.toThrow('does not exist');
  });

  it('diffs from an explicit base', async () => {
    const target = await resolveTarget(
      inputs({ scope: 'diff', diffBase: BASE }),
      event(),
      noLastScan,
      fakeGit()
    );
    expect(target).toMatchObject({ kind: 'diff', diffBase: BASE });
  });

  it('diffs a pull request from its merge base', async () => {
    const payload = {
      number: 7,
      pull_request: {
        number: 7,
        head: { repo: { full_name: 'averlon-security/kca' }, sha: HEAD },
        base: { repo: { full_name: 'averlon-security/kca' }, sha: 'b'.repeat(40) },
      },
    };
    const target = await resolveTarget(
      inputs({ scope: 'diff' }),
      event({ eventName: 'pull_request', payload }),
      noLastScan,
      fakeGit()
    );
    expect(target).toMatchObject({ kind: 'diff', diffBase: BASE, analysisRef: 'refs/pull/7/head' });
  });

  it("diffs a comment request's pull request from its merge base", async () => {
    const target = await resolveTarget(
      inputs({ scope: 'diff' }),
      commentRequest(),
      noLastScan,
      fakeGit()
    );
    expect(target).toMatchObject({ kind: 'diff', diffBase: BASE, analysisRef: 'refs/pull/7/head' });
  });

  it("refuses a comment request whose checkout is not the pull request's head", async () => {
    // The pull request was pushed to between the comment and the checkout.
    const moved = { ...PULL_REQUEST, head: { ...PULL_REQUEST.head, sha: 'd'.repeat(40) } };
    await expect(
      resolveTarget(
        inputs({ scope: 'diff' }),
        commentRequest({ pullRequest: moved }),
        noLastScan,
        fakeGit()
      )
    ).rejects.toThrow('comment again');
  });

  it('requires a diff base outside pull requests', async () => {
    await expect(
      resolveTarget(inputs({ scope: 'diff' }), event(), noLastScan, fakeGit())
    ).rejects.toThrow(TargetError);
  });

  it('validates a dry run of an empty diff instead of skipping it, as upstream does', async () => {
    const target = await resolveTarget(
      inputs({ scope: 'diff', diffBase: BASE, dryRun: true }),
      event(),
      noLastScan,
      fakeGit({ diff: { status: 0 } })
    );
    expect(target).toMatchObject({ kind: 'diff', diffBase: BASE, skipReason: '' });
    const nothingNew = await resolveTarget(
      inputs({ scope: 'diff', diffBase: 'last-scan', dryRun: true }),
      event(),
      async () => ({ kind: 'skip', base: HEAD, reason: 'nothing new' }),
      fakeGit({ diff: { status: 0 } })
    );
    expect(nothingNew).toMatchObject({ kind: 'diff', diffBase: HEAD });
  });

  it('skips an empty diff', async () => {
    const target = await resolveTarget(
      inputs({ scope: 'diff', diffBase: BASE }),
      event(),
      noLastScan,
      fakeGit({ diff: { status: 0 } })
    );
    expect(target).toMatchObject({ kind: 'skip', skipReason: 'empty-diff' });
  });

  it.each([
    [{ kind: 'diff', base: BASE, reason: 'since' }, 'diff'],
    [{ kind: 'skip', base: '', reason: 'nothing new' }, 'skip'],
    [{ kind: 'full', base: '', reason: 'no earlier scan' }, 'repository'],
  ] as [ScanPlan, string][])("follows last-scan's plan %j", async (decided, kind) => {
    const target = await resolveTarget(
      inputs({ scope: 'diff', diffBase: 'last-scan' }),
      event(),
      async () => decided,
      fakeGit()
    );
    expect(target.kind).toBe(kind as 'diff' | 'skip' | 'repository');
  });
});
