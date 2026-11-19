/**
 * The action's post step: stops any scanner container still running, then deletes the stage.
 *
 * A cancelled or timed-out job stops the action's own process, but the containers belong to
 * the Docker daemon and would keep running, and spending, until the runner is torn down. The
 * stage holds Codex's state, whose transcripts can hold credentials; the main step deletes it,
 * except the reports later steps read, and this step deletes whatever is left once the job's
 * steps are done, including after a cancellation the main step did not survive.
 */
import * as core from '@actions/core';
import { discardWorkspace, killContainer } from '@averlon-ai/cynos-scan-engine';

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

if (require.main === module) cleanup();
