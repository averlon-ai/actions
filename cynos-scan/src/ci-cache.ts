/**
 * The knowledge-base cache (the engine's knowledge-base/cache.ts) carried between CI runs in the
 * GitHub Actions cache: the action's KnowledgeBaseStore.
 *
 * Without it every scan of a repository repeats the whole Jev labelling and the code graph: on
 * secdi-ai-harness about 17 minutes and $2.28 per run, though most files did not change since the
 * last scan. The cache directory holds Jev's answers (keyed by the hash of what each request sent)
 * and the code graph (keyed by the checkout's content), never source text and never a key:
 *
 *   restore  this commit's cache, else a preferred commit's (a diff's base, whose full scan stored
 *            its review), else the newest of a commit in the checkout's history, else the newest
 *            of this repository, by key prefix; a missing or unavailable cache only means a full
 *            build
 *   save     after a successful build, under this commit's key; Actions caches are immutable, so
 *            a rerun of the same commit keeps the first save
 *
 * The scan works in a directory of its own under its stage, which differs every run, but an
 * Actions cache entry is versioned by the paths it was saved from, and restores to them: an entry
 * saved from one stage would never match the next. So the entries keep one fixed path,
 * CACHE_DIRECTORY under RUNNER_TEMP, as before the store existed, and the store copies between it
 * and the scan's directory: restored into it and copied in, copied out and saved from it. That path
 * outlives the scan, so a restore clears it first and copies only an entry it restored: a second
 * scan in the job would otherwise start from the first's directory on a miss, and a hit would
 * land on top of its files.
 *
 * The newest entry is often not in the checkout's history: a pull request branched before the
 * default branch's latest full scan. Its review cannot be updated for the pull request's change,
 * so the diff would review the whole repository again, while an older entry of an ancestor has a
 * review it can update. Actions' own restore matches keys by prefix and cannot ask git, and takes
 * at most ten keys, so the store lists the entries (the Caches API), keeps those this run can
 * restore (its own ref's, its base branch's and the default branch's), and names the newest
 * ancestor's key before the bare prefix. A listing that fails only leaves that key out.
 *
 * Caches are scoped to the repository and readable by its own workflows only, the same audience
 * as the source the answers describe. Every failure is logged, never thrown: the cache saves
 * time, it never decides a scan.
 *
 * Telemetry still needs to tell a failure from a miss or a skip, and @actions/cache does not say:
 * it logs a failed restore and answers undefined, as for a miss, and logs a failed save and
 * answers -1, as for a save it skipped. So the store asks the cache again without downloading
 * (a lookup): an entry a lookup finds but the restore did not bring back is a failed restore, and
 * a save that answered -1 failed unless the cache mode forbids writes (checked first) or a lookup
 * finds the commit's entry, saved by another run of the same commit.
 */
import * as actionsCache from '@actions/cache';
import type { CacheStep, KnowledgeBaseStore } from '@averlon-ai/cynos-scan-engine';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bumped whenever the cached formats or the questions change meaning. */
export const CI_CACHE_PREFIX = 'cynos-scan-knowledge-base-v1-';

/** The directory every entry is saved from and restored to, under RUNNER_TEMP. */
export const CACHE_DIRECTORY = 'cynos-scan-knowledge-base-cache';

export type CacheClient = Pick<
  typeof actionsCache,
  'isFeatureAvailable' | 'restoreCache' | 'saveCache'
>;

/** An entry of the repository's Actions cache, as the Caches API lists it. */
export interface CacheEntry {
  key: string;
  /** The ref it was saved from: only this run's own, base and default refs' are restorable. */
  ref: string;
  created_at: string;
}

/** The entries whose key starts with `prefix`, every ref's (the Caches API). */
export type CacheEntries = (prefix: string) => Promise<CacheEntry[]>;

/**
 * The refs whose entries this run can restore: its own, a pull request's base branch's and the
 * default branch's (GitHub's cache scoping).
 */
export function restorableRefs(
  defaultBranch: string,
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const refs = new Set([`refs/heads/${defaultBranch}`]);
  if (env['GITHUB_REF']) refs.add(env['GITHUB_REF']);
  if (env['GITHUB_BASE_REF']) refs.add(`refs/heads/${env['GITHUB_BASE_REF']}`);
  return refs;
}

/**
 * Whether the runner's cache mode (ACTIONS_CACHE_MODE) permits a save, as @actions/cache decides
 * it: writes only with `write` or `write-only`, and an unset or unknown mode permits everything.
 */
export function cacheModeAllowsWrites(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env['ACTIONS_CACHE_MODE'] ?? '').trim().toLowerCase();
  if (!['none', 'read', 'write', 'write-only'].includes(mode)) return true;
  return mode === 'write' || mode === 'write-only';
}

/** The fixed path of the entries: CACHE_DIRECTORY under RUNNER_TEMP (the system temp locally). */
export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['RUNNER_TEMP'] || tmpdir(), CACHE_DIRECTORY);
}

/** Immutable Actions cache entries, one per scanned commit, keyed CI_CACHE_PREFIX<sha>. */
export class GitHubActionsCacheStore implements KnowledgeBaseStore {
  /**
   * @param entries Lists the repository's entries; without it, no ancestor's entry is preferred.
   * @param refs The refs whose entries this run can restore (restorableRefs).
   * @param failed Told of each restore or save that failed: the store logs the failure and goes
   *   on as on a miss, so without it the scan's telemetry would count a failed restore as a miss.
   * @param env The runner's environment, for its cache mode.
   */
  constructor(
    private readonly log: (message: string) => void,
    private readonly path: string = cachePath(),
    private readonly client: CacheClient = actionsCache,
    private readonly entries?: CacheEntries,
    private readonly refs: Set<string> = new Set(),
    private readonly failed: (step: CacheStep) => void = () => {},
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /**
   * Restores an entry into the fixed path: this commit's, else one of `preferred` commits', else
   * the newest of a commit `inHistory` accepts, else the newest; then fills `dir` from it. Returns
   * the key restored, or undefined.
   */
  async restore(
    dir: string,
    sha: string,
    preferred: string[],
    inHistory: (sha: string) => boolean
  ): Promise<string | undefined> {
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch (error) {
      this.log(`knowledge-base cache not restored: ${message(error)}`);
      this.failed('cache_restore');
      return undefined;
    }
    const ancestor = await this.newestAncestor(inHistory);
    const key = await this.restoreEntry(sha, [...preferred, ...(ancestor ? [ancestor] : [])]);
    if (key) this.copy(this.path, dir, 'restored');
    return key;
  }

  /**
   * The commit of the newest restorable entry in the checkout's history, or undefined: none, no
   * lister, or a listing that failed (logged).
   */
  private async newestAncestor(inHistory: (sha: string) => boolean): Promise<string | undefined> {
    if (!this.entries || !this.client.isFeatureAvailable()) return undefined;
    let listed: CacheEntry[];
    try {
      listed = await this.entries(CI_CACHE_PREFIX);
    } catch (error) {
      this.log(`knowledge-base cache entries not listed: ${message(error)}`);
      return undefined;
    }
    // Another ref's entry would not restore, so it must not stand in for a restorable ancestor.
    return listed
      .filter(e => e.key.startsWith(CI_CACHE_PREFIX) && this.refs.has(e.ref))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map(e => e.key.slice(CI_CACHE_PREFIX.length))
      .find(inHistory);
  }

  /** Copies `dir` to the fixed path and saves this commit's entry, unless restored from it. */
  async save(dir: string, sha: string, restored: string | undefined): Promise<void> {
    if (!this.copy(dir, this.path, 'saved')) return;
    await this.saveEntry(sha, restored);
  }

  /**
   * The Actions cache's restore into the fixed path, in the order the module comment lists. A
   * lookup first tells a miss from a failed restore, which both answer undefined.
   */
  private async restoreEntry(sha: string, preferred: string[]): Promise<string | undefined> {
    if (!this.client.isFeatureAvailable()) return undefined;
    const primary = `${CI_CACHE_PREFIX}${sha}`;
    const restoreKeys = [...preferred.map(s => `${CI_CACHE_PREFIX}${s}`), CI_CACHE_PREFIX];
    try {
      // A miss: no entry to restore, or a cache mode that forbids reads.
      const found = await this.lookup(primary, restoreKeys);
      if (!found) {
        this.log('no knowledge-base cache yet');
        return undefined;
      }
      // An entry the lookup found that the restore does not bring back failed to download or
      // extract (@actions/cache logged why).
      const key = await this.client.restoreCache([this.path], primary, restoreKeys);
      if (!key) {
        this.log(`knowledge-base cache not restored: ${found} was found but did not restore`);
        this.failed('cache_restore');
        return undefined;
      }
      this.log(`knowledge-base cache restored from ${key}`);
      return key;
    } catch (error) {
      this.log(`knowledge-base cache not restored: ${message(error)}`);
      this.failed('cache_restore');
      return undefined;
    }
  }

  /**
   * The Actions cache's save of the fixed path; entries are immutable, so never its own key. A
   * save answering -1 failed unless it was skipped: see the module comment.
   */
  private async saveEntry(sha: string, restored: string | undefined): Promise<void> {
    const key = `${CI_CACHE_PREFIX}${sha}`;
    if (!this.client.isFeatureAvailable() || restored === key) return;
    // A cache mode that forbids writes makes the save answer -1 without trying.
    if (!cacheModeAllowsWrites(this.env)) {
      this.log('knowledge-base cache not saved: the cache mode does not permit writes');
      return;
    }
    try {
      if ((await this.client.saveCache([this.path], key)) !== -1) {
        this.log(`knowledge-base cache saved as ${key}`);
        return;
      }
      // Another run of the same commit reserved the key first: its entry is this one.
      if (await this.lookup(key, [])) {
        this.log(`knowledge-base cache not saved: another run saved ${key}`);
        return;
      }
      this.log(`knowledge-base cache not saved as ${key} (@actions/cache logged why)`);
      this.failed('cache_save');
    } catch (error) {
      this.log(`knowledge-base cache not saved: ${message(error)}`);
      this.failed('cache_save');
    }
  }

  /** The key a restore would bring back, without downloading it; undefined if none. */
  private lookup(primary: string, restoreKeys: string[]): Promise<string | undefined> {
    return this.client.restoreCache([this.path], primary, restoreKeys, { lookupOnly: true });
  }

  /**
   * Replaces `to` with a copy of `from`, when `from` exists; false when the copy failed. The
   * fixed path holds exactly the scan's last directory, as when the scan worked in it directly.
   */
  private copy(from: string, to: string, what: 'restored' | 'saved'): boolean {
    if (!existsSync(from)) return true;
    try {
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true, mode: 0o700 });
      cpSync(from, to, { recursive: true });
      return true;
    } catch (error) {
      this.log(`knowledge-base cache not ${what}: ${message(error)}`);
      this.failed(what === 'restored' ? 'cache_restore' : 'cache_save');
      return false;
    }
  }
}

/**
 * store's restores without its saves, for a scan whose entries must not be shared: a comment
 * request's (main.ts), whose run is scoped to the default branch though it scans a pull request.
 */
export function restoreOnly(
  store: KnowledgeBaseStore,
  log: (message: string) => void
): KnowledgeBaseStore {
  return {
    restore: (dir, sha, preferred, inHistory) => store.restore(dir, sha, preferred, inHistory),
    async save() {
      log('knowledge-base cache not saved: a comment request saves nothing to the default branch');
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
