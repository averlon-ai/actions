import { describe, it, expect } from 'bun:test';
import {
  anchorOf,
  commentableLines,
  findingDetails,
  postPullRequestComments,
  reviewCommentBody,
  summaryCommentBody,
  type ExistingReviewComment,
  type NewReviewComment,
  type PullRequestApi,
  type PullRequestComments,
  type PullRequestContext,
  type PullRequestFile,
} from '../pr-comments';

const REPOSITORY = 'averlon-security/kca';
const SHA = `8b314d4${'0'.repeat(33)}`;
const BASE = `1a2b3c4${'0'.repeat(33)}`;
const CONTEXT: PullRequestContext = {
  repository: REPOSITORY,
  sha: SHA,
  diffBase: BASE,
  runUrl: 'https://github.com/r/actions/runs/1',
  mock: false,
};

/** functions/b.py: lines 95-101 on the RIGHT side; functions/c.py changes lines 3-4. */
const FILES: PullRequestFile[] = [
  {
    filename: 'functions/b.py',
    status: 'modified',
    patch: [
      '@@ -95,4 +95,5 @@ def rules():',
      ' context95',
      '-old96',
      '+new96',
      '+new97',
      ' context98',
      ' context99',
      '@@ -120,2 +121,2 @@',
      ' context121',
      '+new122',
      '\\ No newline at end of file',
    ].join('\n'),
  },
  { filename: 'functions/c.py', status: 'added', patch: '@@ -0,0 +1,2 @@\n+one\n+two' },
  { filename: 'image.png', status: 'modified' },
  { filename: 'gone.py', status: 'removed', patch: '@@ -1,1 +0,0 @@\n-gone' },
];

function finding(
  fingerprint: string,
  locations: Record<string, unknown>[] = [
    { path: 'functions/a.py', role: 'entrypoint', startLine: '10' },
    { path: 'functions/b.py', role: 'root_control', startLine: 97, endLine: 99 },
  ],
  severity = 'medium'
): Record<string, unknown> {
  return {
    title: `Finding ${fingerprint}`,
    summary: 'eval() on graph data from @someone',
    severity: { level: severity },
    fingerprints: { primary: `codex-security/v1:sha256:${fingerprint}` },
    locations,
    rootCause: { summary: 'Rules are evaluated as Python.' },
    remediation: 'Use ast.literal_eval.',
  };
}

const BOT = 'github-actions[bot]';

/** The finding JSON in a review comment's More details, parsed back. */
function detailsJson(body: string): unknown {
  const block = /\n```json\n([\s\S]*)\n```\n/.exec(body);
  return JSON.parse(block?.[1] ?? 'null');
}

/** An in-memory pull request: its head, files and review comments, and the comments posted. */
function pullRequest(files = FILES, existing: ExistingReviewComment[] = [], head = SHA) {
  const state = {
    reviewComments: [...existing],
    reviews: [] as NewReviewComment[][],
    updated: [] as number[],
    summaries: [] as string[],
  };
  const api: PullRequestApi = {
    async headSha() {
      return head;
    },
    async postingAuthor() {
      return BOT;
    },
    async listFiles(page) {
      // Two pages, then an empty one: exercises pagination.
      return page === 1 ? files.slice(0, 1) : page === 2 ? files.slice(1) : [];
    },
    async listReviewComments(page) {
      return page === 1 ? state.reviewComments : [];
    },
    async updateReviewComment(id, body) {
      const comment = state.reviewComments.find(item => item.id === id);
      if (comment) comment.body = body;
      state.updated.push(id);
      return { html_url: `https://x/comment/${id}` };
    },
    async createReview(_commitId, _body, comments) {
      state.reviews.push(comments);
      // In reverse: GitHub promises no order.
      return comments
        .map((comment, index) => ({ body: comment.body, html_url: `https://x/new/${index}` }))
        .reverse();
    },
    async createSummaryComment(body) {
      state.summaries.push(body);
      return { html_url: `https://x/summary/${state.summaries.length}` };
    },
  };
  return { api, state };
}

/** What postPullRequestComments posted; fails the test when it skipped. */
async function post(api: PullRequestApi, findings: unknown[]): Promise<PullRequestComments> {
  const result = await postPullRequestComments(api, findings, CONTEXT);
  if ('skipped' in result) throw new Error(`skipped: ${result.skipped}`);
  return result;
}

/** A review comment for finding aa on functions/b.py, by default the action's own. */
function earlier(
  id: number,
  line: number | null,
  overrides: Partial<ExistingReviewComment> = {}
): ExistingReviewComment {
  return {
    id,
    body: '<!-- cynos-scan-fingerprint: codex-security/v1:sha256:aa -->\nold',
    path: 'functions/b.py',
    line,
    html_url: `https://x/comment/${id}`,
    author: BOT,
    ...overrides,
  };
}

describe('commentableLines', () => {
  it("takes the RIGHT side of every hunk, and no removed or patchless file's lines", () => {
    const lines = commentableLines(FILES);
    expect([...(lines.get('functions/b.py')?.entries() ?? [])]).toEqual([
      [95, 0],
      [96, 0],
      [97, 0],
      [98, 0],
      [99, 0],
      [121, 1],
      [122, 1],
    ]);
    expect([...(lines.get('functions/c.py')?.keys() ?? [])]).toEqual([1, 2]);
    expect(lines.has('image.png')).toBe(false);
    expect(lines.has('gone.py')).toBe(false);
  });
});

describe('anchorOf', () => {
  const lines = commentableLines(FILES);

  it('anchors at the most relevant location on a changed line, across its lines in the hunk', () => {
    expect(anchorOf(finding('aa'), lines)).toEqual({
      path: 'functions/b.py',
      startLine: 97,
      line: 99,
    });
  });

  it('falls back to a less relevant location when the root_control is outside the diff', () => {
    const anchored = finding('aa', [
      { path: 'functions/b.py', role: 'root_control', startLine: 40 },
      { path: 'functions/c.py', role: 'sink', startLine: 2 },
    ]);
    expect(anchorOf(anchored, lines)).toEqual({ path: 'functions/c.py', startLine: 2, line: 2 });
  });

  it('starts at the first changed line of a location and stays in its hunk', () => {
    const spanning = finding('aa', [
      { path: 'functions/b.py', role: 'root_control', startLine: 90, endLine: 125 },
    ]);
    expect(anchorOf(spanning, lines)).toEqual({
      path: 'functions/b.py',
      startLine: 95,
      line: 99,
    });
  });

  it('checks a range of any size against the changed lines, never line by line', () => {
    const huge = finding('aa', [
      { path: 'functions/b.py', role: 'root_control', startLine: 1, endLine: 4294967296 },
    ]);
    expect(anchorOf(huge, lines)).toEqual({ path: 'functions/b.py', startLine: 95, line: 99 });
  });

  it('has none when no location is on a changed line', () => {
    expect(
      anchorOf(finding('aa', [{ path: 'functions/a.py', role: 'sink', startLine: 1 }]), lines)
    ).toBeUndefined();
    expect(anchorOf(finding('aa', [{ path: 'functions/b.py' }]), lines)).toBeUndefined();
  });
});

describe('postPullRequestComments', () => {
  it('posts nothing without findings', async () => {
    const { api, state } = pullRequest();
    expect(await postPullRequestComments(api, [], CONTEXT)).toEqual({
      skipped: 'the scan has no findings',
    });
    expect([state.reviews.length, state.summaries.length]).toEqual([0, 0]);
  });

  it("posts nothing for a stale scan: the pull request's head moved on", async () => {
    const { api, state } = pullRequest(FILES, [], `f${'0'.repeat(39)}`);
    expect(await postPullRequestComments(api, [finding('aa')], CONTEXT)).toEqual({
      skipped: `the pull request's head moved on to f00000000000 after the scanned ${SHA.slice(0, 12)}`,
    });
    expect([state.reviews.length, state.updated.length, state.summaries.length]).toEqual([0, 0, 0]);
  });

  it('creates every new review comment in one review, then the summary comment', async () => {
    const { api, state } = pullRequest();
    const outside = finding('cc', [{ path: 'functions/a.py', role: 'sink', startLine: 1 }]);
    const posted = await post(api, [
      finding('aa'),
      finding('bb', [{ path: 'functions/c.py', startLine: 1 }]),
      outside,
    ]);
    expect(state.reviews).toHaveLength(1);
    expect(
      state.reviews[0]?.map(({ path, line, startLine }) => ({ path, line, startLine }))
    ).toEqual([
      { path: 'functions/b.py', line: 99, startLine: 97 },
      { path: 'functions/c.py', line: 1, startLine: undefined },
    ]);
    // Matched back to their findings whatever order GitHub returns them in.
    expect(posted.reviewComments).toEqual([
      {
        fingerprint: 'codex-security/v1:sha256:aa',
        title: 'Finding aa',
        severity: 'medium',
        state: 'created',
        url: 'https://x/new/0',
      },
      {
        fingerprint: 'codex-security/v1:sha256:bb',
        title: 'Finding bb',
        severity: 'medium',
        state: 'created',
        url: 'https://x/new/1',
      },
      {
        fingerprint: 'codex-security/v1:sha256:cc',
        title: 'Finding cc',
        severity: 'medium',
        state: 'not on a changed line',
        url: '',
      },
    ]);
    expect(posted.summaryUrl).toBe('https://x/summary/1');
    expect(state.summaries[0]).toContain('not on a changed line');
    expect(state.summaries[0]).toContain('[created](https://x/new/0)');
  });

  it("updates an earlier scan's review comment still on the anchor's line, and posts a new summary", async () => {
    const { api, state } = pullRequest(FILES, [earlier(7, null), earlier(8, 99)]);
    const posted = await post(api, [finding('aa')]);
    expect(state.updated).toEqual([8]);
    expect(state.reviews).toHaveLength(0);
    expect(posted.reviewComments[0]).toMatchObject({
      state: 'updated',
      url: 'https://x/comment/8',
    });
    await post(api, [finding('aa')]);
    expect(state.summaries).toHaveLength(2);
  });

  it('posts a new review comment when the earlier one is outdated or on another line', async () => {
    const { api, state } = pullRequest(FILES, [earlier(7, 122)]);
    const posted = await post(api, [finding('aa')]);
    expect(state.updated).toEqual([]);
    expect(state.reviews).toHaveLength(1);
    expect(posted.reviewComments[0]?.state).toBe('created');
  });

  it("never updates a reply or anyone else's comment, even one quoting the marker", async () => {
    const quoted = `> earlier\n${earlier(0, 99).body}`;
    const { api, state } = pullRequest(FILES, [
      earlier(7, 99, { author: 'octocat' }),
      earlier(8, 99, { inReplyTo: 6 }),
      earlier(9, 99, { body: quoted }),
    ]);
    const posted = await post(api, [finding('aa')]);
    expect(state.updated).toEqual([]);
    expect(state.reviews).toHaveLength(1);
    expect(posted.reviewComments[0]?.state).toBe('created');
  });

  it('posts a new review comment when GitHub refuses to update the earlier one', async () => {
    const { api, state } = pullRequest(FILES, [earlier(8, 99)]);
    api.updateReviewComment = async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    };
    const posted = await post(api, [finding('aa')]);
    expect(state.reviews).toHaveLength(1);
    expect(posted.reviewComments[0]?.state).toBe('created');
    expect(state.summaries).toHaveLength(1);
  });

  it('lets a failed GitHub call reject, for the caller to warn on', async () => {
    const { api } = pullRequest();
    api.createReview = async () => {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    };
    expect(postPullRequestComments(api, [finding('aa')], CONTEXT)).rejects.toThrow(
      'Resource not accessible by integration'
    );
  });
});

describe('comment bodies', () => {
  it('starts a review comment with the fingerprint and notifies nobody', () => {
    const body = reviewCommentBody(finding('aa'), {
      ...CONTEXT,
      issues: [
        {
          fingerprint: 'codex-security/v1:sha256:aa',
          title: 't',
          severity: 'medium',
          state: 'existing',
          url: 'https://x/issues/3',
        },
      ],
    });
    expect(body.split('\n')[0]).toBe(
      '<!-- cynos-scan-fingerprint: codex-security/v1:sha256:aa -->'
    );
    const visible = body.slice(0, body.indexOf('<details>'));
    expect(visible).toContain('**MEDIUM: Finding aa**');
    expect(visible).toContain('Tracked in https://x/issues/3.');
    expect(visible).not.toContain('@someone');
  });

  it('keeps root cause and remediation in the finding JSON under More details, not the message', () => {
    const body = reviewCommentBody(finding('aa'), CONTEXT);
    const visible = body.slice(0, body.indexOf('<details>'));
    expect(visible).not.toContain('Root cause');
    expect(visible).not.toContain('Remediation');
    expect(body).toContain('<details><summary>More details</summary>');
    expect(detailsJson(body)).toEqual(finding('aa'));
  });

  it('ends a review comment with the run and the commit only', () => {
    const body = reviewCommentBody(finding('aa'), CONTEXT);
    expect(
      body.endsWith(
        `</details>\n\n---\nFound by [cynos-scan](${CONTEXT.runUrl}) at commit \`${SHA.slice(0, 12)}\`.`
      )
    ).toBe(true);
    expect(body).not.toContain('model output');
  });

  it('escapes the backtick runs that could close the fence, keeping the JSON the same', () => {
    const fenced = {
      ...finding('aa'),
      remediation: 'Close it: ````\n</details>\n@someone',
      codeEvidence: [{ code: 'Name string `json:"name"` // ``' }],
    };
    const body = reviewCommentBody(fenced, CONTEXT);
    // One fence opens the JSON and one closes it: no line inside starts a fence.
    expect(body.split('\n').filter(line => line.startsWith('```'))).toEqual(['```json', '```']);
    expect(body).toContain('Close it: \\u0060\\u0060\\u0060\\u0060');
    expect(body).toContain('Name string `json:\\"name\\"` // ``');
    expect(detailsJson(body)).toEqual(fenced);
  });

  it('keeps the details of a finding with a very long backtick run', () => {
    const long = { ...finding('aa'), codeEvidence: [{ code: '`'.repeat(30_000) }] };
    const body = reviewCommentBody(long, CONTEXT);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('<details><summary>More details</summary>');
    expect(body).toContain('"remediation": "Use ast.literal_eval."');
  });

  it.each([
    ['an unclosed HTML block', 'Unclosed <pre>', '<!-- hides what follows\n<details>'],
    ['an unclosed backtick fence', 'Finding aa', 'Runs eval:\n```python\neval(x)'],
    ['an unclosed tilde fence', 'Finding aa', 'Runs eval:\n   ~~~python\neval(x)'],
  ])(
    'renders the prose as literals, so %s cannot run over the finding JSON',
    (_, title, summary) => {
      const open = { ...finding('aa'), title, summary, remediation: '--> </pre> ``` ~~~ @someone' };
      const body = reviewCommentBody(open, CONTEXT);
      const visible = body.slice(0, body.indexOf('<details><summary>More details'));
      const prose = visible.replace(/^<!-- cynos-scan-fingerprint: \S+ -->\n/, '');
      // Nothing in the prose can open a block: no raw HTML, no fence, no indent.
      expect(prose).not.toMatch(/[<`~]/);
      expect(prose.split('\n').some(line => /^\s/.test(line))).toBe(false);
      // The details, their one fence pair and the footer follow it as written.
      expect(body.split('\n').filter(line => /^ {0,3}(```|~~~)/.test(line))).toEqual([
        '```json',
        '```',
      ]);
      expect(detailsJson(body)).toEqual(open);
      expect(body).toMatch(/<\/details>\n\n---\nFound by \[cynos-scan\]/);
    }
  );

  it('keeps the prose readable as literals: characters as written, lines as written', () => {
    const body = reviewCommentBody(
      { ...finding('aa'), summary: 'Calls `List<String>.get` on *rules*\nfrom @someone' },
      CONTEXT
    );
    expect(body).toContain(
      'Calls &#96;List&lt;String&gt;.get&#96; on &#42;rules&#42;\nfrom &#64;\u200bsomeone'
    );
  });

  it('cuts a finding JSON over the comment limit, and says where the full finding is', () => {
    const huge = { ...finding('aa'), codeEvidence: [{ code: 'x'.repeat(100_000) }] };
    const uploaded = reviewCommentBody(huge, { ...CONTEXT, reportsArtifact: 'cynos-scan' });
    expect(uploaded.length).toBeLessThan(65_536);
    expect(uploaded).toContain(
      "Truncated to fit a GitHub comment: the full finding is in findings.json, in the run's `cynos-scan` artifact."
    );
    expect(uploaded).toContain('</details>');
    // Without an upload the reports are deleted at job end: no report to point at.
    const kept = reviewCommentBody(huge, CONTEXT);
    expect(kept.length).toBeLessThan(65_536);
    expect(kept).toContain('Set `upload-artifacts: true` to keep the full finding');
    expect(kept).not.toContain('findings.json');
  });

  it('fences a finding JSON with a million backtick runs', () => {
    const runs = { ...finding('aa'), codeEvidence: [{ code: '`a'.repeat(1_000_000) }] };
    const body = reviewCommentBody(runs, CONTEXT);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('\n```json\n');
  });

  it('leaves out More details when no room is left', () => {
    expect(findingDetails(finding('aa'), 10)).toBe('');
  });

  it('carries no marker for a fingerprint the marker cannot carry, and says when a scan is a mock', () => {
    const body = reviewCommentBody(
      { ...finding('aa'), fingerprints: { primary: 'has space -->' } },
      { ...CONTEXT, mock: true }
    );
    expect(body).not.toContain('cynos-scan-fingerprint');
    expect(body.startsWith('> **Mock scan:**')).toBe(true);
  });

  it('lists findings most severe first, with locations at the scanned commit', () => {
    const findings = [finding('aa', undefined, 'low'), finding('bb', undefined, 'critical')];
    const lines = commentableLines(FILES);
    const body = summaryCommentBody(
      findings,
      findings.map(item => anchorOf(item, lines)),
      [],
      CONTEXT
    );
    expect(body).toContain('**Findings:** critical: 1 · low: 1');
    expect(body.indexOf('Finding bb')).toBeLessThan(body.indexOf('Finding aa'));
    expect(body).toContain(
      `[\`functions/b.py:97\`](https://github.com/${REPOSITORY}/blob/${SHA}/functions/b.py#L97-L99)`
    );
    expect(body).toContain(`**Diff since:** \`${BASE.slice(0, 12)}\``);
  });

  it('counts the findings false-positives dismissed, which it does not list', () => {
    const body = summaryCommentBody([finding('aa')], [undefined], [], { ...CONTEXT, dismissed: 2 });
    expect(body).toContain('**Findings:** medium: 1 · **Dismissed in false-positives:** 2 ·');
    expect(summaryCommentBody([finding('aa')], [undefined], [], CONTEXT)).not.toContain(
      'Dismissed'
    );
  });

  it('encodes file names in links, keeping them as written in the label', () => {
    const odd = finding('aa', [{ path: 'src/parser#1 (old)?.ts', role: 'sink', startLine: 3 }]);
    const body = summaryCommentBody([odd], [undefined], [], CONTEXT);
    expect(body).toContain(
      `[\`src/parser#1 (old)?.ts:3\`](https://github.com/${REPOSITORY}/blob/${SHA}/src/parser%231%20%28old%29%3F.ts#L3)`
    );
  });

  it('links no line that is not a positive whole number', () => {
    const injected = finding('aa', [
      { path: 'a.py', role: 'sink', startLine: '3) [x](https://evil.example', endLine: 'x' },
    ]);
    const body = summaryCommentBody([injected], [undefined], [], CONTEXT);
    expect(body).toContain(`[\`a.py\`](https://github.com/${REPOSITORY}/blob/${SHA}/a.py)`);
    expect(body).not.toContain('evil.example');
  });

  it('escapes backslashes before table pipes and keeps escapes intact at the title limit', () => {
    for (const title of [
      String.raw`one\|two\\|three`,
      'x'.repeat(299) + '|tail',
      'x'.repeat(299) + '\\tail',
    ]) {
      const body = summaryCommentBody([{ ...finding('aa'), title }], [undefined], [], CONTEXT);
      const row = body.split('\n').find(line => line.startsWith('| medium |'))!;
      const encoded = row.split(' | ')[1]!;
      // Every pipe has an odd number of preceding backslashes; trailing backslashes are paired.
      for (const match of encoded.matchAll(/(\\*)\|/g)) {
        expect(match[1]!.length % 2).toBe(1);
      }
      expect((encoded.match(/\\+$/)?.[0].length ?? 0) % 2).toBe(0);
      expect(encoded.replace(/\\([\\|])/g, '$1')).toBe(title.slice(0, 300));
    }
  });

  it('caps the summary comment below GitHub limit', () => {
    const findings = Array.from({ length: 400 }, (_, index) => ({
      ...finding(String(index)),
      title: 'x'.repeat(300),
    }));
    const body = summaryCommentBody(
      findings,
      findings.map(() => undefined),
      [],
      CONTEXT
    );
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toMatch(/\d+ more findings are in the run's job summary and reports\./);
  });
});
