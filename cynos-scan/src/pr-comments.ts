/**
 * On a pull request, posts the findings of a diff scan on the pull request itself: one summary
 * comment that lists every finding, and one review comment per finding on the changed line it
 * points at.
 *
 * Two things make this harder than writing a comment per finding:
 *
 * - **GitHub takes a review comment only on a line of the pull request's diff**: an added or a
 *   context line, on the RIGHT side of a hunk. A review with one comment outside the diff is
 *   rejected whole (422). A finding has several locations (root_control, sink, source,
 *   entrypoint), and the most relevant one is often in code the pull request did not change. So
 *   each finding gets an anchor: the first commentable line of its locations, most relevant
 *   first, read from the hunks of the pull request's patches. A finding with no anchor is listed
 *   only in the summary comment.
 *
 *     @@ -10,2 +10,2 @@     the RIGHT side: line 10 (context) and line 11 (added)
 *      context
 *     -removed               (LEFT side only)
 *     +added
 *
 *   A finding with its root_control at line 40 and its sink at line 11 is anchored at line 11.
 *
 * - **Every push re-scans the pull request** and re-reports what it found before. A finding is
 *   recognised across scans by codex-security's fingerprint, the value the issues carry
 *   (issues.ts), kept in the same hidden marker at the start of each review comment. An earlier
 *   review comment for the finding that GitHub still shows on the anchor's line is updated in
 *   place; otherwise the finding gets a new review comment (the earlier one is outdated, or on
 *   another line). Every scan posts a new summary comment. Nothing is deleted: one scan missing a
 *   finding is not evidence that it was fixed. Only a top-level review comment this action's
 *   token posted, with the marker at its start, is updated: anyone can copy a marker into their
 *   own comment or reply, and theirs must not be overwritten.
 *
 * - **The pull request moves on during a scan.** Its files and lines are read when the scan
 *   ends, but the findings are of the scanned commit. Once another commit is pushed (or an older
 *   run is re-run), the two disagree, and a review comment could land on the wrong line or fail
 *   the whole review; so a scan of a commit that is no longer the pull request's head posts
 *   nothing. The newer commit's own scan reports on it.
 *
 * The finding text is model output derived from repository content, so @mentions are broken and
 * every body is capped below GitHub's comment limit. A review comment renders the title and
 * summary as escaped literals, and its More details holds the finding's JSON verbatim, in a code
 * block, where GitHub notifies no @mention.
 */
import { obj, text, type JsonObject } from '@averlon-ai/cynos-scan-engine';
import {
  blobUrl,
  fingerprintOf,
  isUsableFingerprint,
  lineNumber,
  locationsByRole,
  MARKER,
  severityOf,
  withoutMentions,
  type FiledIssue,
} from './issues';
import { html } from './reporting';

/** GitHub rejects comment bodies above 65,536 characters; room is left for the footer. */
const BODY_LIMIT = 60_000;
const SUMMARY_MARKER = '<!-- cynos-scan-pr-summary -->';
/** The start of every review comment this action posts for a finding with a usable fingerprint. */
const REVIEW_COMMENT_MARKER_START = '<!-- cynos-scan-fingerprint: ';
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational'];

/** A file the pull request changes, as GitHub lists it. */
export interface PullRequestFile {
  filename: string;
  status: string;
  /** The unified diff; GitHub omits it for a binary or very large file. */
  patch?: string;
}

/** A review comment already on the pull request. */
export interface ExistingReviewComment {
  id: number;
  body: string;
  path: string;
  /** Its line on the pull request's head; null once the comment is outdated. */
  line: number | null;
  html_url: string;
  /** Who posted it. */
  author: string;
  /** The comment it replies to, when it is a reply. */
  inReplyTo?: number | undefined;
}

/** A review comment to create: on path, from startLine to line on the RIGHT side. */
export interface NewReviewComment {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

/** The GitHub calls posting needs, for one pull request. */
export interface PullRequestApi {
  /** The commit the pull request's head is at now. */
  headSha(): Promise<string>;
  /** The login this action posts as. */
  postingAuthor(): Promise<string>;
  /** One page (1-based, 100 per page) of the files the pull request changes. */
  listFiles(page: number): Promise<PullRequestFile[]>;
  /** One page (1-based, 100 per page) of the pull request's review comments. */
  listReviewComments(page: number): Promise<ExistingReviewComment[]>;
  updateReviewComment(id: number, body: string): Promise<{ html_url: string }>;
  /** Creates one review of these review comments at commitId; resolves the comments created. */
  createReview(
    commitId: string,
    body: string,
    comments: NewReviewComment[]
  ): Promise<{ body: string; html_url: string }[]>;
  createSummaryComment(body: string): Promise<{ html_url: string }>;
}

export interface PullRequestContext {
  /** owner/repo. */
  repository: string;
  /** The scanned commit: the pull request's head. */
  sha: string;
  diffBase: string;
  runUrl: string;
  /** The artifact this run uploads its reports to, findings.json among them; unset when none. */
  reportsArtifact?: string | undefined;
  /** A mock scan's findings are synthetic, and the comments say so. */
  mock: boolean;
  /** The issues file-issues filed or found, to link each finding's issue. */
  issues?: FiledIssue[];
  /** How many findings were left out because false-positives dismissed their fingerprint. */
  dismissed?: number;
}

export interface PostedReviewComment {
  fingerprint: string;
  title: string;
  severity: string;
  state: 'created' | 'updated' | 'not on a changed line';
  url: string;
}

export interface PullRequestComments {
  summaryUrl: string;
  reviewComments: PostedReviewComment[];
}

/** Why nothing was posted. */
export interface NothingPosted {
  skipped: string;
}

/** Where a finding's review comment goes: lines startLine to line of path, in one hunk. */
export interface Anchor {
  path: string;
  startLine: number;
  line: number;
}

/** path -> commentable line -> the index of the hunk it is in. */
export type CommentableLines = Map<string, Map<number, number>>;

/**
 * Posts the summary comment and the review comments for findings.
 *
 * @returns What was posted, or why nothing was: no findings, or a stale scan.
 */
export async function postPullRequestComments(
  api: PullRequestApi,
  findings: unknown[],
  context: PullRequestContext
): Promise<PullRequestComments | NothingPosted> {
  const records = findings.map(obj);
  if (!records.length) return { skipped: 'the scan has no findings' };

  // 1. A stale scan: the pull request's diff is no longer the scanned commit's.
  const head = await api.headSha();
  if (head !== context.sha)
    return {
      skipped: `the pull request's head moved on to ${head.slice(0, 12)} after the scanned ${context.sha.slice(0, 12)}`,
    };
  // 2. The lines GitHub takes a review comment on, from the pull request's patches.
  const lines = commentableLines(await pages(page => api.listFiles(page)));
  // 3. Each finding's anchor: its first location, most relevant first, on a commentable line.
  const anchors = records.map(finding => anchorOf(finding, lines));
  // 4. The review comments earlier scans of this pull request posted, by fingerprint.
  const earlier = reviewCommentsByFingerprint(
    await pages(page => api.listReviewComments(page)),
    await api.postingAuthor()
  );
  // 5. Update each earlier review comment still on its finding's anchor; queue the rest.
  const reviewComments = await updateOrQueueReviewComments(api, records, anchors, earlier, context);
  // 6. One review for the queued review comments: one notification, not one per finding.
  await createQueuedReviewComments(api, reviewComments, context);
  // 7. The summary comment, linking each finding's review comment.
  const summary = await api.createSummaryComment(
    summaryCommentBody(records, anchors, reviewComments, context)
  );
  return {
    summaryUrl: summary.html_url,
    reviewComments: reviewComments.map(({ fingerprint, title, severity, state, url }) => ({
      fingerprint,
      title,
      severity,
      state,
      url,
    })),
  };
}

/** Every page of a listing, until GitHub returns an empty one. */
async function pages<T>(list: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const items = await list(page);
    if (!items.length) return all;
    all.push(...items);
  }
}

/**
 * The lines of each changed file GitHub takes a review comment on: the RIGHT side of every hunk,
 * context and added lines. A removed file has none, nor does one whose patch GitHub omits.
 * Lines before the first hunk header are not in a hunk, and are skipped.
 */
export function commentableLines(files: PullRequestFile[]): CommentableLines {
  const lines: CommentableLines = new Map();
  for (const file of files) {
    if (file.status === 'removed' || !file.patch) continue;
    const fileLines = new Map<number, number>();
    let hunk = -1;
    let next = 0;
    for (const patchLine of file.patch.split('\n')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patchLine);
      if (header) {
        hunk += 1;
        next = Number(header[1]);
      } else if (hunk >= 0 && (patchLine.startsWith(' ') || patchLine.startsWith('+'))) {
        fileLines.set(next, hunk);
        next += 1;
      }
      // '-' lines are on the LEFT side only; '\ No newline at end of file' is no line.
    }
    lines.set(file.filename, fileLines);
  }
  return lines;
}

/**
 * The finding's anchor: in its most relevant location with a commentable line, the first such
 * line, through the last of the location's lines in the same hunk (a review comment's lines
 * must be in one hunk). undefined when no location is on a commentable line.
 *
 * The line range is model output and can be any size, so it is never walked line by line:
 * the file's commentable lines, bounded by the patch, are the ones checked against it.
 */
export function anchorOf(finding: JsonObject, lines: CommentableLines): Anchor | undefined {
  for (const location of locationsByRole(finding)) {
    const path = text(location['path']);
    const fileLines = lines.get(path);
    const start = lineNumber(location['startLine']);
    if (!fileLines || start === undefined) continue;
    const end = Math.max(start, lineNumber(location['endLine']) ?? start);
    const changed = [...fileLines.keys()]
      .filter(line => line >= start && line <= end)
      .sort((a, b) => a - b);
    const first = changed[0];
    if (first === undefined) continue;
    const last = changed.filter(line => fileLines.get(line) === fileLines.get(first)).pop();
    return { path, startLine: first, line: last ?? first };
  }
  return undefined;
}

/**
 * fingerprint -> the review comments this action posted for it: top-level comments by author
 * that start with the marker. A reply, or a comment by anyone else, is never one of them, even
 * when it quotes a marker.
 */
export function reviewCommentsByFingerprint(
  comments: ExistingReviewComment[],
  author: string
): Map<string, ExistingReviewComment[]> {
  const byFingerprint = new Map<string, ExistingReviewComment[]>();
  for (const comment of comments) {
    if (
      comment.author !== author ||
      comment.inReplyTo !== undefined ||
      !comment.body.startsWith(REVIEW_COMMENT_MARKER_START)
    )
      continue;
    const fingerprint = MARKER.exec(comment.body)?.[1];
    if (fingerprint)
      byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), comment]);
  }
  return byFingerprint;
}

/** A finding's review comment, and the new one to create when it is queued. */
type ReviewCommentPlan = PostedReviewComment & { queued?: NewReviewComment };

/**
 * Updates the earlier review comment of each anchored finding that GitHub still shows on the
 * anchor's line, and queues a new review comment for every other anchored finding. A finding
 * without a usable fingerprint has no marker, so it cannot be recognised, and always gets a new
 * one; so does one whose earlier review comment GitHub refuses to update.
 */
async function updateOrQueueReviewComments(
  api: PullRequestApi,
  findings: JsonObject[],
  anchors: (Anchor | undefined)[],
  earlier: Map<string, ExistingReviewComment[]>,
  context: PullRequestContext
): Promise<ReviewCommentPlan[]> {
  const plans: ReviewCommentPlan[] = [];
  for (const [index, finding] of findings.entries()) {
    const fingerprint = fingerprintOf(finding);
    const posted = {
      fingerprint,
      title: text(finding['title'], 'Untitled finding'),
      severity: severityOf(finding),
    };
    const anchor = anchors[index];
    if (!anchor) {
      plans.push({ ...posted, state: 'not on a changed line', url: '' });
      continue;
    }
    const body = reviewCommentBody(finding, context);
    const onAnchor = isUsableFingerprint(fingerprint)
      ? earlier
          .get(fingerprint)
          ?.find(comment => comment.path === anchor.path && comment.line === anchor.line)
      : undefined;
    const updated = onAnchor && (await updateReviewComment(api, onAnchor.id, body));
    if (updated) {
      plans.push({ ...posted, state: 'updated', url: updated.html_url });
      continue;
    }
    plans.push({
      ...posted,
      state: 'created',
      url: '',
      queued: {
        path: anchor.path,
        line: anchor.line,
        ...(anchor.startLine < anchor.line ? { startLine: anchor.startLine } : {}),
        body,
      },
    });
  }
  return plans;
}

/** The updated review comment, or undefined when GitHub refuses the update. */
async function updateReviewComment(
  api: PullRequestApi,
  id: number,
  body: string
): Promise<{ html_url: string } | undefined> {
  try {
    return await api.updateReviewComment(id, body);
  } catch {
    return undefined;
  }
}

/** Creates the queued review comments as one review, and records each one's URL. */
async function createQueuedReviewComments(
  api: PullRequestApi,
  plans: ReviewCommentPlan[],
  context: PullRequestContext
): Promise<void> {
  const queued = plans.filter(plan => plan.queued);
  if (!queued.length) return;
  const created = await api.createReview(
    context.sha,
    `cynos-scan: ${queued.length} finding${queued.length === 1 ? '' : 's'} on lines this pull request changes.`,
    queued.map(plan => plan.queued as NewReviewComment)
  );
  // GitHub returns the review's comments in no promised order: match them by body, which holds
  // the fingerprint marker, and by order among equal bodies.
  const unmatched = [...created];
  for (const plan of queued) {
    const match = unmatched.findIndex(comment => comment.body === plan.queued?.body);
    if (match >= 0) plan.url = unmatched.splice(match, 1)[0]?.html_url ?? '';
  }
}

/**
 * The finding as a review comment, with the marker first: its title and summary, its issue, then
 * the whole finding (root cause, remediation, attack path, code evidence, ...) under More details.
 */
export function reviewCommentBody(finding: JsonObject, context: PullRequestContext): string {
  const fingerprint = fingerprintOf(finding);
  const title = text(finding['title'], 'Untitled finding').replace(/\s+/g, ' ');
  const sections = [
    `**${severityOf(finding).toUpperCase()}: ${literal(title)}**`,
    '',
    literal(text(finding['summary'])),
  ];
  const issue = context.issues?.find(filed => filed.fingerprint === fingerprint && filed.url);
  if (issue) sections.push('', `Tracked in ${issue.url}.`);
  const content = sections.join('\n').slice(0, BODY_LIMIT);
  const details = findingDetails(finding, BODY_LIMIT - content.length, context.reportsArtifact);
  const marker = isUsableFingerprint(fingerprint)
    ? `<!-- cynos-scan-fingerprint: ${fingerprint} -->\n`
    : '';
  return `${marker}${mockBanner(context)}${content}${details}\n\n${footer(context)}`;
}

/**
 * Model-written prose as escaped literals, line by line, as the job summary renders report
 * fields (html). Markup in a title or summary would otherwise reach past it: an unclosed HTML
 * block (`<pre>`, `<!--`) or code fence (```` ``` ````, `~~~`) runs over the More details and
 * the footer that follow, and a JSON field that closes it leaves the rest of the JSON rendered
 * as Markdown, its @mentions live. Escaped, every character shows as written and none opens a
 * block. Lines keep their breaks but not their indent, which would make them a code block;
 * @mentions are broken first, since GitHub links one written as an entity too.
 */
function literal(value: string): string {
  return withoutMentions(value)
    .split('\n')
    .map(line => html(line.trimStart()))
    .join('\n');
}

const DETAILS_OPEN = '\n\n<details><summary>More details</summary>\n\n';
const FENCE = '```';
const DETAILS_CLOSE = '\n\n</details>';

/**
 * The finding's JSON as a collapsed More details section, in at most budget characters; '' when
 * not even a cut JSON fits.
 *
 * The JSON is model output and goes in verbatim, so two things must hold:
 *
 * - **Nothing in it may close its code block.** Code evidence can hold backtick runs, and a run of
 *   three or more would end the block and render the rest as Markdown and HTML. Such runs are
 *   written as JSON escapes (withoutFenceRuns), so the JSON parses back the same, a fixed
 *   three-backtick fence holds it, and even a `</details>` inside stays literal. A fence sized to
 *   the longest run instead would grow with it, and leave no room for the JSON.
 * - **It fits GitHub's comment limit.** A finding is a few KB, but its code evidence has no bound:
 *   a JSON over the budget is cut, with a note after the block (truncationNote) that says where
 *   the full finding is, when the run keeps it at all.
 *
 * @mentions are left as written: GitHub neither links nor notifies them inside a code block, and
 * the JSON stays copyable.
 */
export function findingDetails(
  finding: JsonObject,
  budget: number,
  reportsArtifact?: string
): string {
  const json = withoutFenceRuns(JSON.stringify(finding, null, 2));
  const wrapper = DETAILS_OPEN.length + 2 * FENCE.length + 'json\n\n'.length + DETAILS_CLOSE.length;
  if (wrapper + json.length <= budget)
    return `${DETAILS_OPEN}${FENCE}json\n${json}\n${FENCE}${DETAILS_CLOSE}`;
  // Over the budget: keep what fits of the JSON (never half a surrogate pair), and say where the
  // rest is.
  const note = truncationNote(reportsArtifact);
  const room = budget - wrapper - note.length;
  if (room <= 0) return '';
  const cut = json.slice(0, room).replace(/[\uD800-\uDBFF]$/, '');
  return `${DETAILS_OPEN}${FENCE}json\n${cut}\n${FENCE}${note}${DETAILS_CLOSE}`;
}

/**
 * Where a cut finding's full JSON is. Only an uploaded report outlives the job (the post step
 * deletes the local reports), and a run uploads its reports only with upload-artifacts; a pull
 * request comment is posted only for published reports, so the upload holds findings.json.
 */
function truncationNote(reportsArtifact: string | undefined): string {
  return reportsArtifact
    ? `\n\nTruncated to fit a GitHub comment: the full finding is in findings.json, in the run's \`${reportsArtifact}\` artifact.`
    : "\n\nTruncated to fit a GitHub comment. Set `upload-artifacts: true` to keep the full finding in the run's reports.";
}

/**
 * JSON text with every run of three or more backticks written as \u0060 escapes: the same JSON
 * once parsed, and no run that could close a three-backtick fence. A backtick occurs in JSON text
 * only inside a string, where the escape is valid. Single and double backticks (Go struct tags,
 * template literals, inline code) stay as written, for the reader.
 */
function withoutFenceRuns(json: string): string {
  return json.replace(/`{3,}/g, run => '\\u0060'.repeat(run.length));
}

/**
 * The summary comment: the counts, then one table row per finding, most severe first, with its
 * location and its review comment, or why it has none.
 */
export function summaryCommentBody(
  findings: JsonObject[],
  anchors: (Anchor | undefined)[],
  plans: PostedReviewComment[],
  context: PullRequestContext
): string {
  const rows = findings
    .map((finding, index) => ({ finding, anchor: anchors[index], plan: plans[index] }))
    .sort((a, b) => severityRank(severityOf(a.finding)) - severityRank(severityOf(b.finding)));
  const counts = SEVERITY_ORDER.map(
    level => [level, rows.filter(row => severityOf(row.finding) === level).length] as const
  )
    .filter(([, count]) => count)
    .map(([level, count]) => `${level}: ${count}`)
    .join(' · ');
  const header = [
    SUMMARY_MARKER,
    `## cynos-scan: ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    '',
    `${mockBanner(context)}**Findings:** ${counts || 'unknown severity'}${dismissedNote(context)} · **Commit:** \`${context.sha.slice(0, 12)}\` · **Diff since:** \`${context.diffBase.slice(0, 12)}\``,
    '',
    '| Severity | Finding | Location | Review comment |',
    '| --- | --- | --- | --- |',
  ].join('\n');
  const tail = `\n\n${footer(context)}`;
  let body = header;
  for (const [shown, row] of rows.entries()) {
    const line = `\n| ${severityOf(row.finding)} | ${cell(text(row.finding['title'], 'Untitled finding'))} | ${locationLink(row.finding, row.anchor, context)} | ${reviewCommentCell(row.plan)} |`;
    if (body.length + line.length + tail.length > BODY_LIMIT) {
      body += `\n\n${rows.length - shown} more findings are in the run's job summary and reports.`;
      break;
    }
    body += line;
  }
  return `${body}${tail}`;
}

function severityRank(severity: string): number {
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank < 0 ? SEVERITY_ORDER.length : rank;
}

/** Text for one table cell: one line, no column breaks, no mentions. */
function cell(value: string): string {
  // Truncate before escaping so the limit cannot split an escape sequence.
  return withoutMentions(value.replace(/\s+/g, ' '))
    .slice(0, 300)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

/** The anchor, or the most relevant location when there is none, linked at the scanned commit. */
function locationLink(
  finding: JsonObject,
  anchor: Anchor | undefined,
  context: PullRequestContext
): string {
  const location = locationsByRole(finding)[0];
  const path = anchor?.path ?? text(location?.['path']);
  if (!path) return 'no source location';
  const start = anchor ? anchor.startLine : lineNumber(location?.['startLine']);
  const end = anchor ? anchor.line : lineNumber(location?.['endLine']);
  return `[\`${cell(path)}${start ? `:${start}` : ''}\`](${blobUrl(context.repository, context.sha, path, start, end)})`;
}

function reviewCommentCell(plan: PostedReviewComment | undefined): string {
  if (!plan || plan.state === 'not on a changed line') return 'not on a changed line';
  return plan.url ? `[${plan.state}](${plan.url})` : plan.state;
}

/** The dismissed findings' count, which the table leaves out. */
function dismissedNote(context: PullRequestContext): string {
  return context.dismissed ? ` · **Dismissed in false-positives:** ${context.dismissed}` : '';
}

function mockBanner(context: PullRequestContext): string {
  return context.mock ? '> **Mock scan:** these findings are synthetic.\n\n' : '';
}

function footer(context: PullRequestContext): string {
  return `---\nFound by [cynos-scan](${context.runUrl}) at commit \`${context.sha.slice(0, 12)}\`.`;
}

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

/** PullRequestApi over Octokit for pull request number of owner/repo. */
export function octokitPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): PullRequestApi {
  const pull = { owner, repo, pull_number: number };
  return {
    async headSha() {
      return (await octokit.rest.pulls.get(pull)).data.head.sha;
    },
    async postingAuthor() {
      // A personal token's user; the workflow's GITHUB_TOKEN, an installation token, may not
      // read /user, and posts as github-actions[bot]. Another app's token matches no earlier
      // comment, so its findings get new review comments rather than updated ones.
      try {
        return (await octokit.rest.users.getAuthenticated()).data.login;
      } catch {
        return 'github-actions[bot]';
      }
    },
    async listFiles(page) {
      return (await octokit.rest.pulls.listFiles({ ...pull, per_page: 100, page })).data;
    },
    async listReviewComments(page) {
      const response = await octokit.rest.pulls.listReviewComments({
        ...pull,
        per_page: 100,
        page,
      });
      return response.data.map(comment => ({
        id: comment.id,
        body: comment.body,
        path: comment.path,
        line: comment.line ?? null,
        html_url: comment.html_url,
        author: comment.user?.login ?? '',
        inReplyTo: comment.in_reply_to_id ?? undefined,
      }));
    },
    async updateReviewComment(id, body) {
      const response = await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: id,
        body,
      });
      return response.data;
    },
    async createReview(commitId, body, comments) {
      const review = await octokit.rest.pulls.createReview({
        ...pull,
        commit_id: commitId,
        event: 'COMMENT',
        body,
        comments: comments.map(comment => ({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT',
          ...(comment.startLine ? { start_line: comment.startLine, start_side: 'RIGHT' } : {}),
          body: comment.body,
        })),
      });
      return pages(async page =>
        (
          await octokit.rest.pulls.listCommentsForReview({
            ...pull,
            review_id: review.data.id,
            per_page: 100,
            page,
          })
        ).data.map(comment => ({ body: comment.body, html_url: comment.html_url }))
      );
    },
    async createSummaryComment(body) {
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body,
      });
      return response.data;
    },
  };
}
