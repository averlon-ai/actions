/**
 * The job summary and the source annotations, as upstream writes them
 * (openai/codex-security github-action/src/reporting.ts), plus what this action adds: what the
 * scan covered, the cost estimate, the versions it ran, the issues it filed, and what it posted on
 * the pull request.
 *
 * Report fields are model output derived from repository content, so they are rendered as
 * escaped literals: no markup, no @mentions that would notify anyone.
 */
import * as core from '@actions/core';
import {
  arr,
  at,
  obj,
  plain,
  text,
  type JsonObject,
  type Report,
  type ScanStatus,
  type Severity,
  type ValidatedReports,
} from '@averlon-ai/cynos-scan-engine';
import { readFileSync } from 'node:fs';
import type { PullRequestComments } from './pr-comments';

export { plain, safeLogLines } from '@averlon-ai/cynos-scan-engine';

export interface ReportedFinding {
  severity: Severity | string;
  title: string;
  summary: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}

/** Inline HTML still parses Markdown; entities keep report fields literal. */
export function html(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/@/g, '&#64;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/[\\`*_[\]~]/g, character => `&#${character.charCodeAt(0)};`);
}

const esc = (value: string, limit = 4000): string => html(plain(value, limit));

/**
 * Whether a scan's reports may be published, by upstream's rule: its action publishes the
 * reports, findings and annotations of any scan whose findings passed validation and whose
 * manifest records scanning the checkout's commit, whatever the outcome. A scan upstream stopped
 * short fails, but keeps its available results, and they are published as provisional. A scan of
 * another revision is a target change, and nothing of it is published.
 */
export function resultsAvailable(reports: ValidatedReports, scannedSha: string): boolean {
  const manifest = reports.paths['scan-manifest.json'];
  if (!reports.findings || !manifest) return false;
  // The engine copies the manifest without parsing it: one that is not JSON names no revision.
  let target: unknown;
  try {
    target = at(JSON.parse(readFileSync(manifest, 'utf8')) as JsonObject, 'scan', 'target');
  } catch {
    return false;
  }
  const kind = at(target, 'kind');
  const revision =
    kind === 'git_diff'
      ? at(target, 'headRevision')
      : kind === 'git_revision'
        ? at(target, 'revision')
        : '';
  return revision === scannedSha;
}

/** The location a reader opens first (the broken control), as upstream picks it. */
export function reportedFindings(findings: JsonObject | undefined): ReportedFinding[] {
  return arr(findings?.['findings']).map((finding): ReportedFinding => {
    const locations = arr(at(finding, 'locations')).map(obj);
    const location = locations.find(item => item['role'] === 'root_control') ?? locations[0] ?? {};
    const startLine = Number(location['startLine']);
    const endLine = Number(location['endLine'] ?? location['startLine']);
    const path = text(location['path']);
    return {
      severity: text(at(finding, 'severity', 'level'), 'unknown').toLowerCase(),
      title: text(at(finding, 'title')),
      summary: text(at(finding, 'summary')),
      ...(path ? { path } : {}),
      ...(Number.isSafeInteger(startLine) && startLine > 0 ? { startLine } : {}),
      ...(Number.isSafeInteger(endLine) && endLine > 0 ? { endLine } : {}),
    };
  });
}

export interface SummaryFacts {
  scanStatus: ScanStatus;
  policyStatus: string;
  report: Report;
  reason: string;
  counts: Record<string, number> | undefined;
  findings: ReportedFinding[];
  covered: string;
  mode: string;
  failOnSeverity: string;
  scannedSha: string;
  estimatedCost: number | undefined;
  tokens: Record<string, number> | undefined;
  elapsedSeconds: number | undefined;
  knowledgeBase: string;
  versions: Record<string, unknown> | undefined;
  issues: { state: string; title: string; url: string }[] | undefined;
  /** What was posted on the pull request; undefined when nothing was. */
  prComments?: PullRequestComments | undefined;
}

/** The summary body: upstream's sections first, then this action's. */
export function summaryMarkdown(facts: SummaryFacts): string {
  const counts = facts.counts
    ? Object.entries(facts.counts)
        .map(([level, count]) => `${level}: ${count}`)
        .join(' · ')
    : 'unavailable';
  const parts = [
    `**Scan:** ${facts.scanStatus} · **Findings policy:** ${facts.policyStatus} · **Report:** ${facts.report.reportStatus}`,
    `**Findings:** ${counts}`,
    `**Scope:** ${esc(facts.covered)} · **Mode:** ${facts.mode}`,
    `**Commit:** <code>${facts.scannedSha}</code>`,
    `**Failure threshold:** ${facts.failOnSeverity === 'none' ? 'report-only findings' : `${facts.failOnSeverity} and above`}. Partial scans fail without evaluating this policy.`,
  ];
  if (facts.estimatedCost !== undefined || facts.tokens) {
    const tokens = facts.tokens
      ? `${(facts.tokens['input_tokens'] ?? 0).toLocaleString('en-US')} input (${(facts.tokens['cached_input_tokens'] ?? 0).toLocaleString('en-US')} cached), ${(facts.tokens['output_tokens'] ?? 0).toLocaleString('en-US')} output`
      : 'unavailable';
    const cost =
      facts.estimatedCost === undefined ? 'unavailable' : `~$${facts.estimatedCost.toFixed(2)}`;
    const minutes =
      facts.elapsedSeconds === undefined
        ? ''
        : ` · **Elapsed:** ${(facts.elapsedSeconds / 60).toFixed(1)} min`;
    parts.push(
      `**Estimated cost:** ${cost} (the CLI's estimate; cynos bills the routed cost) · **Tokens:** ${tokens}${minutes}`
    );
  }
  if (facts.knowledgeBase)
    parts.push(`**Threat model given:** <code>${esc(facts.knowledgeBase)}</code>`);
  if (facts.report.reportStatus === 'partial')
    parts.push('SARIF report is unavailable; scan results and other reports are still available.');
  if (facts.scanStatus !== 'completed')
    parts.push('**Findings below are provisional. This is not a completed scan.**');
  if (facts.reason) parts.push(`<pre>${esc(facts.reason)}</pre>`);
  for (const finding of facts.findings.slice(0, 30))
    parts.push(
      `<h3>${finding.severity.toUpperCase()}: ${esc(finding.title, 200)}</h3>\n\n<code>${esc(finding.path ?? 'No source location')}:${finding.startLine ?? '?'}</code>\n\n<pre>${esc(finding.summary, 1200)}</pre>`
    );
  if (facts.findings.length > 30)
    parts.push(
      `${facts.findings.length - 30} additional findings are available in the JSON/SARIF reports.`
    );
  if (facts.issues) {
    const count = (state: string) => facts.issues?.filter(issue => issue.state === state).length;
    parts.push(
      `**GitHub issues:** ${count('created')} new, ${count('existing')} already filed by an earlier scan.`
    );
    for (const issue of facts.issues)
      parts.push(
        `- ${issue.state}: ${issue.url ? `<a href="${esc(issue.url)}">${esc(issue.title, 200)}</a>` : esc(issue.title, 200)}`
      );
  }
  if (facts.prComments) {
    const count = (state: string) =>
      facts.prComments?.reviewComments.filter(comment => comment.state === state).length;
    parts.push(
      `**Pull request comments:** <a href="${esc(facts.prComments.summaryUrl)}">summary comment</a> · review comments: ${count('created')} new, ${count('updated')} updated, ${count('not on a changed line')} findings not on a changed line.`
    );
  }
  if (facts.versions) {
    const keys = [
      'codex_security',
      'codex_security_tgz_sha256',
      'codex_cli',
      'plugin',
      'npm_tree_sha256',
      'image_id',
      'apparmor_profile',
      'apparmor_restrict_unprivileged_userns',
    ];
    parts.push(
      `<details><summary>Versions</summary>\n\n${keys.map(key => `- ${key}: <code>${esc(String(facts.versions?.[key] ?? ''))}</code>`).join('\n')}\n\n</details>`
    );
  }
  parts.push(
    'Use the action outputs for full JSON, coverage, and SARIF. Upload SARIF only when sarif-upload-ready is true. Reports can contain source code and vulnerability details.'
  );
  // GitHub check output is byte bounded. Truncate at UTF-8 boundaries.
  return Buffer.from(parts.join('\n\n')).subarray(0, 58_000).toString('utf8').replace(/�$/, '');
}

/** Writes the summary; failures to write it only warn, as upstream does. */
export async function writeSummary(title: string, body: string): Promise<void> {
  try {
    await core.summary.addRaw(`## cynos-scan\n\n**${title}**\n\n${body}`).write();
  } catch {
    core.warning('Could not write the job summary.');
  }
}

/**
 * Whether to emit the source annotations: when annotations is on and the reports are published,
 * unless the findings are already on the pull request. GitHub draws an annotation on the changed
 * line it names, beside that finding's review comment, so each finding would show twice; the
 * summary comment lists the findings no review comment carries. A scan whose pull request
 * comments were not posted (none to post, a stale scan, or a failure) keeps its annotations.
 */
export function shouldEmitAnnotations(facts: {
  annotations: boolean;
  published: boolean;
  prComments: PullRequestComments | undefined;
}): boolean {
  return facts.annotations && facts.published && !facts.prComments;
}

/** Up to 50 source annotations, as upstream emits them; the rest stay in the reports. */
export function emitAnnotations(findings: ReportedFinding[], scanStatus: ScanStatus): void {
  for (const finding of findings.slice(0, 50)) {
    const message = plain(
      `${scanStatus === 'completed' ? '' : 'Provisional finding: '}${finding.summary}`,
      4000
    );
    core.warning(message, {
      title: plain(`${finding.severity.toUpperCase()}: ${finding.title}`, 200),
      ...(finding.path ? { file: finding.path } : {}),
      ...(finding.startLine ? { startLine: finding.startLine } : {}),
      ...(finding.endLine ? { endLine: finding.endLine } : {}),
    });
  }
  if (findings.length > 50)
    core.notice('Additional findings are available in the job summary and reports.');
}
