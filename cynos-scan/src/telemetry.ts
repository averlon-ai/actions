/**
 * The action's scan telemetry: the engine's ScanTelemetry, which reports each scan's start and
 * finish to cynos, with what only the action knows around it.
 *
 * A job can end without the main step finishing its run, in two ways the alerts must tell apart:
 *
 *   cancelled  someone cancelled the job, a newer run cancelled it (concurrency), or the job hit
 *              its timeout-minutes. The runner sends the step SIGINT, then SIGTERM 7.5 s later,
 *              then kills it 2.5 s after that (the runner's ProcessInvoker). Not a fault.
 *   lost       the step's process died without being asked: killed by the kernel (out of
 *              memory) or crashed. A fault, and the alerts should see it.
 *
 * A cancellation always starts with a signal the step can catch; a lost process gets none. So the
 * main step finishes a cancelled run itself, from its signal handler, and the post step, which
 * runs whatever happened (`post-if: always()`), finishes only what is left: a run the main step
 * started and never finished was lost. The step state carries the run between the two steps:
 *
 *   main  started:    save the run (its id and kind), send run_started
 *         cancelled:  send run_finished as cancelled, save that it was sent (finishRunOnCancel)
 *         done:       send run_finished, save that it was sent
 *   post  the run saved and not finished: send run_finished as failed, kind lost
 *
 * The runner reads the state a step saved once the step's process has ended, cancelled or not,
 * so the post step sees a finish the signal handler saved. A runner killed outright runs no post
 * step; that run stays started and never finished.
 */
import * as core from '@actions/core';
import {
  ScanTelemetry,
  type RunFinish,
  type ScanKind,
  type ScanResult,
} from '@averlon-ai/cynos-scan-engine';
import { parseInputs, type Inputs } from './inputs';

/** The step state that carries a started run to the post step. */
const STARTED_STATE = 'telemetry-run';
const FINISHED_STATE = 'telemetry-finished';

/** The signals the runner cancels a step with, and the exit code each stops a process with. */
const CANCEL_SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;
type CancelSignal = keyof typeof CANCEL_SIGNALS;

/** The error kind of a run whose main step died without being cancelled. */
export const LOST_RUN_KIND = 'lost';
export const LOST_RUN_MESSAGE =
  'The scan step ended without finishing its run and was not cancelled: its process was killed (for example, out of memory) or crashed.';

interface StartedRun {
  runId: string;
  kind: ScanKind;
}

/**
 * The repository's identity as the engine's repositoryIdentity reads a remote, so the CLI's runs
 * of a checkout and the action's runs of its repository hash the same: `<host>/<owner>/<repo>`.
 */
export function actionRepository(
  owner: string,
  repo: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let host = 'github.com';
  try {
    host = new URL(env['GITHUB_SERVER_URL'] ?? '').host || host;
  } catch {
    // Not set outside Actions: github.com.
  }
  return `${host}/${owner}/${repo}`.toLowerCase();
}

/**
 * The action's version as cynos takes it: the ref the workflow uses the action at, its release
 * tag or the commit it is pinned to. cynos refuses an event whose version is not 1 to 64 letters,
 * digits or . _ / + -, and a branch ref can be longer or hold other characters, so any other
 * character becomes - and the ref is cut to 64. "unknown" outside a workflow.
 */
export function actionVersion(env: NodeJS.ProcessEnv = process.env): string {
  const ref = (env['GITHUB_ACTION_REF'] ?? '').replace(/[^A-Za-z0-9._/+-]/g, '-').slice(0, 64);
  return ref || 'unknown';
}

/**
 * The run's telemetry: the scan's key and endpoint, the action's ref as its version, and nothing
 * sent for a scan that makes no model calls (mock, dry run).
 */
export function actionTelemetry(
  inputs: Inputs,
  scan: { kind: ScanKind; owner: string; repo: string; checkout: string; runId?: string },
  env: NodeJS.ProcessEnv = process.env
): ScanTelemetry {
  return new ScanTelemetry({
    key: inputs.cynosApiKey,
    ...(inputs.baseUrl ? { baseUrl: inputs.baseUrl } : {}),
    client: 'action',
    clientVersion: actionVersion(env),
    kind: scan.kind,
    runtime: inputs.runtime,
    repository: actionRepository(scan.owner, scan.repo, env),
    checkout: scan.checkout,
    enabled: !inputs.mock && !inputs.dryRun,
    ...(scan.runId ? { runId: scan.runId } : {}),
  });
}

/**
 * How a scan that returned ended: completed unless upstream failed it (a policy failure is a
 * completed scan), with the size its duration depends on. `redact` removes the action's secrets
 * from upstream's reason; the engine removes the key and the checkout's path.
 */
export function scanFinish(
  scan: Pick<ScanResult, 'outcome' | 'knowledgeBase'>,
  redact: (text: string) => string
): RunFinish {
  const size = scan.knowledgeBase
    ? scan.knowledgeBase.kind === 'diff'
      ? { changedFiles: scan.knowledgeBase.changed_files }
      : { productFiles: scan.knowledgeBase.product_files }
    : {};
  if (scan.outcome.scanStatus !== 'failed') return { outcome: 'completed', ...size };
  return { outcome: 'failed', errorKind: 'upstream', error: redact(scan.outcome.reason), ...size };
}

/**
 * How a run whose step threw ended: failed, with `message`. Without `scanned`, the scan threw
 * (the engine's failure); with it, the scan returned `scanned` and a later operation threw, such
 * as an artifact upload (the action's), and the run keeps the scan's size.
 */
export function stepFailure(scanned: RunFinish | undefined, message: string): RunFinish {
  if (!scanned) return { outcome: 'failed', errorKind: 'engine', error: message };
  const { changedFiles, productFiles } = scanned;
  return { outcome: 'failed', errorKind: 'action', error: message, changedFiles, productFiles };
}

/** Saves the run for the post step, then sends run_started. */
export async function startRun(telemetry: ScanTelemetry, kind: ScanKind): Promise<void> {
  const started: StartedRun = { runId: telemetry.runId, kind };
  core.saveState(STARTED_STATE, JSON.stringify(started));
  await telemetry.started();
}

/** Sends run_finished, then records that it was sent, so the post step does not repeat it. */
export async function finishRun(telemetry: ScanTelemetry, finish: RunFinish): Promise<void> {
  await telemetry.finished(finish);
  core.saveState(FINISHED_STATE, 'true');
}

/** What finishRunOnCancel listens on: the process. */
export interface SignalSource {
  on(signal: CancelSignal, listener: (signal: CancelSignal) => void): unknown;
  off(signal: CancelSignal, listener: (signal: CancelSignal) => void): unknown;
  listenerCount(signal: CancelSignal): number;
}

/**
 * Finishes the run as cancelled when the runner cancels the step, so a cancellation reaches cynos
 * as cancelled instead of being taken for a lost process by the post step. Returns the function
 * that stops listening, for once the run has finished on its own.
 *
 * A listener replaces Node's own exit on the signal, so the handler keeps what the process did
 * before it was added:
 *
 *   another listener  the engine, while the scanner runs, stops the scanner and lets the step
 *                     publish what it can (README: Limits); the handler only sends the finish, and
 *                     the step's own finish later is not sent again (ScanTelemetry sends one)
 *   none              Node would have exited at once; the handler exits once the finish is sent,
 *                     at most 3 seconds, well inside the 7.5 s before SIGTERM
 *
 * Only the first signal counts: the SIGTERM that follows a SIGINT changes nothing.
 */
export function finishRunOnCancel(
  telemetry: ScanTelemetry,
  signals: SignalSource = process,
  exit: (code: number) => void = code => process.exit(code)
): () => void {
  let cancelled = false;
  const onSignal = (signal: CancelSignal): void => {
    if (cancelled) return;
    cancelled = true;
    // Counted now: the engine stops listening once the scanner has stopped.
    const alone = signals.listenerCount(signal) === 1;
    void finishRun(telemetry, { outcome: 'cancelled' }).finally(() => {
      if (alone) exit(CANCEL_SIGNALS[signal]);
    });
  };
  const names = Object.keys(CANCEL_SIGNALS) as CancelSignal[];
  for (const name of names) signals.on(name, onSignal);
  return () => {
    for (const name of names) signals.off(name, onSignal);
  };
}

/**
 * The post step's part: a run the main step started and did not finish was lost. A cancellation
 * finishes the run in the main step (finishRunOnCancel), so what reaches here is a process that
 * died without being asked to stop.
 */
export async function finishLostRun(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (core.getState(FINISHED_STATE)) return;
  let started: StartedRun;
  let inputs: Inputs;
  try {
    started = JSON.parse(core.getState(STARTED_STATE)) as StartedRun;
    inputs = parseInputs(name => core.getInput(name), env['GITHUB_WORKSPACE'] ?? '', env);
  } catch {
    // No run started (the main step stopped before the scan), or nothing to send it with.
    return;
  }
  const [owner = '', repo = ''] = (env['GITHUB_REPOSITORY'] ?? '').split('/');
  const telemetry = actionTelemetry(
    inputs,
    {
      kind: started.kind,
      owner,
      repo,
      checkout: env['GITHUB_WORKSPACE'] ?? '',
      runId: started.runId,
    },
    env
  );
  await telemetry.finished({
    outcome: 'failed',
    errorKind: LOST_RUN_KIND,
    error: LOST_RUN_MESSAGE,
  });
}
