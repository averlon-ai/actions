import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceFiles, keepEvidence, shouldUploadEvidence } from '../evidence';
import {
  CI_CACHE_PREFIX,
  GitHubActionsCacheStore,
  restorableRefs,
  restoreOnly,
  type CacheClient,
  type CacheEntries,
} from '../ci-cache';

/** No commit is in the checkout's history. */
const none = (): boolean => false;

/**
 * A cache client that records its calls. A restore that hits writes `entry` into the restored
 * path, as @actions/cache extracts an entry where it was saved from.
 */
function fakeCache(available: boolean, restored?: string, fail = false) {
  const calls: string[] = [];
  const client: CacheClient = {
    isFeatureAvailable: () => available,
    restoreCache: async (paths, key, restoreKeys) => {
      calls.push(`restore ${paths.join()} ${key} ${restoreKeys?.join()}`);
      if (fail) throw new Error('cache service down');
      if (restored) {
        mkdirSync(paths[0], { recursive: true });
        writeFileSync(join(paths[0], 'entry'), restored);
      }
      return restored;
    },
    saveCache: async (paths, key) => {
      calls.push(`save ${paths.join()} ${key}`);
      if (fail) throw new Error('cache service down');
      return 1;
    },
  };
  return { client, calls };
}

/**
 * A store on a fake client, with its fixed path and a scan's working directory; `entries` lists
 * the repository's entries, of which `refs`' are restorable.
 */
function fakeStore(
  available: boolean,
  restored?: string,
  fail = false,
  entries?: CacheEntries,
  refs = new Set<string>()
) {
  const root = mkdtempSync(join(tmpdir(), 'ci-cache-'));
  const path = join(root, 'cynos-scan-knowledge-base-cache');
  const dir = join(root, 'stage', 'knowledge-base-cache');
  const log: string[] = [];
  const { client, calls } = fakeCache(available, restored, fail);
  const store = new GitHubActionsCacheStore(m => log.push(m), path, client, entries, refs);
  return { store, calls, log, path, dir };
}

describe('GitHubActionsCacheStore', () => {
  it("restores this repository's newest entry by prefix, and saves under the commit", async () => {
    const { store, calls, path, dir } = fakeStore(true, `${CI_CACHE_PREFIX}old`);
    const restored = await store.restore(dir, 'abc', [], none);
    expect(restored).toBe(`${CI_CACHE_PREFIX}old`);
    await store.save(dir, 'abc', restored);
    expect(calls).toEqual([
      `restore ${path} ${CI_CACHE_PREFIX}abc ${CI_CACHE_PREFIX}`,
      `save ${path} ${CI_CACHE_PREFIX}abc`,
    ]);
  });

  it("restores a diff from its base commit's entry before the newest", async () => {
    const { store, calls, path, dir } = fakeStore(true, `${CI_CACHE_PREFIX}base`);
    await store.restore(dir, 'head', ['base'], none);
    expect(calls).toEqual([
      `restore ${path} ${CI_CACHE_PREFIX}head ${CI_CACHE_PREFIX}base,${CI_CACHE_PREFIX}`,
    ]);
  });

  it('restores the newest restorable entry of an ancestor before a newer one outside the history', async () => {
    // m3, the default branch's latest full scan, is newer than the branch; m1 is in its history;
    // another pull request's entry is in it too, but this run cannot restore that ref's entries.
    const entry = (sha: string, ref: string, day: number) => ({
      key: `${CI_CACHE_PREFIX}${sha}`,
      ref,
      created_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
    });
    const entries: CacheEntries = async () => [
      entry('m1', 'refs/heads/main', 1),
      entry('m3', 'refs/heads/main', 3),
      entry('other', 'refs/pull/7/merge', 5),
      entry('m0', 'refs/heads/main', 0),
    ];
    const ancestors = new Set(['m0', 'm1', 'other']);
    const { store, calls, path, dir } = fakeStore(
      true,
      `${CI_CACHE_PREFIX}m1`,
      false,
      entries,
      new Set(['refs/heads/main', 'refs/pull/9/merge'])
    );
    await store.restore(dir, 'head', ['base'], sha => ancestors.has(sha));
    expect(calls).toEqual([
      `restore ${path} ${CI_CACHE_PREFIX}head ${CI_CACHE_PREFIX}base,${CI_CACHE_PREFIX}m1,${CI_CACHE_PREFIX}`,
    ]);
  });

  it('restores as before when the entries cannot be listed, and logs why', async () => {
    const { store, calls, log, path, dir } = fakeStore(
      true,
      undefined,
      false,
      async () => {
        throw new Error('Resource not accessible by integration');
      },
      new Set(['refs/heads/main'])
    );
    await store.restore(dir, 'head', ['base'], () => true);
    expect(calls).toEqual([
      `restore ${path} ${CI_CACHE_PREFIX}head ${CI_CACHE_PREFIX}base,${CI_CACHE_PREFIX}`,
    ]);
    expect(log[0]).toContain('Resource not accessible by integration');
  });

  it("keeps the entries at one fixed path, and copies to and from the scan's directory", async () => {
    const { store, path, dir } = fakeStore(true, `${CI_CACHE_PREFIX}old`);
    await store.restore(dir, 'abc', [], none);
    expect(readFileSync(join(dir, 'entry'), 'utf8')).toBe(`${CI_CACHE_PREFIX}old`);
    writeFileSync(join(dir, 'jev-answers.jsonl'), 'answers');
    await store.save(dir, 'abc', `${CI_CACHE_PREFIX}old`);
    expect(readFileSync(join(path, 'jev-answers.jsonl'), 'utf8')).toBe('answers');
  });

  it("starts each restore from an empty fixed path: no earlier scan's files on a miss or a hit", async () => {
    const miss = fakeStore(true);
    mkdirSync(miss.path, { recursive: true });
    writeFileSync(join(miss.path, 'review.json'), 'an earlier scan');
    expect(await miss.store.restore(miss.dir, 'abc', [], none)).toBeUndefined();
    expect(existsSync(join(miss.dir, 'review.json'))).toBe(false);
    const hit = fakeStore(true, `${CI_CACHE_PREFIX}old`);
    mkdirSync(hit.path, { recursive: true });
    writeFileSync(join(hit.path, 'review.json'), 'an earlier scan');
    await hit.store.restore(hit.dir, 'abc', [], none);
    expect(readFileSync(join(hit.dir, 'entry'), 'utf8')).toBe(`${CI_CACHE_PREFIX}old`);
    expect(existsSync(join(hit.dir, 'review.json'))).toBe(false);
  });

  it('does not save over the same commit, and only logs when the service fails', async () => {
    const same = fakeStore(true);
    mkdirSync(same.dir, { recursive: true });
    await same.store.save(same.dir, 'abc', `${CI_CACHE_PREFIX}abc`);
    expect(same.calls).toEqual([]);
    const down = fakeStore(true, undefined, true);
    expect(await down.store.restore(down.dir, 'abc', [], none)).toBeUndefined();
    mkdirSync(down.dir, { recursive: true });
    await down.store.save(down.dir, 'abc', undefined);
    expect(down.log.length).toBe(2);
    expect(down.log.every(m => m.includes('cache service down'))).toBe(true);
    const off = fakeStore(false);
    await off.store.restore(off.dir, 'abc', [], none);
    expect(off.calls).toEqual([]);
  });
});

describe('restorableRefs', () => {
  it("are the run's own ref, a pull request's base branch and the default branch", () => {
    expect([
      ...restorableRefs('main', { GITHUB_REF: 'refs/pull/9/merge', GITHUB_BASE_REF: 'release' }),
    ]).toEqual(['refs/heads/main', 'refs/pull/9/merge', 'refs/heads/release']);
    expect([...restorableRefs('main', { GITHUB_REF: 'refs/heads/main' })]).toEqual([
      'refs/heads/main',
    ]);
  });
});

describe('restoreOnly', () => {
  it("restores as the store does, and never saves: a comment request's entries", async () => {
    const { store, calls, log, path, dir } = fakeStore(true, `${CI_CACHE_PREFIX}base`);
    const comment = restoreOnly(store, m => log.push(m));
    const restored = await comment.restore(dir, 'head', ['base'], none);
    await comment.save(dir, 'head', restored);
    expect(calls).toEqual([
      `restore ${path} ${CI_CACHE_PREFIX}head ${CI_CACHE_PREFIX}base,${CI_CACHE_PREFIX}`,
    ]);
    expect(log.at(-1)).toContain('not saved');
  });
});

describe('evidence', () => {
  it("keeps the briefs, index, review log and helper results, never the review agent's home", () => {
    const stage = mkdtempSync(join(tmpdir(), 'evidence-stage-'));
    const put = (path: string): void => {
      mkdirSync(join(stage, path, '..'), { recursive: true });
      writeFileSync(join(stage, path), path);
    };
    for (const path of [
      'knowledge-base/output/code-graph.md',
      'knowledge-base/output/threat-model.json',
      'knowledge-base/kb/packets/auth.md',
      'knowledge-base/kb/files.tsv',
      'knowledge-base/architecture-review-debug.json',
      'knowledge-base/review/events.jsonl',
      'knowledge-base/review/home/.codex/sessions/s.jsonl',
      'knowledge-base/graph/index.db',
      'out/scan/artifacts/helpers/packet_auth.json',
      'out/scan/findings.json',
    ])
      put(path);
    const files = evidenceFiles(stage).map(p => p.slice(stage.length + 1));
    expect(files.sort()).toEqual([
      'knowledge-base/architecture-review-debug.json',
      'knowledge-base/kb/files.tsv',
      'knowledge-base/kb/packets/auth.md',
      'knowledge-base/output/code-graph.md',
      'knowledge-base/output/threat-model.json',
      'knowledge-base/review/events.jsonl',
      'out/scan/artifacts/helpers/packet_auth.json',
    ]);
    const kept = mkdtempSync(join(tmpdir(), 'evidence-kept-'));
    keepEvidence(stage, kept);
    expect(readFileSync(join(kept, 'knowledge-base/kb/packets/auth.md'), 'utf8')).toBe(
      'knowledge-base/kb/packets/auth.md'
    );
  });

  it('uploads automatically only for a private repository', () => {
    expect(shouldUploadEvidence('auto', true)).toBe(true);
    expect(shouldUploadEvidence('auto', false)).toBe(false);
    expect(shouldUploadEvidence('auto', undefined)).toBe(false);
    expect(shouldUploadEvidence('true', false)).toBe(true);
    expect(shouldUploadEvidence('false', true)).toBe(false);
  });
});
