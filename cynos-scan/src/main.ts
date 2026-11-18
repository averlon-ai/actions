/**
 * Runs upstream @openai/codex-security, pinned and unmodified, on the calling repository with
 * cynos as the model endpoint, behind upstream's GitHub Action interface.
 *
 * The steps, in order (operation: scan):
 *   1. inputs        upstream's inputs and validation, plus cynos and workflow extensions
 *   2. target        upstream's checks on the caller's checkout; repository, diff, or skip
 *   3-7. scan        @averlon-ai/cynos-scan-engine's scanCheckout on the docker runtime:
 *                    the image and hardening, the preflight and key check, the knowledge base,
 *                    the scan, strict SARIF and the key-leak check, with the knowledge-base cache
 *                    in the Actions cache (GitHubActionsCacheStore)
 *   7. report        issues; pull request comments; the threat model; artifacts and evidence
 *   8. finish        upstream's report status and pass/fail rule; summary and annotations
 * operation: update-threat-model opens or updates the threat-model PR from a full scan.
 */
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  arr,
  at,
  decide,
  discardWorkspace,
  scanCheckout,
  text,
  type JsonObject,
} from '@averlon-ai/cynos-scan-engine';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  downloadThreatModel,
  uploadCoveredMarker,
  uploadReports,
  uploadThreatModel,
} from './artifacts';
import * as actionsCache from '@actions/cache';
import {
  cachePath,
  GitHubActionsCacheStore,
  restorableRefs,
  restoreOnly,
  type CacheEntries,
} from './ci-cache';
import { LAST_SCAN } from './constants';
import { InputError, needsKey, parseInputs, unsupportedScan, type Inputs } from './inputs';
import { dismissedFingerprints, withoutDismissed } from './false-positives';
import { fileIssues, octokitIssues, type FiledIssue } from './issues';
import { keepEvidence, shouldUploadEvidence, uploadEvidence } from './evidence';
import {
  checkRunTitle,
  expectedTitle,
  lastScannedCommit,
  plan,
  workflowFile,
  type RunHistory,
} from './last-scanned';
import {
  html,
  plain,
  emitAnnotations,
  shouldEmitAnnotations,
  reportedFindings,
  resultsAvailable,
  summaryMarkdown,
  writeSummary,
} from './reporting';
import {
  isLinkFreeFile,
  pullRequestNumber,
  resolveTarget,
  scannedPullRequest,
  TargetError,
  type EventContext,
  type Target,
} from './target';
import { octokitPulls, updateThreatModel } from './threat-model';
import {
  octokitPullRequest,
  postPullRequestComments,
  type PullRequestComments,
} from './pr-comments';

export const OUTPUT_NAMES = [
  // Upstream's outputs.
  'sarif-path',
  'json-path',
  'coverage-path',
  'results-directory',
  'scan-status',
  'skip-reason',
  'policy-status',
  'report-status',
  'exit-code',
  'scanned-sha',
  'analysis-ref',
  'sarif-upload-ready',
  'critical-count',
  'high-count',
  'medium-count',
  'low-count',
  'informational-count',
  'estimated-cost',
  // This action's.
  'kind',
  'threat-model',
] as const;

export { dockerEnvironment, filesContaining } from '@averlon-ai/cynos-scan-engine';

function eventContext(): EventContext {
  const path = process.env['GITHUB_EVENT_PATH'];
  if (!path) throw new Error('GITHUB_EVENT_PATH is required; run this action in GitHub Actions.');
  const payload: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid GitHub event payload.');
  return {
    eventName: process.env['GITHUB_EVENT_NAME'] ?? '',
    repository: process.env['GITHUB_REPOSITORY'] ?? '',
    sha: process.env['GITHUB_SHA'] ?? '',
    ref: process.env['GITHUB_REF'] ?? '',
    serverUrl: process.env['GITHUB_SERVER_URL'] ?? '',
    payload: payload as JsonObject,
  };
}

/**
 * event with the commented pull request, on an issue_comment event on one: its payload names the
 * pull request only by number, and a comment request is checked and scanned like the
 * pull_request event's own (target.ts). Any other event is returned as it is.
 */
export async function withCommentedPullRequest(
  event: EventContext,
  pullRequest: (number: number) => Promise<unknown>
): Promise<EventContext> {
  const number = Number(text(at(event.payload, 'issue', 'number')));
  if (
    event.eventName !== 'issue_comment' ||
    !at(event.payload, 'issue', 'pull_request') ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return event;
  return { ...event, commentedPullRequest: (await pullRequest(number)) as JsonObject };
}

function runHistory(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string
): RunHistory {
  return {
    async runTitle(runId) {
      return (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data
        .display_title;
    },
    async successfulRuns(workflow, branch, limit) {
      const response = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
        branch,
        status: 'success',
        per_page: limit,
      });
      return response.data.workflow_runs;
    },
    async hasArtifact(runId, name) {
      const response = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
        name,
      });
      return response.data.artifacts.some(artifact => !artifact.expired);
    },
  };
}

function setOutputs(values: Record<string, string | number | boolean | undefined>): void {
  for (const [name, value] of Object.entries(values))
    core.setOutput(name, value === undefined ? '' : String(value));
}

/**
 * The repository's default branch. Its scans are the repository's record: last-scan starts
 * from them, and only they update the threat model. Every event payload names it; the API is
 * asked when one does not.
 */
export async function defaultBranch(
  payload: unknown,
  repository: () => Promise<{ default_branch: string }>
): Promise<string> {
  const named = text(at(payload, 'repository', 'default_branch'));
  if (named) return named;
  return (await repository()).default_branch;
}

/** The repository's knowledge-base cache entries, from the Caches API (ci-cache.ts). */
function cacheEntries(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string
): CacheEntries {
  return async prefix =>
    (
      await octokit.paginate(octokit.rest.actions.getActionsCacheList, {
        owner,
        repo,
        key: prefix,
        per_page: 100,
      })
    ).flatMap(e =>
      e.key && e.ref && e.created_at ? [{ key: e.key, ref: e.ref, created_at: e.created_at }] : []
    );
}

/** The repository, from the API. */
function repositoryOf(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string) {
  return async () => (await octokit.rest.repos.get({ owner, repo })).data;
}

/** Whether this run is on branch. */
function onBranch(branch: string): boolean {
  return process.env['GITHUB_REF'] === `refs/heads/${branch}`;
}

/** operation: update-threat-model. */
async function threatModelOperation(inputs: Inputs): Promise<string> {
  const temp = process.env['RUNNER_TEMP'] ?? '';
  const generated = await downloadThreatModel(join(temp, 'cynos-scan-threat-model'));
  const { owner, repo } = github.context.repo;
  const octokit = github.getOctokit(inputs.githubToken);
  const url = await updateThreatModel(
    {
      checkout: resolve(inputs.repository),
      remote: `${process.env['GITHUB_SERVER_URL']}/${owner}/${repo}.git`,
      generated,
      target: inputs.threatModelPath,
      defaultBranch: await defaultBranch(
        github.context.payload,
        repositoryOf(octokit, owner, repo)
      ),
      token: inputs.githubToken,
      runUrl: `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`,
      sha: process.env['GITHUB_SHA'] ?? '',
      ref: process.env['GITHUB_REF'] ?? '',
      log: core.info,
    },
    octokitPulls(octokit, owner, repo)
  );
  return url ? `Threat-model PR: ${url}` : 'The threat model is unchanged; no PR.';
}

/**
 * The absolute path of an input's file in the checkout, or undefined when the input is unset.
 * Throws when the file is missing, a link, or reached through one: the engine would read it
 * wherever the link points.
 */
function checkoutFile(root: string, name: string, relative: string): string | undefined {
  if (!relative) return undefined;
  if (!isLinkFreeFile(root, relative))
    throw new InputError(`${name}: ${relative} is not a file in the repository.`);
  return join(root, relative);
}

/** The key the run holds: cynos's, for the scan and its knowledge base alike. */
function secrets(inputs: Inputs | undefined): string[] {
  return [inputs?.cynosApiKey].filter((key): key is string => !!key);
}

/** text with the keys replaced, for anything shown outside the masked log. */
function redact(text: string, inputs: Inputs | undefined): string {
  return secrets(inputs).reduce((out, key) => out.split(key).join('***'), text);
}

/** The summary with the keys replaced, as written or HTML-escaped. */
function redactSummary(body: string, inputs: Inputs | undefined): string {
  return secrets(inputs).reduce(
    (out, key) => out.split(html(key)).join('***'),
    redact(body, inputs)
  );
}

/**
 * The scanner's assets: the Dockerfile, the profiles and the prompt, which the build copies from
 * @averlon-ai/cynos-scan-engine into dist/assets. The bundler fixes __dirname and
 * import.meta.url at build time, to the build machine's source directory, so they are found from
 * the script the runner starts instead: node <root>/dist/main.js.
 */
/**
 * Whether the reports upstream's rules require passed validation: the manifest and the findings.
 * Upstream since 0.8.0 writes no coverage.json, so requiring it failed the reporting of every
 * completed scan; coverage-path stays empty without it.
 */
export function requiredReportsPresent(paths: Partial<Record<string, string>>): boolean {
  return Boolean(paths['scan-manifest.json'] && paths['findings.json']);
}

export function assetsDirectory(script = process.argv[1] ?? ''): string {
  return resolve(dirname(script), 'assets');
}

export async function run(actionRoot = assetsDirectory()): Promise<void> {
  for (const name of OUTPUT_NAMES) core.setOutput(name, '');
  setOutputs({
    'scan-status': 'failed',
    'policy-status': 'not-evaluated',
    'report-status': 'failed',
    'sarif-upload-ready': false,
    'threat-model': false,
  });
  let inputs: Inputs | undefined;
  let stage = '';
  let keepReports = false;
  let success = false;
  let title = 'Scan could not complete.';
  let body = '';
  try {
    inputs = parseInputs(
      name => core.getInput(name),
      process.env['GITHUB_WORKSPACE'] ?? '',
      process.env
    );
    if (inputs.cynosApiKey) core.setSecret(inputs.cynosApiKey);

    if (inputs.operation === 'update-threat-model') {
      title = await threatModelOperation(inputs);
      success = true;
      return;
    }
    const unsupported = unsupportedScan(inputs);
    if (unsupported) throw new InputError(`${unsupported} No scan was started.`);

    // 2. What to scan.
    const octokit = github.getOctokit(inputs.githubToken);
    const { owner, repo } = github.context.repo;
    const event = await withCommentedPullRequest(
      eventContext(),
      async number => (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data
    );
    const history = runHistory(octokit, owner, repo);
    const runId = Number(process.env['GITHUB_RUN_ID']);
    const branch = await defaultBranch(github.context.payload, repositoryOf(octokit, owner, repo));
    // Whether this run scans the default branch, the repository's record. A comment request runs
    // on the default branch's ref (every issue_comment run does) but scans a pull request, so it
    // is never the record: never a last-scan starting point, and never the threat model's source.
    const onDefaultBranch = !scannedPullRequest(event) && onBranch(branch);
    // A successful run titled full or diff on the default branch is where later last-scan diffs
    // start, so it must be the scan its title names and must cover the code.
    const titleCheck = Number.isSafeInteger(runId)
      ? await checkRunTitle(history, runId, expectedTitle(inputs), {
          usesLastScan: inputs.diffBase === LAST_SCAN,
          onDefaultBranch,
        })
      : { problem: '', startingPoint: false };
    if (titleCheck.problem) throw new TargetError(titleCheck.problem);
    if (titleCheck.startingPoint)
      core.info('Later diff-base: last-scan runs start from this run if it covers its commit.');
    const target: Target = await resolveTarget(inputs, event, async (scanned, isAncestor) => {
      const workflow = workflowFile(process.env['GITHUB_WORKFLOW_REF'] ?? '');
      return plan(await lastScannedCommit(history, workflow, branch, runId), scanned, isAncestor);
    });
    setOutputs({
      'scanned-sha': target.scannedSha,
      'analysis-ref': target.analysisRef,
      kind: target.kind,
    });
    core.info(`cynos-scan: ${target.kind}: ${target.reason}`);
    if (target.kind === 'skip') {
      setOutputs({
        'scan-status': 'skipped',
        'skip-reason': target.skipReason,
        'report-status': 'ready',
      });
      // Nothing changed since a covered commit, so this one is covered too.
      if (titleCheck.startingPoint) await uploadCoveredMarker(target.scannedSha, 'empty-diff');
      success = true;
      title = 'No committed changes to scan';
      body = `${html(plain(target.reason))}. No scan ran and no model cost was incurred.`;
      return;
    }
    const key = inputs.cynosApiKey;
    if (needsKey(inputs) && (!key || /[\r\n\u0000]/.test(key)))
      throw new InputError(
        'Pass the cynos key as cynos-api-key (or CYNOS_API_KEY in the step env) from an environment secret. No scan was started.'
      );
    const isDiff = target.kind === 'diff';

    // 3-7. The scan, in its own private directory, so a second scan in the same job never reads
    // the first one's reports.
    stage = realpathSync(mkdtempSync(join(process.env['RUNNER_TEMP'] || tmpdir(), 'cynos-scan-')));
    core.saveState('stage', stage);
    const project = target.repository;
    const knowledgeBase =
      target.kind === 'diff' && isLinkFreeFile(project, inputs.threatModelPath)
        ? inputs.threatModelPath
        : '';
    // The repository's own threat model is authoritative for a full scan's review when it keeps
    // one; a link is not followed (isLinkFreeFile throws on one), so it is then left out.
    const threatModelPath = (() => {
      try {
        return isLinkFreeFile(project, inputs.threatModelPath) ? inputs.threatModelPath : undefined;
      } catch {
        return undefined;
      }
    })();
    // The caller's severity rubric and dismissals, files in the checkout the engine reads and
    // checks; a link is not followed (isLinkFreeFile throws on one).
    const rubricFile = checkoutFile(project, 'severity-rubric', inputs.severityRubric);
    const falsePositivesFile = checkoutFile(project, 'false-positives', inputs.falsePositives);
    const runName = `cynos-scan-${process.env['GITHUB_RUN_ID'] ?? process.pid}-${process.env['GITHUB_RUN_ATTEMPT'] ?? 1}`;
    // Jev's answers, the code graph and the last full scan's review, when the Actions cache has
    // them (ci-cache.ts); kept outside the stage, which is discarded.
    const cacheLog = (message: string): void => core.info(`knowledge base: ${message}`);
    // Lists the entries too, so a diff restores its branch's newest ancestor's (ci-cache.ts).
    const knowledgeBaseStore = new GitHubActionsCacheStore(
      cacheLog,
      cachePath(),
      actionsCache,
      cacheEntries(octokit, owner, repo),
      restorableRefs(branch)
    );
    const scan = await scanCheckout(
      {
        kind: isDiff ? 'diff' : 'full',
        diffBase: target.diffBase,
        project,
        stage,
        // docker, the scanner container, until the action installs upstream for native
        // (unsupportedScan refuses it). upstream's state stays in the stage, which is discarded;
        // the action publishes its outputs, so the engine checks every file for a key first.
        runtime: inputs.runtime,
        stateDir: join(stage, 'state'),
        interactive: false,
        publishes: true,
        assets: actionRoot,
        runName,
        scannedSha: target.scannedSha,
        knowledgeBase,
        threatModelPath,
        ...(rubricFile ? { rubricFile } : {}),
        ...(falsePositivesFile ? { falsePositivesFile } : {}),
        cynosKey: key,
        // The engine's BASE_URL unless the caller's key belongs to another cynos gateway.
        ...(inputs.baseUrl ? { baseUrl: inputs.baseUrl } : {}),
        buildImage: true,
        loadAppArmor: true,
        runRecord: { kind: target.kind, reason: target.reason },
        paths: inputs.paths,
        model: inputs.model,
        effort: inputs.effort,
        mode: inputs.mode,
        cyberAccessProgram: inputs.cyberAccessProgram,
        maxTimeHours: inputs.maxTimeHours,
        failOnSeverity: inputs.failOnSeverity,
        verbose: inputs.verbose,
        dryRun: inputs.dryRun,
        mock: inputs.mock,
        judge: inputs.cynosJudge,
        taskRouting: inputs.cynosTaskRouting,
      },
      {
        log: core.info,
        warn: core.warning,
        error: core.error,
        containers: names => core.saveState('containers', JSON.stringify(names)),
        // A comment request restores but never saves: its run's cache entries would be scoped to
        // the default branch, where every later scan of every branch restores them, though they
        // describe a pull request's code. A pull_request run saves in the pull request's own scope.
        knowledgeBaseStore:
          event.eventName === 'issue_comment'
            ? restoreOnly(knowledgeBaseStore, cacheLog)
            : knowledgeBaseStore,
        scanned: ({ outcome, scannerRun, estimatedCost, counts }) =>
          setOutputs({
            'scan-status': outcome.scanStatus,
            'policy-status': outcome.policyStatus,
            'skip-reason': outcome.skipReason,
            'exit-code': scannerRun.exitCode ?? '',
            // Empty means unavailable, not zero: an unpriced model has no estimate.
            'estimated-cost': estimatedCost === undefined ? '' : String(estimatedCost),
            ...Object.fromEntries(
              Object.entries(counts ?? {}).map(([level, count]) => [`${level}-count`, count])
            ),
          }),
      }
    );
    const { outcome, scannerRun, reports, findings, counts, sarif, estimatedCost } = scan;
    const available = resultsAvailable(reports, target.scannedSha);
    const leakClean = scan.leaked.length === 0;
    keepReports = leakClean;
    // Reports are withheld when the key is in them: no paths, annotations or findings in the summary.
    const published = available && leakClean;
    setOutputs({
      'results-directory': published ? reports.directory : '',
      'json-path': published ? reports.paths['findings.json'] : '',
      'coverage-path': published ? reports.paths['coverage.json'] : '',
    });
    // A finding whose fingerprint the reviewers dismissed gets no issue and no review comment.
    const { undismissed, dismissed } = withoutDismissed(
      arr(findings?.['findings']),
      falsePositivesFile ? dismissedFingerprints(falsePositivesFile) : new Set()
    );
    if (dismissed)
      core.info(
        `${dismissed} finding${dismissed === 1 ? '' : 's'} with a fingerprint in false-positives: no issue or review comment.`
      );
    let issues: FiledIssue[] | undefined;
    if (inputs.fileIssues && outcome.scanStatus === 'completed' && !inputs.mock && leakClean) {
      issues = await fileIssues(octokitIssues(octokit, owner, repo), undismissed, {
        repository: `${owner}/${repo}`,
        sha: target.scannedSha,
        runUrl: `${process.env['GITHUB_SERVER_URL']}/${owner}/${repo}/actions/runs/${process.env['GITHUB_RUN_ID']}`,
      });
      writeFileSync(join(stage, 'issues.json'), `${JSON.stringify(issues, null, 2)}\n`);
    }
    // On a pull request, a diff scan's findings go on the pull request too: a summary comment and
    // a review comment per finding on a changed line. Without them the scan's result still
    // stands, so a failure (most often a job without pull-requests: write) only warns.
    let prComments: PullRequestComments | undefined;
    const pullNumber = Number(pullRequestNumber(event));
    if (
      inputs.prComments &&
      target.kind === 'diff' &&
      outcome.scanStatus === 'completed' &&
      published &&
      Number.isSafeInteger(pullNumber) &&
      pullNumber > 0
    ) {
      try {
        const posted = await postPullRequestComments(
          octokitPullRequest(octokit, owner, repo, pullNumber),
          undismissed,
          {
            repository: `${owner}/${repo}`,
            sha: target.scannedSha,
            diffBase: target.diffBase,
            runUrl: `${process.env['GITHUB_SERVER_URL']}/${owner}/${repo}/actions/runs/${process.env['GITHUB_RUN_ID']}`,
            // The reports upload below runs with upload-artifacts, and these comments are posted
            // only for published reports, so that upload holds findings.json.
            reportsArtifact: inputs.uploadArtifacts ? inputs.artifactName : undefined,
            mock: inputs.mock,
            issues,
            dismissed,
          }
        );
        if ('skipped' in posted) core.info(`No pull request comments: ${posted.skipped}.`);
        else {
          prComments = posted;
          writeFileSync(
            join(stage, 'pr-comments.json'),
            `${JSON.stringify(prComments, null, 2)}\n`
          );
        }
      } catch (error) {
        core.warning(
          `The pull request comments were not posted (the job needs pull-requests: write): ${redact(error instanceof Error ? error.message : String(error), inputs)}`
        );
      }
    }
    if (
      target.kind === 'repository' &&
      !inputs.paths.length &&
      outcome.scanStatus === 'completed' &&
      !inputs.mock &&
      leakClean &&
      onDefaultBranch
    ) {
      await uploadThreatModel(reports);
      setOutputs({ 'threat-model': true });
    }
    if (inputs.uploadArtifacts && leakClean)
      await uploadReports(stage, reports, available, inputs.artifactName, inputs.retentionDays);
    // The briefs, checklists and helper results outlive the stage, for explaining the findings.
    if (scan.knowledgeBaseBuilt && leakClean) {
      try {
        const kept = join(process.env['RUNNER_TEMP'] || tmpdir(), `${runName}-evidence`);
        const files = keepEvidence(stage, kept, scan.scanDir);
        core.info(`Evidence (${files.length} files) kept in ${kept}.`);
        if (
          process.env['ACTIONS_RUNTIME_TOKEN'] &&
          shouldUploadEvidence(inputs.uploadEvidence, github.context.payload.repository?.private)
        )
          await uploadEvidence(
            kept,
            files,
            `${inputs.artifactName}-evidence`,
            inputs.retentionDays
          );
      } catch (error) {
        core.warning(
          `The run's evidence was not kept: ${redact(error instanceof Error ? error.message : String(error), inputs)}`
        );
      }
    }

    // 8. Finish.
    const report = decide(outcome, {
      sarifReady: Boolean(sarif),
      leakClean,
      // Ready to upload only with a sarif-path to upload from.
      publishable: target.publishable && published,
      requiredReports: requiredReportsPresent(reports.paths),
      failOnSeverity: inputs.failOnSeverity,
    });
    setOutputs({
      'report-status': report.reportStatus,
      'sarif-upload-ready': report.sarifUploadReady,
      'sarif-path': report.reportStatus === 'ready' && published ? sarif : '',
    });
    success = report.success;
    title = report.title;
    if (titleCheck.startingPoint && success && outcome.scanStatus === 'completed' && !inputs.mock)
      await uploadCoveredMarker(target.scannedSha, target.kind);
    const reported = reportedFindings(findings);
    if (shouldEmitAnnotations({ annotations: inputs.annotations, published, prComments }))
      emitAnnotations(reported, outcome.scanStatus);
    body = summaryMarkdown({
      scanStatus: outcome.scanStatus,
      policyStatus: outcome.policyStatus,
      report,
      reason: redact(outcome.reason, inputs),
      counts,
      findings: published ? reported : [],
      covered:
        target.kind === 'diff' ? `diff since ${target.diffBase.slice(0, 12)}` : target.reason,
      mode: inputs.mode,
      failOnSeverity: inputs.failOnSeverity,
      scannedSha: target.scannedSha,
      estimatedCost,
      tokens: scannerRun.usage as unknown as Record<string, number>,
      elapsedSeconds: scannerRun.elapsedSeconds,
      knowledgeBase: !scan.diffThreatModel
        ? knowledgeBase
        : scan.diffThreatModel.source === 'built'
          ? `built for this change at ${scan.diffThreatModel.sha.slice(0, 12)}: no full scan's was stored`
          : `the full scan of ${scan.diffThreatModel.sha.slice(0, 12)}`,
      versions: scan.versions,
      issues,
      prComments,
    });
  } catch (error) {
    // A failure after the outcome was decided, such as a failed artifact upload, fails the step.
    success = false;
    title = 'Scan could not complete.';
    const message = plain(
      redact(error instanceof Error ? error.message : 'Unexpected action failure.', inputs)
    );
    body = `<pre>${html(message)}</pre>`;
    core.setOutput('sarif-upload-ready', 'false');
    core.error(message);
  } finally {
    discardWorkspace(stage, keepReports);
    // The step summary is not masked like the log. Its fields are redacted before formatting;
    // this catches any key that still reached it, as written or HTML-escaped.
    if (inputs?.summary !== false) await writeSummary(title, redactSummary(body, inputs));
    if (success) core.info(title);
    else core.setFailed(`${title} See the job summary and logs for details.`);
  }
}

// Run when executed as the action's entry point, not when imported by tests.
if (require.main === module) void run();
