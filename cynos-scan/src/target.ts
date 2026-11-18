/**
 * What a scan covers, after upstream's checks on the caller's checkout
 * (openai/codex-security github-action/src/targets.ts).
 *
 * The caller checks out the repository. The action refuses a checkout that is not the
 * repository root, keeps credentials or external Git configuration, comes from another
 * repository, is not at the event's commit, or has local changes: the results would then not
 * describe the commit they are reported against. A diff scan needs a base: an explicit
 * diff-base, the merge base on a pull request, or (this action's extension) last-scan, the
 * commit of the last successful full or diff scan of the default branch. An empty diff is skipped,
 * except on a dry run, which validates the configuration whatever the diff (upstream's rule).
 *
 * A pull request is scanned on its own pull_request event or, this action's extension, on a
 * comment request: an issue_comment on the pull request asking for a scan, so that a workflow can
 * scan a pull request once when it opens and again only when asked. An issue_comment's payload
 * names the pull request only by number, so the caller fetches it (commentedPullRequest), and it
 * gets the same checks as a pull_request event's own: no forks, immutable revisions, and a checkout
 * of its head.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAST_SCAN } from './constants';
import { at, text, type JsonObject } from '@averlon-ai/cynos-scan-engine';
import type { Inputs } from './inputs';
import type { ScanPlan } from './last-scanned';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SUPPORTED_EVENTS = ['pull_request', 'issue_comment', 'schedule', 'workflow_dispatch', 'push'];
/**
 * Who may make a comment request: the repository's owner, members of its organization, and
 * collaborators. An issue_comment run holds the workflow's secrets, so anyone else's comment would
 * spend the cynos key's budget.
 */
const COMMENT_REQUESTERS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
/** Local Git configuration that carries credentials or pulls in configuration from elsewhere. */
const UNSAFE_CONFIG =
  /^credential\.|^http\..*extraheader$|^include\.path$|^includeif\..*\.path$|^core\.sshcommand$|^url\..*\.insteadof$/;

export class TargetError extends Error {}

export interface EventContext {
  eventName: string;
  repository: string;
  sha: string;
  ref: string;
  serverUrl: string;
  payload: JsonObject;
  /**
   * On an issue_comment event on a pull request, that pull request, from the API (the payload
   * names it only by number); unset on any other event.
   */
  commentedPullRequest?: JsonObject;
}

export interface Target {
  /** repository, diff, or skip (an empty diff, or nothing new since the last scan). */
  kind: 'repository' | 'diff' | 'skip';
  repository: string;
  scannedSha: string;
  analysisRef: string;
  publishable: boolean;
  diffBase: string;
  /** empty-diff when kind is skip. */
  skipReason: string;
  reason: string;
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Git = (args: string[]) => GitResult;

/** Runs Git in repository with no hooks, credential helpers or prompts, as upstream does. */
export function gitIn(repository: string): Git {
  return args => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=/bin/false',
        ...args,
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
        timeout: 60_000,
      }
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function git(run: Git, args: string[], accepted = [0]): GitResult {
  const result = run(args);
  if (result.status === null || !accepted.includes(result.status))
    throw new TargetError(
      `Git ${args[0]} failed. Check the checkout and fetch-depth: 0 for diff scans. ${(result.stderr || result.stdout).trim().slice(0, 300)}`
    );
  return result;
}

export function commit(run: Git, revision: string): string {
  const sha = git(run, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ]).stdout.trim();
  if (!SHA.test(sha)) throw new TargetError('Git revision did not resolve to a commit ID.');
  return sha;
}

/**
 * The pull request a run scans: a pull_request event's own, or a comment request's; undefined on
 * any other event.
 */
export function scannedPullRequest(
  event: Pick<EventContext, 'eventName' | 'payload' | 'commentedPullRequest'>
): unknown {
  if (event.eventName === 'pull_request') return event.payload['pull_request'];
  if (event.eventName === 'issue_comment') return event.commentedPullRequest;
  return undefined;
}

/**
 * Refuses an issue_comment that is not a comment request: a comment on an issue rather than a
 * pull request, by someone outside COMMENT_REQUESTERS, or on a pull request that is closed or was
 * not fetched. The workflow decides which comments ask for a scan; this checks who asked, and
 * where.
 */
function checkCommentRequest(event: EventContext): void {
  const issue = event.payload['issue'];
  if (!at(issue, 'pull_request'))
    throw new TargetError('A comment requests a scan only on a pull request, not on an issue.');
  if (!COMMENT_REQUESTERS.includes(text(at(event.payload, 'comment', 'author_association'))))
    throw new TargetError(
      "Only the repository's owner, its organization's members and its collaborators can request a scan by comment."
    );
  const pr = event.commentedPullRequest;
  if (!pr || text(at(pr, 'number')) !== text(at(issue, 'number')))
    throw new TargetError('The commented pull request could not be read.');
  if (text(at(pr, 'state')) !== 'open')
    throw new TargetError('The commented pull request is closed; scan only an open one.');
}

/**
 * Refuses events upstream refuses, including pull requests from forks. The one privileged event
 * accepted, issue_comment, is accepted only as a comment request (checkCommentRequest), and its
 * pull request gets the fork check below: it then scans what a pull_request run of the same pull
 * request would, with the same secrets.
 */
export function checkEvent(event: EventContext): void {
  if (!SUPPORTED_EVENTS.includes(event.eventName))
    throw new TargetError(
      `Unsupported event: ${event.eventName}. Use pull_request, issue_comment (a comment request on a pull request), schedule, workflow_dispatch, or push. Privileged PR source-scanning triggers such as pull_request_target are not supported.`
    );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(event.repository))
    throw new TargetError('GITHUB_REPOSITORY is invalid.');
  if (event.serverUrl !== 'https://github.com')
    throw new TargetError('This action supports GitHub.com only.');
  if (event.eventName === 'issue_comment') checkCommentRequest(event);
  if (event.eventName === 'pull_request' || event.eventName === 'issue_comment') {
    const pr = scannedPullRequest(event);
    if (
      !pr ||
      text(at(pr, 'head', 'repo', 'full_name')) !== event.repository ||
      text(at(pr, 'base', 'repo', 'full_name')) !== event.repository
    )
      throw new TargetError(
        'Fork PR scans are not supported. Use a dedicated trusted workflow; do not switch to pull_request_target to expose secrets.'
      );
    if (!SHA.test(text(at(pr, 'head', 'sha'))) || !SHA.test(text(at(pr, 'base', 'sha'))))
      throw new TargetError('Pull request context does not identify valid immutable revisions.');
  }
}

/** Whether a checkout's origin URL is this repository on github.com, without a token in it. */
export function originMatches(url: string, repository: string): boolean {
  try {
    if (url.startsWith('git@github.com:'))
      return url.slice('git@github.com:'.length).replace(/\.git$/, '') === repository;
    const parsed = new URL(url);
    return (
      ['https:', 'ssh:'].includes(parsed.protocol) &&
      parsed.hostname === 'github.com' &&
      !parsed.password &&
      (parsed.protocol === 'ssh:' ? parsed.username === 'git' : !parsed.username) &&
      parsed.pathname.replace(/^\//, '').replace(/\.git$/, '') === repository
    );
  } catch {
    return false;
  }
}

/** The checked-out commit, after upstream's checks on the checkout. */
export function checkCheckout(run: Git, repository: string, event: EventContext): string {
  if (git(run, ['rev-parse', '--show-toplevel']).stdout.trim() !== repository)
    throw new TargetError(
      'repository must point to the checkout root. Use paths for folders within it.'
    );
  const keys = git(run, ['config', '--show-scope', '--no-includes', '--name-only', '--list'])
    .stdout.toLowerCase()
    .split('\n')
    .filter(line => /^(?:local|worktree)\t/.test(line))
    .map(line => line.slice(line.indexOf('\t') + 1));
  if (keys.some(key => UNSAFE_CONFIG.test(key)))
    throw new TargetError(
      'The checkout retains Git authentication or external configuration. Use actions/checkout with persist-credentials: false. Credential values have not been printed.'
    );
  const origin = git(run, ['config', '--no-includes', '--get', 'remote.origin.url']).stdout.trim();
  if (!originMatches(origin, event.repository))
    throw new TargetError('The checkout origin does not match GITHUB_REPOSITORY.');
  const scanned = commit(run, 'HEAD');
  const pr = scannedPullRequest(event);
  if (pr && scanned !== text(at(pr, 'head', 'sha')))
    throw new TargetError(
      event.eventName === 'issue_comment'
        ? "A comment request must check out the pull request's head commit, not the merge commit. If the pull request was pushed to since the comment, comment again."
        : 'PR scans must check out github.event.pull_request.head.sha, not the merge commit.'
    );
  if (!pr && scanned !== event.sha)
    throw new TargetError(
      'Checkout HEAD must match GITHUB_SHA. Select the intended branch when dispatching.'
    );
  if (git(run, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).stdout)
    throw new TargetError('The checkout has local changes. Scan a clean checkout.');
  return scanned;
}

/**
 * Whether relative names a regular file under root, reached through no symlink; false when it
 * does not exist. Throws when any part of it is a symlink, or it is not a regular file: a
 * repository-controlled link could otherwise point the scanner, or a write, outside the
 * repository (inside the scanner container, at /proc/self/environ, which holds the key).
 */
export function isLinkFreeFile(root: string, relative: string): boolean {
  let cursor = root;
  for (const part of relative.split('/').filter(segment => segment && segment !== '.')) {
    cursor = join(cursor, part);
    let info;
    try {
      info = lstatSync(cursor);
    } catch {
      return false;
    }
    if (info.isSymbolicLink())
      throw new TargetError(`${relative} must not be or traverse a symlink.`);
  }
  if (!lstatSync(cursor).isFile()) throw new TargetError(`${relative} is not a regular file.`);
  return true;
}

/** Refuses a path that leaves the repository, follows a link, or is not a file or directory. */
export function checkPaths(repository: string, paths: string[]): void {
  for (const path of paths) {
    let cursor = repository;
    for (const part of path.split('/').filter(segment => segment && segment !== '.')) {
      cursor = join(cursor, part);
      let info;
      try {
        info = lstatSync(cursor);
      } catch {
        throw new TargetError(`Requested path ${path} does not exist in the checkout.`);
      }
      if (info.isSymbolicLink())
        throw new TargetError('Requested paths must not traverse symlinks.');
    }
    const info = lstatSync(cursor);
    if (!info.isFile() && !info.isDirectory())
      throw new TargetError('A requested path is not a regular file or directory.');
  }
}

/** The scanned pull request's number (scannedPullRequest), or '' when the run scans none. */
export function pullRequestNumber(
  event: Pick<EventContext, 'eventName' | 'payload' | 'commentedPullRequest'>
): string {
  const pr = scannedPullRequest(event);
  if (!pr) return '';
  return (
    text(at(pr, 'number')) ||
    (event.eventName === 'pull_request' ? text(event.payload['number']) : '')
  );
}

/**
 * Resolves what to scan.
 *
 * @param inputs The action's inputs.
 * @param event The GitHub event.
 * @param lastScan Plans a last-scan diff: skip, a diff from a commit, or a full scan.
 * @param makeGit Runs Git in the checkout; replaced in tests.
 */
export async function resolveTarget(
  inputs: Pick<Inputs, 'repository' | 'scope' | 'paths' | 'diffBase' | 'dryRun'>,
  event: EventContext,
  lastScan: (scanned: string, isAncestor: (last: string) => boolean) => Promise<ScanPlan>,
  makeGit: (repository: string) => Git = gitIn
): Promise<Target> {
  checkEvent(event);
  const repository = realpathSync(inputs.repository);
  const run = makeGit(repository);
  const scannedSha = checkCheckout(run, repository, event);
  checkPaths(repository, inputs.paths);
  const pr = scannedPullRequest(event);
  const analysisRef = pr ? `refs/pull/${pullRequestNumber(event)}/head` : event.ref;
  const publishable = /^refs\/(heads|tags|pull)\//.test(analysisRef);
  const target: Target = {
    kind: 'repository',
    repository,
    scannedSha,
    analysisRef: publishable ? analysisRef : '',
    publishable,
    diffBase: '',
    skipReason: '',
    reason: inputs.paths.length ? `paths: ${inputs.paths.join(', ')}` : 'the whole repository',
  };
  if (inputs.scope !== 'diff') return target;

  let base: string;
  if (inputs.diffBase === LAST_SCAN) {
    const isAncestor = (last: string): boolean =>
      run(['merge-base', '--is-ancestor', last, scannedSha]).status === 0;
    const decided = await lastScan(scannedSha, isAncestor);
    if (decided.kind === 'skip' && !inputs.dryRun)
      return { ...target, kind: 'skip', skipReason: 'empty-diff', reason: decided.reason };
    if (decided.kind === 'full') return { ...target, reason: decided.reason };
    base = decided.base;
    target.reason = decided.reason;
  } else if (inputs.diffBase) {
    base = commit(run, inputs.diffBase);
    target.reason = `changes since ${inputs.diffBase}`;
  } else if (pr) {
    base = git(run, ['merge-base', text(at(pr, 'base', 'sha')), scannedSha]).stdout.trim();
    target.reason = 'changes in this pull request';
  } else {
    throw new TargetError(
      `diff-base is required for diff scans outside pull requests (a revision, or ${LAST_SCAN} for the changes since the last scan).`
    );
  }
  if (!SHA.test(base))
    throw new TargetError('Could not resolve the diff base. Fetch full history.');
  const empty = git(
    run,
    ['diff', '--no-ext-diff', '--no-textconv', '--quiet', base, scannedSha, '--'],
    [0, 1]
  );
  if (empty.status === 0 && !inputs.dryRun)
    return {
      ...target,
      kind: 'skip',
      diffBase: base,
      skipReason: 'empty-diff',
      reason: `no committed changes between ${base.slice(0, 12)} and ${scannedSha.slice(0, 12)}`,
    };
  return { ...target, kind: 'diff', diffBase: base };
}
