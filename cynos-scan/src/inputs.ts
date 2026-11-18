/**
 * The action's inputs: upstream's GitHub Action inputs, with upstream's validation
 * (openai/codex-security github-action/src/inputs.ts), plus the inputs cynos and this
 * action's daily-scan and threat-model workflow need.
 *
 * Where upstream and this action differ, upstream's meaning is kept where it can be: diff-base
 * also accepts last-scan, and model defaults to a cynos model id. max-cost is accepted by name
 * but refused when set: cynos may serve a turn with another model than the one requested, so no
 * estimate is a reliable stop threshold, and the cynos key's budget is the cost limit.
 */
import { DEFAULT_MODEL, type RuntimeName } from '@averlon-ai/cynos-scan-engine';
import { LAST_SCAN } from './constants';

export const UPSTREAM_INPUTS = [
  'repository',
  'scope',
  'paths',
  'diff-base',
  'mode',
  'model',
  'cyber-access-program',
  'effort',
  'max-cost',
  'max-time-hours',
  'fail-on-severity',
  'verbose',
  'dry-run',
  'summary',
  'annotations',
  'upload-artifacts',
  'artifact-name',
  'retention-days',
] as const;

export const EXTRA_INPUTS = [
  'operation',
  'cynos-api-key',
  'mock',
  'file-issues',
  'threat-model-path',
  'github-token',
  'cynos-judge',
  'cynos-task-routing',
  'upload-evidence',
  'runtime',
  'pr-comments',
  'severity-rubric',
  'false-positives',
] as const;

export type Scope = 'repository' | 'diff';

export interface Inputs {
  operation: 'scan' | 'update-threat-model';
  repository: string;
  scope: Scope;
  paths: string[];
  diffBase: string;
  mode: 'standard' | 'deep';
  model: string;
  cyberAccessProgram: string;
  effort: string;
  maxTimeHours: number | undefined;
  failOnSeverity: string;
  verbose: boolean;
  dryRun: boolean;
  summary: boolean;
  annotations: boolean;
  uploadArtifacts: boolean;
  artifactName: string;
  retentionDays: number;
  // This action's extensions.
  cynosApiKey: string;
  /**
   * The cynos gateway the key belongs to, from CYNOS_BASE_URL in the step env (the cynos CLI's
   * variable); '' for the engine's BASE_URL. Deliberately not an input: only internal callers
   * whose key another gateway issued set it.
   */
  baseUrl: string;
  mock: boolean;
  fileIssues: boolean;
  threatModelPath: string;
  githubToken: string;
  /** cynos's quality judge for the scan's turns. */
  cynosJudge: boolean;
  /** cynos's task routing for the scan's turns. */
  cynosTaskRouting: boolean;
  /** Keep the run's evidence (evidence.ts) as an artifact: auto means a private repository only. */
  uploadEvidence: 'auto' | 'true' | 'false';
  /** Where upstream runs: the hardened scanner container (docker), or the runner itself (native). */
  runtime: RuntimeName;
  /** On a pull request's diff scan, a summary comment and review comments (pr-comments.ts). */
  prComments: boolean;
  /** The caller's severity rubric, a repository-relative file; '' for upstream's default. */
  severityRubric: string;
  /** The findings the caller's reviewers dismissed, a repository-relative JSON file; '' for none. */
  falsePositives: string;
}

export class InputError extends Error {}

/** Throws unless value is a literal repository-relative path without '..', as upstream requires. */
export function safeRelative(name: string, value: string): string {
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new InputError(`${name} must contain literal repository-relative paths, without '..'.`);
  return value;
}

/**
 * Parses and validates the inputs.
 *
 * @param read Returns one input's raw value ('' when unset).
 * @param workspace GITHUB_WORKSPACE, the default repository.
 * @param env The process environment, for the key's upstream-compatible variables.
 */
export function parseInputs(
  read: (name: string) => string,
  workspace: string,
  env: NodeJS.ProcessEnv
): Inputs {
  const str = (name: string, fallback = ''): string => read(name).trim() || fallback;
  const choice = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const value = str(name, fallback);
    if (!values.includes(value as T))
      throw new InputError(`${name} must be one of: ${values.join(', ')}.`);
    return value as T;
  };
  const bool = (name: string, fallback: boolean): boolean =>
    choice(name, ['true', 'false'], String(fallback) as 'true' | 'false') === 'true';
  const num = (name: string, integer: boolean, min = 0, max = Infinity): number | undefined => {
    const value = str(name);
    if (!value) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n)) || n < min || n > max)
      throw new InputError(
        `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`
      );
    return n;
  };
  // A repository-relative file the scan reads, or '' when unset.
  const optionalFile = (name: string): string => (str(name) ? safeRelative(name, str(name)) : '');
  const list = (name: string): string[] =>
    str(name)
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);

  const operation = choice('operation', ['scan', 'update-threat-model'] as const, 'scan');
  // Match the CLI's scope spelling, as upstream does.
  const paths = [
    ...new Set(
      list('paths').map(
        value =>
          safeRelative('paths', value)
            .split('/')
            .filter(part => part && part !== '.')
            .join('/') || '.'
      )
    ),
  ];
  const scope = choice('scope', ['repository', 'diff'] as const, 'repository');
  if (scope !== 'repository' && paths.length)
    throw new InputError(
      `paths cannot be combined with scope: ${scope}. Remove paths to scan changes, or use scope: repository to scan selected paths.`
    );
  const diffBase = str('diff-base');
  if (diffBase && scope !== 'diff') throw new InputError('diff-base requires scope: diff.');
  if (diffBase.startsWith('-'))
    throw new InputError(`diff-base must be a revision or ${LAST_SCAN}.`);
  const mode = choice('mode', ['standard', 'deep'] as const, 'standard');
  if (mode === 'deep' && scope !== 'repository')
    throw new InputError('mode: deep requires scope: repository.');
  const maxTimeHours = num('max-time-hours', false, Number.MIN_VALUE, 96);
  if (maxTimeHours !== undefined && mode !== 'deep')
    throw new InputError('max-time-hours requires mode: deep.');
  const cyberAccessProgram = str('cyber-access-program')
    ? choice('cyber-access-program', ['standard', 'daybreak_blue', 'daybreak_red'], 'standard')
    : '';
  const model = str('model', DEFAULT_MODEL);
  if (str('max-cost'))
    throw new InputError(
      "max-cost is not supported: cynos may serve a turn with another model than the one requested, so no estimate is a reliable stop threshold. The cynos key's budget is the cost limit; set it in cynos and unset max-cost."
    );
  // The key is sent to this URL, so plain http is refused; Codex reads it inside a TOML string
  // (model_providers.cynos.base_url), so it cannot hold a quote or whitespace.
  const baseUrl = (env['CYNOS_BASE_URL'] ?? '').trim().replace(/\/+$/, '');
  if (baseUrl && !/^https:\/\/[^\s"]+$/.test(baseUrl))
    throw new InputError(
      'CYNOS_BASE_URL must be an https URL, such as https://api.cynos.averlon.ai/v1.'
    );
  const threatModelPath = safeRelative(
    'threat-model-path',
    str('threat-model-path', 'docs/threatmodel.md')
  );
  // update-threat-model writes this file and commits it: a tracked file, never Git's own.
  const threatModelParts = threatModelPath.split('/');
  if (
    threatModelParts.some(part => !part || part === '.' || part.toLowerCase() === '.git') ||
    threatModelPath.startsWith('-')
  )
    throw new InputError('threat-model-path must name a file in the repository, outside .git.');

  return {
    operation,
    repository: str('repository', workspace),
    scope,
    paths,
    diffBase,
    mode,
    model,
    cyberAccessProgram,
    effort: choice('effort', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'xhigh'),
    maxTimeHours,
    failOnSeverity: choice(
      'fail-on-severity',
      ['none', 'low', 'medium', 'high', 'critical'],
      'none'
    ),
    verbose: bool('verbose', true),
    dryRun: bool('dry-run', false),
    summary: bool('summary', true),
    annotations: bool('annotations', true),
    uploadArtifacts: bool('upload-artifacts', false),
    artifactName: str('artifact-name', 'cynos-scan'),
    retentionDays: num('retention-days', true, 1, 90) ?? 7,
    // The key's own name is CYNOS_API_KEY; upstream reads it from CODEX_API_KEY or
    // OPENAI_API_KEY in the step env, so this action reads those too, after its input and
    // CYNOS_API_KEY.
    cynosApiKey:
      str('cynos-api-key') ||
      env['CYNOS_API_KEY'] ||
      env['CODEX_API_KEY'] ||
      env['OPENAI_API_KEY'] ||
      '',
    baseUrl,
    mock: bool('mock', false),
    fileIssues: bool('file-issues', false),
    threatModelPath,
    githubToken: str('github-token'),
    cynosJudge: choice('cynos-judge', ['on', 'off'] as const, 'on') === 'on',
    cynosTaskRouting: choice('cynos-task-routing', ['on', 'off'] as const, 'on') === 'on',
    uploadEvidence: choice('upload-evidence', ['auto', 'true', 'false'] as const, 'auto'),
    runtime: choice('runtime', ['docker', 'native'] as const, 'docker'),
    prComments: bool('pr-comments', true),
    severityRubric: optionalFile('severity-rubric'),
    falsePositives: optionalFile('false-positives'),
  };
}

/**
 * Why this action cannot run the requested scan, or '' when it can. A full scan is planned around a
 * knowledge base of the whole repository and a diff around upstream's own diff workflow (main.ts);
 * a selected-paths scan has no plan yet, so it is refused.
 *
 * The native runtime is refused too. It runs upstream from node_modules beside the running script,
 * but the action ships dist/ alone (one bundled script per entry point, and the engine's assets),
 * and nothing installs upstream and Codex's platform binary next to it on the runner yet.
 */
export function unsupportedScan(inputs: Pick<Inputs, 'scope' | 'paths' | 'runtime'>): string {
  if (inputs.paths.length)
    return 'paths is not supported yet: this action runs full repository scans and diffs. Remove paths.';
  if (inputs.runtime === 'native')
    return "runtime: native is not yet supported in the action: it runs @openai/codex-security from node_modules beside the action's script, which the action does not install. Use runtime: docker (the default).";
  return '';
}

/** Whether the scan makes model calls, and so needs the cynos key and builds the knowledge base. */
export function needsKey(inputs: Pick<Inputs, 'dryRun' | 'mock'>): boolean {
  return !(inputs.dryRun || inputs.mock);
}
