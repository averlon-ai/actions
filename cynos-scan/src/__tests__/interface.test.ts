import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MODEL } from '@averlon-ai/cynos-scan-engine';
import { EXTRA_INPUTS, InputError, parseInputs, unsupportedScan, UPSTREAM_INPUTS } from '../inputs';
import { assetsDirectory, OUTPUT_NAMES } from '../main';

/**
 * The action keeps upstream's GitHub Action interface: every upstream input and output, with
 * upstream's names and defaults, plus this action's extensions.
 */

const ROOT = path.resolve(import.meta.dir, '../..');
const action = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8')) as {
  inputs: Record<string, { default?: string }>;
  outputs: Record<string, unknown>;
  runs: { using: string; main: string; post: string; 'post-if': string };
};

// openai/codex-security action.yml at 253ab7caecb4fe3b939cdeb5bf8095444bbc0eb5.
const UPSTREAM_OUTPUTS = [
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
];
const UPSTREAM_DEFAULTS: Record<string, string> = {
  scope: 'repository',
  mode: 'standard',
  effort: 'xhigh',
  'fail-on-severity': 'none',
  verbose: 'true',
  'dry-run': 'false',
  summary: 'true',
  annotations: 'true',
  'upload-artifacts': 'false',
  'retention-days': '7',
};
/**
 * Where this action's defaults differ from upstream's: the artifact is named after this action
 * (upstream's is codex-security), and an unset model is the engine's DEFAULT_MODEL.
 */
const OWN_DEFAULTS: Record<string, string | undefined> = {
  'artifact-name': 'cynos-scan',
  model: undefined,
};

function inputs(values: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  return parseInputs(name => values[name] ?? '', '/workspace', env);
}

describe('action.yml', () => {
  it("declares every upstream input, then this action's", () => {
    expect(Object.keys(action.inputs)).toEqual([...UPSTREAM_INPUTS, ...EXTRA_INPUTS]);
  });

  it("keeps upstream's defaults, except its own", () => {
    for (const [name, value] of Object.entries(UPSTREAM_DEFAULTS))
      expect(String(action.inputs[name]?.default)).toBe(value);
    for (const [name, value] of Object.entries(OWN_DEFAULTS))
      expect(action.inputs[name]?.default).toBe(value);
  });

  it("declares every upstream output, then this action's", () => {
    expect(Object.keys(action.outputs)).toEqual([...UPSTREAM_OUTPUTS, 'kind', 'threat-model']);
    expect([...OUTPUT_NAMES]).toEqual(
      Object.keys(action.outputs) as (typeof OUTPUT_NAMES)[number][]
    );
  });

  it('finds its assets next to the script the runner starts, not where it was built', () => {
    expect(assetsDirectory('/home/runner/work/_actions/a/b/sha/cynos-scan/dist/main.js')).toBe(
      '/home/runner/work/_actions/a/b/sha/cynos-scan/dist/assets'
    );
  });

  it('runs on node24 with a post step that always runs', () => {
    expect(action.runs).toEqual({
      using: 'node24',
      main: 'dist/main.js',
      post: 'dist/post.js',
      'post-if': 'always()',
    });
  });
});

describe('parseInputs', () => {
  it("keeps cynos's judge and task routing on unless switched off", () => {
    expect(inputs()).toMatchObject({ cynosJudge: true, cynosTaskRouting: true });
    expect(inputs({ 'cynos-judge': 'off', 'cynos-task-routing': 'off' })).toMatchObject({
      cynosJudge: false,
      cynosTaskRouting: false,
    });
    expect(() => inputs({ 'cynos-judge': 'no' })).toThrow('cynos-judge must be one of: on, off.');
  });

  it("defaults like upstream, with the engine's model", () => {
    const parsed = inputs();
    expect(parsed).toMatchObject({
      operation: 'scan',
      repository: '/workspace',
      scope: 'repository',
      paths: [],
      diffBase: '',
      mode: 'standard',
      model: DEFAULT_MODEL,
      effort: 'xhigh',
      failOnSeverity: 'none',
      verbose: true,
      dryRun: false,
      summary: true,
      annotations: true,
      uploadArtifacts: false,
      artifactName: 'cynos-scan',
      retentionDays: 7,
      fileIssues: false,
      threatModelPath: 'docs/threatmodel.md',
    });
  });

  it('normalises newline-delimited paths as upstream does', () => {
    expect(inputs({ paths: './functions/\nreasonaccess\n\nfunctions' }).paths).toEqual([
      'functions',
      'reasonaccess',
    ]);
  });

  it.each([
    [{ scope: 'diff', paths: 'functions' }, 'paths cannot be combined with scope: diff'],
    [{ 'diff-base': 'main' }, 'diff-base requires scope: diff'],
    [{ scope: 'diff', mode: 'deep' }, 'mode: deep requires scope: repository'],
    [{ 'max-time-hours': '2' }, 'max-time-hours requires mode: deep'],
    [{ paths: '../outside' }, "without '..'"],
    [{ effort: 'extreme' }, 'effort must be one of'],
    [{ 'max-cost': '5' }, 'max-cost is not supported'],
    [
      { 'threat-model-path': '/etc/passwd' },
      'threat-model-path must contain literal repository-relative paths',
    ],
    [{ 'threat-model-path': '.git/hooks/pre-commit' }, 'outside .git'],
    [{ 'threat-model-path': 'docs/' }, 'must name a file'],
    [{ 'threat-model-path': '-A' }, 'must name a file'],
    [
      { 'severity-rubric': '../rubric.md' },
      "severity-rubric must contain literal repository-relative paths, without '..'",
    ],
    [
      { 'false-positives': '/etc/passwd' },
      'false-positives must contain literal repository-relative paths',
    ],
  ])('refuses %j', (values, message) => {
    expect(() => inputs(values)).toThrow(InputError);
    expect(() => inputs(values)).toThrow(message);
  });

  it('accepts last-scan as a diff base', () => {
    expect(inputs({ scope: 'diff', 'diff-base': 'last-scan' }).diffBase).toBe('last-scan');
  });

  it('runs full repository scans and diffs, and refuses a paths scan', () => {
    expect(unsupportedScan(inputs({}))).toBe('');
    expect(unsupportedScan(inputs({ mode: 'deep' }))).toBe('');
    expect(unsupportedScan(inputs({ scope: 'diff' }))).toBe('');
    expect(unsupportedScan(inputs({ paths: 'functions' }))).toContain('paths is not supported');
  });

  it('runs on the docker runtime by default, and refuses native until the action installs upstream', () => {
    expect(inputs().runtime).toBe('docker');
    expect(String(action.inputs['runtime']?.default)).toBe('docker');
    expect(unsupportedScan(inputs({ runtime: 'docker' }))).toBe('');
    expect(unsupportedScan(inputs({ runtime: 'native' }))).toContain(
      'runtime: native is not yet supported in the action'
    );
    expect(() => inputs({ runtime: 'podman' })).toThrow('runtime must be one of: docker, native.');
  });

  it('posts pull request comments unless switched off', () => {
    expect(inputs().prComments).toBe(true);
    expect(String(action.inputs['pr-comments']?.default)).toBe('true');
    expect(inputs({ 'pr-comments': 'false' }).prComments).toBe(false);
    expect(() => inputs({ 'pr-comments': 'off' })).toThrow(
      'pr-comments must be one of: true, false.'
    );
  });

  it("grades with upstream's rubric and reads no dismissals unless given files", () => {
    expect(inputs()).toMatchObject({ severityRubric: '', falsePositives: '' });
    expect(
      inputs({ 'severity-rubric': ' .github/rubric.md ', 'false-positives': 'security/fp.json' })
    ).toMatchObject({ severityRubric: '.github/rubric.md', falsePositives: 'security/fp.json' });
  });

  it('accepts any cynos model id', () => {
    expect(inputs({ model: 'unpriced/model' }).model).toBe('unpriced/model');
  });

  it('reads the key from its input, then CYNOS_API_KEY, then the env variables upstream reads', () => {
    expect(inputs({ 'cynos-api-key': 'a' }, { CYNOS_API_KEY: 'd' }).cynosApiKey).toBe('a');
    expect(inputs({}, { CYNOS_API_KEY: 'd', CODEX_API_KEY: 'b' }).cynosApiKey).toBe('d');
    expect(inputs({ 'cynos-api-key': 'a' }, { CODEX_API_KEY: 'b' }).cynosApiKey).toBe('a');
    expect(inputs({}, { CODEX_API_KEY: 'b', OPENAI_API_KEY: 'c' }).cynosApiKey).toBe('b');
    expect(inputs({}, { OPENAI_API_KEY: 'c' }).cynosApiKey).toBe('c');
  });

  it("leaves the endpoint to the engine unless CYNOS_BASE_URL names the key's gateway", () => {
    expect(inputs().baseUrl).toBe('');
    expect(inputs({}, { CYNOS_BASE_URL: ' https://harness.dev.averlon.io/v1/ ' }).baseUrl).toBe(
      'https://harness.dev.averlon.io/v1'
    );
    // The key is sent there, and Codex reads the URL inside a TOML string.
    for (const bad of ['http://harness.dev.averlon.io/v1', 'harness.dev.averlon.io', 'https://a"b'])
      expect(() => inputs({}, { CYNOS_BASE_URL: bad })).toThrow(
        'CYNOS_BASE_URL must be an https URL'
      );
  });
});
