import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { ScanTelemetry } from '@averlon-ai/cynos-scan-engine';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubActionsCacheStore, type CacheClient } from '../ci-cache';
import {
  actionRepository,
  actionVersion,
  finishLostRun,
  finishRun,
  finishRunOnCancel,
  LOST_RUN_KIND,
  LOST_RUN_MESSAGE,
  scanFinish,
  stepFailure,
} from '../telemetry';

/** A cache client whose every call fails, as when the Actions cache service is down. */
const failingCache: CacheClient = {
  isFeatureAvailable: () => true,
  restoreCache: async () => {
    throw new Error('cache service down');
  },
  saveCache: async () => {
    throw new Error('cache service down');
  },
};

describe('actionRepository', () => {
  it("names the repository as the engine's repositoryIdentity reads its remote", () => {
    expect(actionRepository('Acme', 'API', { GITHUB_SERVER_URL: 'https://github.com' })).toBe(
      'github.com/acme/api'
    );
    expect(actionRepository('acme', 'api', { GITHUB_SERVER_URL: 'https://ghe.example.com' })).toBe(
      'ghe.example.com/acme/api'
    );
    expect(actionRepository('acme', 'api', {})).toBe('github.com/acme/api');
  });
});

describe('actionVersion', () => {
  it("is the action's ref as cynos takes it: a tag or commit as is, a branch cut to its name rules", () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(actionVersion({ GITHUB_ACTION_REF: 'v2.1.1' })).toBe('v2.1.1');
    expect(actionVersion({ GITHUB_ACTION_REF: sha })).toBe(sha);
    expect(actionVersion({ GITHUB_ACTION_REF: 'feature/fix#12@home' })).toBe('feature/fix-12-home');
    const long = `feature/${'x'.repeat(80)}`;
    expect(actionVersion({ GITHUB_ACTION_REF: long })).toBe(long.slice(0, 64));
    expect(actionVersion({})).toBe('unknown');
  });
});

describe('scanFinish', () => {
  const outcome = {
    scanStatus: 'completed',
    policyStatus: 'failed',
    reason: '',
    skipReason: '',
  } as const;

  it('counts a policy failure as a completed scan, with its size', () => {
    expect(
      scanFinish(
        { outcome, knowledgeBase: { kind: 'diff', changed_files: 14 } as never },
        text => text
      )
    ).toEqual({ outcome: 'completed', changedFiles: 14 });
  });

  it("reports upstream's failure with its reason redacted", () => {
    expect(
      scanFinish(
        {
          outcome: { ...outcome, scanStatus: 'failed', reason: 'upstream stopped: secret-1' },
          knowledgeBase: undefined,
        },
        text => text.replace('secret-1', '***')
      )
    ).toEqual({ outcome: 'failed', errorKind: 'upstream', error: 'upstream stopped: ***' });
  });
});

describe('stepFailure', () => {
  it("is the engine's when the scan threw, and the action's, keeping the scan's size, after it returned", () => {
    expect(stepFailure(undefined, 'scan crashed')).toEqual({
      outcome: 'failed',
      errorKind: 'engine',
      error: 'scan crashed',
    });
    expect(stepFailure({ outcome: 'completed', productFiles: 812 }, 'upload failed')).toEqual({
      outcome: 'failed',
      errorKind: 'action',
      error: 'upload failed',
      productFiles: 812,
    });
  });
});

describe('GitHubActionsCacheStore failures', () => {
  it('tells telemetry of a failed restore and a failed save, which it otherwise logs as a miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-cache-telemetry-'));
    const dir = join(root, 'stage', 'knowledge-base-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'answers.json'), '{}');
    const failed: string[] = [];
    const store = new GitHubActionsCacheStore(
      () => {},
      join(root, 'cache'),
      failingCache,
      undefined,
      new Set(),
      step => failed.push(step)
    );

    expect(await store.restore(dir, 'abc', [], () => false)).toBeUndefined();
    await store.save(dir, 'abc', undefined);
    expect(failed).toEqual(['cache_restore', 'cache_save']);
  });

  // @actions/cache catches its own service failures: a failed restore answers undefined, as a
  // miss does, and a failed save answers -1, as a skipped one does.
  it('tells a failed restore from a miss: the entry a lookup found did not restore', async () => {
    const found = `cache-entry-abc`;
    const lookupFinds = (key: string | undefined) =>
      quietCache({ lookup: key, restore: undefined });
    const failedRestore = await cacheSteps(lookupFinds(found), store =>
      store.restore(store.dir, 'abc', [], () => false)
    );
    expect(failedRestore).toEqual(['cache_restore']);
    const miss = await cacheSteps(lookupFinds(undefined), store =>
      store.restore(store.dir, 'abc', [], () => false)
    );
    expect(miss).toEqual([]);
  });

  it("tells a failed save from a skipped one: not the cache mode's, nor another run's save", async () => {
    const save = (store: CacheStoreUnderTest) => store.save(store.dir, 'abc', undefined);
    expect(await cacheSteps(quietCache({ lookup: undefined, save: -1 }), save)).toEqual([
      'cache_save',
    ]);
    expect(
      await cacheSteps(quietCache({ lookup: 'saved by the other run', save: -1 }), save)
    ).toEqual([]);
    const readOnly = quietCache({ lookup: undefined, save: -1 });
    expect(await cacheSteps(readOnly, save, { ACTIONS_CACHE_MODE: 'read' })).toEqual([]);
    expect(readOnly.saves).toBe(0);
  });
});

/** A cache client that never throws, answering lookups, restores and saves as given. */
function quietCache(answers: { lookup: string | undefined; restore?: string; save?: number }) {
  const cache = {
    saves: 0,
    isFeatureAvailable: () => true,
    restoreCache: async (
      _paths: string[],
      _key: string,
      _restoreKeys?: string[],
      options?: { lookupOnly?: boolean }
    ) => (options?.lookupOnly ? answers.lookup : answers.restore),
    saveCache: async () => {
      cache.saves++;
      return answers.save ?? 1;
    },
  };
  return cache;
}

type CacheStoreUnderTest = GitHubActionsCacheStore & { dir: string };

/** The cache steps a store on `client` reports failed while `act` runs. */
async function cacheSteps(
  client: CacheClient,
  act: (store: CacheStoreUnderTest) => Promise<unknown>,
  env: NodeJS.ProcessEnv = {}
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'ci-cache-steps-'));
  const dir = join(root, 'stage', 'knowledge-base-cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), '{}');
  const failed: string[] = [];
  const store = Object.assign(
    new GitHubActionsCacheStore(
      () => {},
      join(root, 'cache'),
      client,
      undefined,
      new Set(),
      step => failed.push(step),
      env
    ),
    { dir }
  );
  await act(store);
  return failed;
}

/** A run's telemetry whose events are recorded instead of sent. */
function recordedTelemetry(): { telemetry: ScanTelemetry; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const telemetry = new ScanTelemetry({
    key: 'sk-cy-test',
    client: 'action',
    clientVersion: 'v2.1.1',
    kind: 'diff',
    runtime: 'docker',
    repository: 'github.com/acme/api',
    runId: 'run-0001-abcd',
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    },
  });
  return { telemetry, sent };
}

/** The step state the runner hands the post step: GITHUB_STATE, a file, for the test's run. */
function stepState(): { saved: () => string; restore: () => void } {
  const file = join(mkdtempSync(join(tmpdir(), 'step-state-')), 'state');
  writeFileSync(file, '');
  const before = process.env['GITHUB_STATE'];
  process.env['GITHUB_STATE'] = file;
  return {
    saved: () => readFileSync(file, 'utf8'),
    restore: () => {
      if (before === undefined) delete process.env['GITHUB_STATE'];
      else process.env['GITHUB_STATE'] = before;
    },
  };
}

/** Lets a handler's send, which is not awaited by anyone, settle. */
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe('finishRunOnCancel', () => {
  let state: ReturnType<typeof stepState>;
  beforeEach(() => {
    state = stepState();
  });
  afterEach(() => state.restore());

  it('finishes the run as cancelled on SIGINT, then exits as Node would have', async () => {
    const { telemetry, sent } = recordedTelemetry();
    const signals = new EventEmitter();
    const exits: number[] = [];
    const exited = new Promise<void>(resolve => {
      finishRunOnCancel(telemetry, signals, code => {
        exits.push(code);
        resolve();
      });
    });

    signals.emit('SIGINT', 'SIGINT');
    await exited;

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'run_finished', outcome: 'cancelled' });
    expect(sent[0]).not.toHaveProperty('error');
    expect(exits).toEqual([130]);
    expect(state.saved()).toContain('telemetry-finished');
  });

  it("leaves the process to the engine's stop while the scanner runs, and the step's own finish is not sent again", async () => {
    const { telemetry, sent } = recordedTelemetry();
    const signals = new EventEmitter();
    // The engine, while the scanner runs, stops it on the same signal.
    signals.on('SIGINT', () => {});
    const exits: number[] = [];
    finishRunOnCancel(telemetry, signals, code => exits.push(code));

    signals.emit('SIGINT', 'SIGINT');
    await settled();
    // The engine's stop returns the scan as failed by the cancellation; the step finishes with it.
    await finishRun(telemetry, {
      outcome: 'failed',
      errorKind: 'upstream',
      error: 'job cancelled (SIGINT)',
    });

    expect(exits).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it("counts only the first signal: the runner's SIGTERM after SIGINT changes nothing", async () => {
    const { telemetry, sent } = recordedTelemetry();
    const signals = new EventEmitter();
    const exits: number[] = [];
    finishRunOnCancel(telemetry, signals, code => exits.push(code));

    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGTERM', 'SIGTERM');
    await settled();

    expect(sent).toHaveLength(1);
    expect(exits).toEqual([130]);
  });

  it('stops listening once the run has finished on its own', async () => {
    const { telemetry, sent } = recordedTelemetry();
    const signals = new EventEmitter();
    const stop = finishRunOnCancel(telemetry, signals, () => {});

    stop();
    signals.emit('SIGINT', 'SIGINT');
    await settled();

    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('finishLostRun', () => {
  const names = ['STATE_telemetry-run', 'STATE_telemetry-finished', 'INPUT_CYNOS-API-KEY'];
  let before: Record<string, string | undefined>;
  let realFetch: typeof globalThis.fetch;
  let sent: Record<string, unknown>[];
  beforeEach(() => {
    before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    realFetch = globalThis.fetch;
    sent = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    // The main step saved the run when it started.
    process.env['STATE_telemetry-run'] = JSON.stringify({ runId: 'run-0001-abcd', kind: 'diff' });
    process.env['INPUT_CYNOS-API-KEY'] = 'sk-cy-test';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
  const env = { GITHUB_REPOSITORY: 'acme/api', GITHUB_WORKSPACE: '/home/runner/work/api' };

  it('finishes a run the main step started and never finished as lost: it died without being cancelled', async () => {
    await finishLostRun(env);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'run_finished',
      run_id: 'run-0001-abcd',
      outcome: 'failed',
      error: { step: 'run', kind: LOST_RUN_KIND, message: LOST_RUN_MESSAGE },
    });
  });

  it('sends nothing for a run the main step finished, a cancelled one included', async () => {
    process.env['STATE_telemetry-finished'] = 'true';

    await finishLostRun(env);

    expect(sent).toEqual([]);
  });
});
