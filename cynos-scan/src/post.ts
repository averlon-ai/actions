/**
 * The action's post step: stops any scanner container still running, deletes the stage, then
 * reports a scan the main step started and did not finish as lost: a cancelled main step finishes
 * its run itself, so one that did not died without being asked to stop (telemetry.ts).
 *
 * A cancelled or timed-out job stops the action's own process, but the containers belong to
 * the Docker daemon and would keep running, and spending, until the runner is torn down. The
 * stage holds Codex's state, whose transcripts can hold credentials; the main step deletes it,
 * except the reports later steps read, and this step deletes whatever is left once the job's
 * steps are done, including after a cancellation the main step did not survive.
 */
import * as core from '@actions/core';
import { discardWorkspace, killContainer } from '@averlon-ai/cynos-scan-engine';
import { finishLostRun } from './telemetry';

export function cleanup(): void {
  let names: string[] = [];
  try {
    names = JSON.parse(core.getState('containers') || '[]');
  } catch {
    return;
  }
  for (const name of names) killContainer(name);
  const stage = core.getState('stage');
  if (stage) discardWorkspace(stage, false);
}

/** Cleans up first: the containers keep spending until stopped, and telemetry may wait 3 seconds. */
export async function post(): Promise<void> {
  cleanup();
  await finishLostRun();
}

if (require.main === module) void post();
