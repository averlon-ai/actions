import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFiles } from '../artifacts';
import { fileIssues, issueBody, lineNumber, MARKER, type IssuesApi } from '../issues';
import {
  html,
  reportedFindings,
  resultsAvailable,
  safeLogLines,
  shouldEmitAnnotations,
  summaryMarkdown,
} from '../reporting';
import { normalize } from '../threat-model';

const REPOSITORY = 'averlon-security/kca';
const SHA = `8b314d4${'0'.repeat(33)}`;
const CONTEXT = {
  repository: REPOSITORY,
  sha: SHA,
  runUrl: 'https://github.com/r/actions/runs/1',
};

function finding(
  fingerprint: string,
  severity = 'medium',
  summary = 'eval() on graph data'
): Record<string, unknown> {
  return {
    title: `Finding ${fingerprint}`,
    summary,
    severity: { level: severity, rationale: 'Reachable from graph data.' },
    confidence: { level: 'high' },
    taxonomy: { category: 'Code Injection', cwe: ['CWE-95'] },
    fingerprints: {
      algorithm: 'codex-security/v1',
      primary: `codex-security/v1:sha256:${fingerprint}`,
    },
    ruleId: 'code-injection.eval',
    locations: [
      { path: 'functions/a.py', role: 'entrypoint', startLine: '10' },
      { path: 'functions/b.py', role: 'root_control', startLine: 97, endLine: 99 },
    ],
    rootCause: { summary: 'Rules are evaluated as Python.' },
    attackPath: {
      reachability: { summary: 'Graph writer controls rules.' },
      impact: { level: 'high', rationale: 'Code execution.' },
      dataFlow: 'body -> eval',
    },
    remediation: 'Use ast.literal_eval.',
  };
}

/** An in-memory repository: its issues and labels. */
function repository(
  issues: { body?: string; html_url: string; labels?: string[] }[] = [],
  labels: string[] = []
) {
  const state = {
    issues: [...issues],
    labels: new Set(labels),
    created: [] as { title: string; labels: string[] }[],
  };
  const api: IssuesApi = {
    async listLabelledIssues(page) {
      // Two pages, then an empty one: exercises pagination.
      return page === 1 ? state.issues.slice(0, 1) : page === 2 ? state.issues.slice(1) : [];
    },
    async createLabel(name) {
      if (state.labels.has(name)) return false;
      state.labels.add(name);
      return true;
    },
    async createIssue(title, body, issueLabels) {
      const issue = {
        body,
        html_url: `https://github.com/${REPOSITORY}/issues/${state.issues.length + 1}`,
        labels: issueLabels,
      };
      state.issues.push(issue);
      state.created.push({ title, labels: issueLabels });
      return issue;
    },
  };
  return { api, state };
}

describe('shouldEmitAnnotations', () => {
  const posted = { summaryUrl: 'https://x/summary/1', reviewComments: [] };

  it('emits none when the findings are on the pull request, which would show each twice', () => {
    expect(shouldEmitAnnotations({ annotations: true, published: true, prComments: posted })).toBe(
      false
    );
  });

  it('emits them for a scan that posted nothing on a pull request, when on and published', () => {
    expect(
      shouldEmitAnnotations({ annotations: true, published: true, prComments: undefined })
    ).toBe(true);
    expect(
      shouldEmitAnnotations({ annotations: false, published: true, prComments: undefined })
    ).toBe(false);
    expect(
      shouldEmitAnnotations({ annotations: true, published: false, prComments: undefined })
    ).toBe(false);
  });
});

describe('lineNumber', () => {
  it('takes positive whole numbers and their decimal strings, nothing else', () => {
    expect([10, '10', ' 7 '].map(lineNumber)).toEqual([10, 10, 7]);
    expect([0, -1, 1.5, '', '3) [x](y)', null, undefined, 2 ** 53].map(lineNumber)).toEqual(
      Array(8).fill(undefined)
    );
  });
});

describe('issues', () => {
  it('files one labelled issue per new finding', async () => {
    const { api, state } = repository();
    const filed = await fileIssues(api, [finding('aa', 'high'), finding('bb', 'low')], CONTEXT);
    expect(filed.map(issue => issue.state)).toEqual(['created', 'created']);
    expect(state.created.map(issue => issue.labels)).toEqual([
      ['cynos-scan', 'cynos-scan:high'],
      ['cynos-scan', 'cynos-scan:low'],
    ]);
    expect([...state.labels].sort()).toEqual(['cynos-scan', 'cynos-scan:high', 'cynos-scan:low']);
  });

  it('does not file a finding an earlier scan filed, open or closed', async () => {
    const { api, state } = repository();
    await fileIssues(api, [finding('aa'), finding('bb')], CONTEXT);
    const filed = await fileIssues(api, [finding('aa'), finding('bb'), finding('cc')], CONTEXT);
    expect(filed.map(issue => issue.state)).toEqual(['existing', 'existing', 'created']);
    expect(state.issues).toHaveLength(3);
    const closed = repository([
      {
        body: '<!-- cynos-scan-fingerprint: codex-security/v1:sha256:aa -->\nfixed',
        html_url: 'https://x/7',
      },
    ]);
    expect((await fileIssues(closed.api, [finding('aa')], CONTEXT))[0]).toMatchObject({
      state: 'existing',
      url: 'https://x/7',
    });
  });

  it('does not file a finding whose fingerprint the marker cannot carry', async () => {
    const { api, state } = repository();
    const unusable = [
      { ...finding('aa'), fingerprints: {} },
      { ...finding('aa'), fingerprints: { primary: 'has space -->' } },
    ];
    const filed = await fileIssues(api, unusable, CONTEXT);
    expect(filed.map(issue => issue.state)).toEqual([
      'not filed: no usable fingerprint',
      'not filed: no usable fingerprint',
    ]);
    expect(state.issues).toHaveLength(0);
  });

  it('creates nothing on a dry run', async () => {
    const { api, state } = repository();
    expect((await fileIssues(api, [finding('aa')], CONTEXT, true))[0]?.state).toBe('would create');
    expect([state.issues.length, state.labels.size]).toEqual([0, 0]);
  });

  it('starts the body with the fingerprint and links locations at the scanned commit', () => {
    const body = issueBody(finding('aa'), CONTEXT);
    expect(body.split('\n')[0]).toBe(
      '<!-- cynos-scan-fingerprint: codex-security/v1:sha256:aa -->'
    );
    expect(MARKER.test(body)).toBe(true);
    expect(body.split('\n').filter(line => line.startsWith('- [`'))).toEqual([
      `- [\`functions/b.py:97\`](https://github.com/${REPOSITORY}/blob/${SHA}/functions/b.py#L97-L99) — root_control`,
      `- [\`functions/a.py:10\`](https://github.com/${REPOSITORY}/blob/${SHA}/functions/a.py#L10) — entrypoint`,
    ]);
    expect(body).toContain('- **Data flow:** body -> eval');
    expect(body).toContain('- **Impact:** high — Code execution.');
  });

  it('ends the body with the run, the commit and the rule only', () => {
    const body = issueBody(finding('aa'), CONTEXT);
    expect(body.split('\n').pop()).toMatch(
      new RegExp(
        `^Found by \\[cynos-scan\\]\\(${CONTEXT.runUrl}\\) at commit \`${SHA.slice(0, 12)}\`; rule \`[^\`]*\`\\.$`
      )
    );
  });

  it('breaks mentions and caps the body', () => {
    expect(issueBody(finding('aa', 'medium', 'ping @octocat and @org/team'), CONTEXT)).toContain(
      '@​octocat and @​org/team'
    );
    expect(issueBody(finding('aa', 'medium', 'x'.repeat(100_000)), CONTEXT).length).toBeLessThan(
      65_536
    );
  });
});

describe('reporting', () => {
  it('annotates the root-control location', () => {
    expect(reportedFindings({ findings: [finding('aa', 'High')] })[0]).toMatchObject({
      severity: 'high',
      path: 'functions/b.py',
      startLine: 97,
      endLine: 99,
    });
  });

  // The engine's safeLogLines prefixes each line with the name of the program that wrote it,
  // upstream codex-security.
  it('logs scanner diagnostics so they cannot issue runner commands', () => {
    expect(
      safeLogLines('::error file=a::forged\n\x1b[31mred\x1b[0m ##[set-output]x\r\n\n\u202eevil')
    ).toEqual([
      '[codex-security] ::error file=a::forged',
      '[codex-security] red ##\\[set-output]x',
      '[codex-security] evil',
    ]);
  });

  it('renders report fields as literals', () => {
    expect(html('<b>@user</b> *x*')).toBe('&lt;b&gt;&#64;user&lt;/b&gt; &#42;x&#42;');
  });

  it('publishes the validated findings of a scan of the checkout, completed or stopped short', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cynos-scan-reports-'));
    const reports = (manifest: string | undefined, findings = true) => {
      const path = join(directory, 'scan-manifest.json');
      if (manifest !== undefined) writeFileSync(path, manifest);
      return {
        directory,
        paths: manifest === undefined ? {} : { 'scan-manifest.json': path },
        findings: findings ? { findings: [] } : undefined,
        findingsProblem: findings ? '' : 'no findings.json',
        problems: [],
      };
    };
    const scan = (status: string, target: Record<string, unknown>) =>
      JSON.stringify({ scan: { status, target } });
    const head = { kind: 'git_revision', revision: SHA };
    expect(resultsAvailable(reports(scan('completed', head)), SHA)).toBe(true);
    expect(resultsAvailable(reports(scan('partial', head)), SHA)).toBe(true);
    expect(
      resultsAvailable(reports(scan('completed', { kind: 'git_diff', headRevision: SHA })), SHA)
    ).toBe(true);
    // A target change, rejected findings, and a manifest that is missing or not JSON.
    expect(
      resultsAvailable(reports(scan('completed', { ...head, revision: 'f'.repeat(40) })), SHA)
    ).toBe(false);
    expect(resultsAvailable(reports(scan('completed', head), false), SHA)).toBe(false);
    expect(resultsAvailable(reports(undefined), SHA)).toBe(false);
    expect(resultsAvailable(reports('{'), SHA)).toBe(false);
  });

  it("uploads the reports only when they are published, the action's records always", () => {
    const stage = mkdtempSync(join(tmpdir(), 'cynos-scan-stage-'));
    writeFileSync(join(stage, 'run.json'), '{}');
    const reports = {
      directory: join(stage, 'reports'),
      paths: { 'findings.json': join(stage, 'reports', 'findings.json') },
      findings: { findings: [] },
      findingsProblem: '',
      problems: [],
    };
    expect(reportFiles(stage, reports, true)).toEqual([
      join(stage, 'reports', 'findings.json'),
      join(stage, 'run.json'),
    ]);
    expect(reportFiles(stage, reports, false)).toEqual([join(stage, 'run.json')]);
  });

  it("summarises upstream's facts and this action's", () => {
    const body = summaryMarkdown({
      scanStatus: 'completed',
      policyStatus: 'passed',
      report: { reportStatus: 'ready', sarifUploadReady: true, success: true, title: 't' },
      reason: '',
      counts: { critical: 0, high: 1, medium: 0, low: 0, informational: 0 },
      findings: reportedFindings({ findings: [finding('aa', 'high')] }),
      covered: 'diff since abc',
      mode: 'standard',
      failOnSeverity: 'none',
      scannedSha: SHA,
      estimatedCost: 1.2,
      tokens: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 },
      elapsedSeconds: 600,
      knowledgeBase: 'docs/threatmodel.md',
      versions: { codex_security: '0.2.0' },
      issues: [{ state: 'created', title: 'X', url: 'https://x/1' }],
    });
    expect(body).toContain('**Scan:** completed · **Findings policy:** passed · **Report:** ready');
    expect(body).toContain('high: 1');
    expect(body).toContain('~$1.20');
    expect(body).toContain('1 new, 0 already filed');
    expect(body).toContain('<code>docs/threatmodel.md</code>');
    expect(body).toContain('**Scope:** diff since abc · **Mode:** standard\n');
    expect(body).not.toContain('Model:');
    expect(body).not.toContain('effort');
  });
});

describe('the threat model', () => {
  it('normalises whitespace for repository hooks', () => {
    expect(normalize('\n# Model  \r\n\nline \n\n\n')).toBe('# Model\n\nline\n');
  });
});
