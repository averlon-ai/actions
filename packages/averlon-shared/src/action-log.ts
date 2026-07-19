/**
 * Standard logging for Averlon GitHub Actions.
 *
 * | API          | When to use                                      | Visible by default |
 * |--------------|--------------------------------------------------|--------------------|
 * | logDebug     | Internal trace (HTTP, tokens, parsing)           | No (Actions debug) |
 * | logVerbose   | Diagnostic progress (per-issue sync, OpenSearch) | Only if verbose    |
 * | logInfo      | Milestones and run summaries                     | Yes                |
 * | logWarn      | Recoverable problems                             | Yes                |
 * | logError     | Failures                                         | Yes                |
 *
 * Call configureActionLogging({ verbose }) once per action run (maps to the `verbose` input).
 * logVerbose also emits at info level when ACTIONS_STEP_DEBUG / runner debug is enabled.
 */

import * as core from '@actions/core';

let verboseMode = false;

export interface ActionLogConfig {
  /** Action `verbose` input — enables logVerbose at info level. */
  verbose?: boolean;
}

export function configureActionLogging(config: ActionLogConfig = {}): void {
  verboseMode = Boolean(config.verbose);
}

export function isVerboseLoggingEnabled(): boolean {
  return verboseMode || core.isDebug();
}

/** Internal trace — always routed to Actions debug log. */
export function logDebug(message: string): void {
  core.debug(message);
}

/** Diagnostic detail — info when verbose or runner debug; otherwise debug. */
export function logVerbose(message: string): void {
  if (isVerboseLoggingEnabled()) {
    core.info(message);
  } else {
    core.debug(message);
  }
}

/** User-visible milestones and summaries — always info. */
export function logInfo(message: string): void {
  core.info(message);
}

export function logWarn(message: string): void {
  core.warning(message);
}

export function logError(message: string): void {
  core.error(message);
}

/** @deprecated Use configureActionLogging */
export function setVerboseLogging(enabled: boolean): void {
  configureActionLogging({ verbose: enabled });
}

/** @deprecated Use logVerbose */
export function logDetail(message: string): void {
  logVerbose(message);
}
