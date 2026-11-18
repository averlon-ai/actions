/**
 * Files one GitHub issue per cynos-scan finding, once per finding.
 *
 * The repository is scanned again and again, and each scan re-reports what it found before;
 * filing on every scan would bury the tracker in duplicates. Every finding carries
 * codex-security's stable fingerprint (fingerprints.primary, the value SARIF holds as
 * partialFingerprints.codexSecurity/v1), so each issue records it in a hidden marker, and a
 * finding whose fingerprint already has an issue, open or closed, is skipped: a maintainer who
 * closed one as fixed or not a bug does not see it filed again. A finding without a fingerprint
 * the marker can carry is not filed: a later scan could not recognise its issue, and would file
 * it again on every run. Issues are never closed here;
 * one scan missing a finding is not evidence that it was fixed. The finding text is model
 * output derived from repository content, so @mentions are broken and the body is capped.
 */
import { arr, at, obj, text, type JsonObject } from '@averlon-ai/cynos-scan-engine';

export const LABEL = 'cynos-scan';
const LABEL_COLOR = '5319e7';
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'b60205',
  high: 'd93f0b',
  medium: 'fbca04',
  low: '0e8a16',
  informational: 'c5def5',
};
export const MARKER = /<!-- cynos-scan-fingerprint: (\S+) -->/;
/** A fingerprint the marker carries intact, like codex-security/v1:sha256:<hex>. */
const FINGERPRINT = /^[A-Za-z0-9._:/+=-]{1,200}$/;

/** Whether the fingerprint marker carries fingerprint intact, so a later scan recognises it. */
export function isUsableFingerprint(fingerprint: string): boolean {
  return FINGERPRINT.test(fingerprint);
}
/** GitHub rejects issue bodies above 65,536 characters; room is left for the footer. */
const BODY_LIMIT = 60_000;
const TITLE_LIMIT = 250;
/** The location a reader opens first: the broken control, then the dangerous call. */
export const LOCATION_ROLE_ORDER = ['root_control', 'sink', 'source', 'entrypoint'];

/** The GitHub calls issue filing needs. */
export interface IssuesApi {
  /** One page (1-based, 100 per page) of issues with the cynos-scan label, open or closed. */
  listLabelledIssues(page: number): Promise<{ body?: string | null; html_url: string }[]>;
  /** Creates a label; resolves false when it already exists. */
  createLabel(name: string, color: string, description: string): Promise<boolean>;
  createIssue(title: string, body: string, labels: string[]): Promise<{ html_url: string }>;
}

export interface FiledIssue {
  fingerprint: string;
  title: string;
  severity: string;
  state: 'created' | 'existing' | 'would create' | 'not filed: no usable fingerprint';
  url: string;
}

export interface IssueContext {
  repository: string;
  sha: string;
  runUrl: string;
}

/** fingerprint -> issue URL for every cynos-scan issue, open or closed. */
export async function existingFingerprints(api: IssuesApi): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    const issues = await api.listLabelledIssues(page);
    if (!issues.length) return found;
    for (const issue of issues) {
      const marker = MARKER.exec(issue.body ?? '');
      if (marker?.[1] && !found.has(marker[1])) found.set(marker[1], issue.html_url);
    }
  }
}

export function severityLabel(severity: string): string {
  return `${LABEL}:${severity}`;
}

export function severityOf(finding: JsonObject): string {
  return text(at(finding, 'severity', 'level'), 'unknown').toLowerCase();
}

/** Text whose @name mentions notify nobody when rendered by GitHub. */
export function withoutMentions(value: string): string {
  return value.replace(/@(?=[A-Za-z0-9])/g, '@​');
}

/** Attack-path fields are plain strings in some findings and {level, rationale} or {summary} in others. */
export function prose(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = obj(value);
    if ('summary' in record) return text(record['summary']);
    return ['level', 'rationale']
      .map(key => text(record[key]))
      .filter(Boolean)
      .join(' — ');
  }
  return text(value);
}

/** The finding's locations, most relevant first by LOCATION_ROLE_ORDER. */
export function locationsByRole(finding: JsonObject): JsonObject[] {
  const rank = (role: string): number =>
    LOCATION_ROLE_ORDER.includes(role)
      ? LOCATION_ROLE_ORDER.indexOf(role)
      : LOCATION_ROLE_ORDER.length;
  return arr(finding['locations'])
    .map(obj)
    .sort((a, b) => rank(text(a['role'])) - rank(text(b['role'])));
}

/**
 * The URL of path at sha, at lines start to end when given. Each path segment is
 * percent-encoded: a file name may hold #, ?, a space or parentheses, which would otherwise end
 * the URL's path or the Markdown link around it.
 */
export function blobUrl(
  repository: string,
  sha: string,
  path: string,
  start?: number,
  end?: number
): string {
  const encoded = path
    .split('/')
    .map(segment =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/');
  const lines = start ? `#L${start}${end && end > start ? `-L${end}` : ''}` : '';
  return `https://github.com/${repository}/blob/${sha}/${encoded}${lines}`;
}

/**
 * A location's line, when it is a positive whole number (the scanner writes numbers, or their
 * decimal strings). Anything else is model output that is not a line, and would otherwise reach
 * a link's URL or label as written.
 */
export function lineNumber(value: unknown): number | undefined {
  const line = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/** One markdown line per location, linked to the scanned commit, most relevant first. */
export function locationLines(finding: JsonObject, repository: string, sha: string): string[] {
  return locationsByRole(finding).map(location => {
    const path = text(location['path']);
    const start = lineNumber(location['startLine']);
    const end = lineNumber(location['endLine']);
    const label = start ? `${path}:${start}` : path;
    return `- [\`${label}\`](${blobUrl(repository, sha, path, start, end)}) — ${text(location['role'], 'location')}`;
  });
}

export function issueTitle(finding: JsonObject): string {
  return `[cynos-scan] ${text(finding['title'], 'Untitled finding')}`.slice(0, TITLE_LIMIT);
}

export function fingerprintOf(finding: JsonObject): string {
  return text(at(finding, 'fingerprints', 'primary'));
}

/** The finding as issue markdown, with the fingerprint marker first. */
export function issueBody(finding: JsonObject, context: IssueContext): string {
  const attack = obj(finding['attackPath']);
  const facts = [
    `**Severity:** ${severityOf(finding)}`,
    `**Confidence:** ${text(at(finding, 'confidence', 'level'), 'unknown')}`,
  ];
  const category = text(at(finding, 'taxonomy', 'category'));
  if (category) facts.push(`**Category:** ${category}`);
  const cwe = arr(at(finding, 'taxonomy', 'cwe')).map(value => text(value));
  if (cwe.length) facts.push(`**CWE:** ${cwe.join(', ')}`);
  const sections = [
    facts.join(' · '),
    '',
    text(finding['summary']),
    '',
    '### Locations',
    ...locationLines(finding, context.repository, context.sha),
    '',
  ];
  const rootCause = prose(finding['rootCause']);
  if (rootCause) sections.push('### Root cause', rootCause, '');
  const pathLines = (
    [
      ['Reachability', 'reachability'],
      ['Data flow', 'dataFlow'],
      ['Impact', 'impact'],
      ['Likelihood', 'likelihood'],
    ] as const
  )
    .filter(([, key]) => prose(attack[key]))
    .map(([label, key]) => `- **${label}:** ${prose(attack[key])}`);
  if (pathLines.length) sections.push('### Attack path', ...pathLines, '');
  const remediation = prose(finding['remediation']);
  if (remediation) sections.push('### Remediation', remediation, '');
  const rationale = text(at(finding, 'severity', 'rationale'));
  if (rationale) sections.push('### Why this severity', rationale, '');
  const content = withoutMentions(sections.join('\n')).slice(0, BODY_LIMIT);
  const footer =
    `---\nFound by [cynos-scan](${context.runUrl}) at commit \`${context.sha.slice(0, 12)}\`; ` +
    `rule \`${text(finding['ruleId'])}\`.`;
  return `<!-- cynos-scan-fingerprint: ${fingerprintOf(finding)} -->\n${content}\n${footer}`;
}

/** Creates the cynos-scan label and each severity label that does not exist yet. */
export async function ensureLabels(api: IssuesApi, severities: Iterable<string>): Promise<void> {
  await api.createLabel(LABEL, LABEL_COLOR, 'Found by the cynos-scan workflow');
  for (const severity of new Set(severities))
    await api.createLabel(
      severityLabel(severity),
      SEVERITY_COLORS[severity] ?? 'ededed',
      `cynos-scan severity: ${severity}`
    );
}

/** Creates one issue per finding whose fingerprint has none yet. */
export async function fileIssues(
  api: IssuesApi,
  findings: unknown[],
  context: IssueContext,
  dryRun = false
): Promise<FiledIssue[]> {
  const existing = await existingFingerprints(api);
  const records = findings.map(obj);
  if (!dryRun) await ensureLabels(api, records.map(severityOf));
  const filed: FiledIssue[] = [];
  for (const finding of records) {
    const fingerprint = fingerprintOf(finding);
    const title = issueTitle(finding);
    const severity = severityOf(finding);
    if (!isUsableFingerprint(fingerprint)) {
      filed.push({
        fingerprint,
        title,
        severity,
        state: 'not filed: no usable fingerprint',
        url: '',
      });
      continue;
    }
    const known = existing.get(fingerprint);
    if (known) {
      filed.push({ fingerprint, title, severity, state: 'existing', url: known });
      continue;
    }
    if (dryRun) {
      filed.push({ fingerprint, title, severity, state: 'would create', url: '' });
      continue;
    }
    const issue = await api.createIssue(title, issueBody(finding, context), [
      LABEL,
      severityLabel(severity),
    ]);
    existing.set(fingerprint, issue.html_url);
    filed.push({ fingerprint, title, severity, state: 'created', url: issue.html_url });
  }
  return filed;
}

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

/** IssuesApi over Octokit for owner/repo. */
export function octokitIssues(octokit: Octokit, owner: string, repo: string): IssuesApi {
  return {
    async listLabelledIssues(page) {
      const response = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels: LABEL,
        state: 'all',
        per_page: 100,
        page,
      });
      return response.data;
    },
    async createLabel(name, color, description) {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, name, color, description });
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 422) return false;
        throw error;
      }
    },
    async createIssue(title, body, labels) {
      const response = await octokit.rest.issues.create({ owner, repo, title, body, labels });
      return response.data;
    },
  };
}
