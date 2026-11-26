# cynos-scan

cynos-scan runs OpenAI's [`@openai/codex-security`](https://www.npmjs.com/package/@openai/codex-security)
scanner on the calling repository, with cynos (`https://api.cynos.averlon.ai/v1`) as the model
endpoint. Its interface is upstream's
[Codex Security GitHub Action](https://github.com/openai/codex-security/tree/main/github-action):
every upstream input and output, with the same names, defaults and meaning. On top of that it
builds a [knowledge base](#the-knowledge-base) the scan reads instead of searching, keeps a
threat model in a PR, and can file one GitHub issue per finding. It runs full repository scans and
[diff scans](#diff-scans) (the changes since the last scan); `paths` is refused.

## Use it in a repository

1. **Copy the workflow.** Copy [`examples/cynos-scan.yml`](examples/cynos-scan.yml) to
   `.github/workflows/cynos-scan.yml`, and replace `ACTION_REF` with the commit SHA of a release
   tag of this repository. Only release tags carry the built `dist/` (see
   [Releases](#releases)). Keep its `run-name`: the action fails a run whose title does not match
   the scan it runs.
2. **Create the `cynos-scan` environment.** Restrict it to the default branch, and give it the
   environment secret `CYNOS_API_KEY`: a cynos virtual key with its own budget, rate limit and
   model allow-list, and the only key a scan needs (the knowledge base calls
   through cynos too). The key's budget is the only cost limit: `max-cost` is not
   supported, because cynos may route a turn to another model. Create an empty `cynos-scan-mock` environment for
   mock runs.
3. **Optional:** the repository variable `CYNOS_SCAN_FILE_ISSUES=true` files GitHub issues for
   findings.
4. **Optional:** to scan pull requests, copy [`examples/cynos-scan-pr.yml`](examples/cynos-scan-pr.yml)
   too. It diffs a pull request against its merge base when it opens, and again on a
   [comment request](#comment-requests), and
   [comments the findings on the pull request](#pull-request-comments). Create its
   `cynos-scan-pr` environment with its own `CYNOS_API_KEY`, a key with its own budget, and let it
   deploy from the pull requests' branches and the default branch, where comment requests run.
   Anyone who can push a branch can then run a workflow that reads that key. The repository
   variable `CYNOS_SCAN_PR_MOCK=true` runs synthetic scans instead, in `cynos-scan-mock`, with no
   key. The example runs:

| Run title          | When                                  | What it scans                                                                                                          |
| ------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cynos-scan: diff` | daily at 03:00 UTC, or Run workflow   | the changes since the last scanned commit (`diff-base: last-scan`); the whole repository when there is no earlier scan |
| `cynos-scan: full` | Run workflow with `scope: repository` | the whole repository, refreshing the threat model the diffs reuse                                                      |
| `cynos-scan: mock` | Run workflow with `mock` set          | a synthetic scan                                                                                                       |

## Inputs and outputs

All 18 of upstream's inputs and outputs are accepted, with upstream's defaults, except `model`,
which has no default here (empty uses the engine's `DEFAULT_MODEL`, a cynos model), and
`artifact-name`, which defaults to `cynos-scan`. `src/__tests__/interface.test.ts` checks this
against upstream's `action.yml`. Upstream's validation rules apply too. The caller checks out the repository with
`persist-credentials: false`, as upstream requires.

Where an upstream input behaves differently here:

| Input                | Here                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`              | a cynos model id; empty uses the engine's default model                                                                                                                                     |
| `scope`, `diff-base` | `scope: diff` scans a diff: see [Diff scans](#diff-scans). `diff-base` is a revision, `last-scan`, or empty on a pull request (its merge base)                                              |
| `paths`              | not supported: a scan with `paths` is refused                                                                                                                                               |
| `max-cost`           | not supported: setting it fails the step. Cynos may serve a turn with another model than the one requested, so no estimate is a reliable stop threshold; the key's budget is the cost limit |

This action's own inputs:

| Input                | Default               |                                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`          | `scan`                | `scan`, or `update-threat-model` in a separate job with `contents: write` and `pull-requests: write`                                                                                                                                                                                                        |
| `cynos-api-key`      |                       | required unless `dry-run` or `mock`; without it, `CYNOS_API_KEY` in the step env, then upstream's `CODEX_API_KEY` or `OPENAI_API_KEY`                                                                                                                                                                       |
| `mock`               | `false`               | codex-security's synthetic scan: 12 fake findings, no key, no network in the scanner                                                                                                                                                                                                                        |
| `file-issues`        | `false`               | one issue per new finding of a completed scan; needs `issues: write`                                                                                                                                                                                                                                        |
| `threat-model-path`  | `docs/threatmodel.md` | written by `update-threat-model`                                                                                                                                                                                                                                                                            |
| `github-token`       | `github.token`        | run-history lookup, issues and the threat-model PR                                                                                                                                                                                                                                                          |
| `cynos-judge`        | `on`                  | `off` turns cynos's quality judge off for every scan turn                                                                                                                                                                                                                                                   |
| `cynos-task-routing` | `on`                  | `off` keeps every scan turn on the requested model                                                                                                                                                                                                                                                          |
| `upload-evidence`    | `auto`                | upload the knowledge base, helper briefs and checklists, helper results and the architecture review's log as `<artifact-name>-evidence`; `auto` only for a private repository (it holds unfixed findings)                                                                                                   |
| `runtime`            | `docker`              | where upstream runs: `docker`, upstream's hardened scanner container (see [What it guarantees](#what-it-guarantees)). `native` is [not yet supported](#the-runtime) and fails the step                                                                                                                      |
| `pr-comments`        | `true`                | on a pull request's diff scan (`pull_request`, or a [comment request](#comment-requests)) with findings, a summary comment and a review comment per finding on a changed line ([Pull request comments](#pull-request-comments)); needs `pull-requests: write`                                               |
| `severity-rubric`    |                       | a repository-relative Markdown file: the rubric the scan grades severity by, instead of upstream's [default](https://github.com/openai/codex-security/blob/main/plugins/codex-security/references/default-severity-rubric.md) ([Severity rubric and false positives](#severity-rubric-and-false-positives)) |
| `false-positives`    |                       | a repository-relative JSON file of the findings your reviewers dismissed, with why ([Severity rubric and false positives](#severity-rubric-and-false-positives))                                                                                                                                            |

This action's own outputs:

- `kind`: `repository`, `diff`, or `skip` (an empty diff);
- `threat-model`: `true` when a full scan of the default branch saved one for `update-threat-model`.

The default branch is the repository's, read from the event; its scans are the repository's
record. The `scan` job needs `contents: read`, plus `actions: read` for the run-title check and the knowledge-base cache's entries, `issues: write` for
`file-issues`, and `pull-requests: write` for `pr-comments` on a pull request. To upload to code scanning, add `security-events: write` and a
`github/codeql-action/upload-sarif` step on `sarif-upload-ready == 'true'`, as upstream documents;
it needs GitHub Code Security on a private repository.

## The runtime

The engine runs upstream on one of two runtimes: `docker`, upstream in its hardened scanner
container, and `native`, upstream on the host under Codex's own sandbox, as `codex-security` runs
on a laptop. The action runs `docker`, and everything below describes it. `runtime: native` is
refused before any scan starts: the native runtime runs the pinned `@openai/codex-security` and
Codex's platform binary from `node_modules` beside the running script, and a release's `dist/`
is bundled scripts and assets only, with nothing installed beside them on the runner.

## What it guarantees

- **Upstream, unmodified.** The image installs `@openai/codex-security@0.2.0` from npm and checks the
  tarball's sha256 before installing it. Everything the action customizes is stock Codex
  configuration passed with `--codex`. The endpoint is `model_provider` plus a
  `model_providers.cynos` table whose one HTTP header, `x-cy-eh-domain-expert-judge: on`, turns
  cynos's quality judge on for every turn. cynos judges a turn on its own only when it routes the
  turn to another model, and most scan turns stay on the requested one. No other override reaches
  cynos (no `x-bf-*`, no routing header, never the judge off), and a test checks this. The
  session settings are in the engine's `src/constants.ts`. Among them, Codex is given the scan
  model's 1M-token context window through a model catalog: Codex caps `model_context_window` at 272k for a model it
  has no metadata for, so the catalog is that fallback metadata with the real window and Codex's
  own base instructions (vendored as `codex-base-instructions.md`). Codex compacts a session at
  800k tokens, which keeps most compaction requests within the quality judge's context window
  (qwen3.8-27b, 1M tokens; the judge's input runs up to 1.23 times the turn). It compacts with a
  prompt that forbids tool calls and has the summary restate the agent's role and assigned task: a
  helper's task message does not survive compaction, so the summary is its only copy.
- **The keys stay out of the output.** The cynos key reaches the scanner container by name only
  (`docker run -e NAME`), never in argv, logs or artifacts; the knowledge base's calls with it
  stay in the action's own process. The outputs are checked for it before
  anything is published; if it is found, no report, annotation, finding or report path is
  published, and it is removed from the job summary. Codex's state, whose session transcripts can
  hold credentials, is never uploaded and is deleted when the step ends, with everything else the
  action staged except the validated reports; the post step deletes those once the job's steps are
  done. Fork pull requests are refused, and the scheduled example has no `pull_request`
  trigger at all; the pull request example runs on `pull_request`, never `pull_request_target`,
  and on `issue_comment` only for a [comment request](#comment-requests), whose run, though it
  holds the secrets, scans no fork's code and only for those who can push.
- **Read-only input.** The scanner reads the caller's checkout, mounted read-only, as upstream's
  action scans its checkout. Upstream's checks on the checkout run first: it must be at
  `GITHUB_SHA`, have no local changes, and keep no Git credentials. Nothing the scanner writes
  reaches the checkout.
- **Sandbox on.** Codex's Bubblewrap sandbox runs under upstream's own Docker hardening:
  `--cap-drop ALL`, no-new-privileges, the seccomp profile and, on Ubuntu 24.04, the AppArmor
  profile. Before any model call, the action checks:
  - that the sandbox starts;
  - that the scan itself, run with no network and a placeholder key, gets through preparation;
  - that cynos accepts the key, with one 16-token request.

  codex-security would otherwise report every one of those failures as "cannot access the
  configured model".

The scanner's reports are read as upstream's action reads them, because they are written by a
model-driven process beside Codex's state, which holds full transcripts. Each report is read only
as a regular file with one link, reached through no symlink, and copied to a directory the action
owns. Every finding's annotated location and every SARIF source reference must be a safe
repository-relative path. Everything the action publishes comes from those copies, and the
`*-path` outputs point at them.

The outcome follows upstream's rules. A scan is `completed` only when upstream's manifest says
completed, it reported no warnings, it exited 0 or 1, its findings are valid and the scanned
revision matches the checkout; `failed` otherwise. A scan upstream stopped short fails, but its
available results were kept: like upstream, the action still publishes its findings, as
provisional, when they are valid and of the checkout's revision. Only a completed scan files
issues, saves a threat model or sets `sarif-upload-ready`. With `upload-artifacts`, the reports
are uploaded when they are published, and the action's records (`run.json`, `versions.json`,
`issues.json`) whatever the outcome, unless the key leak check finds the key.

## Why the seccomp and AppArmor profiles

`codex-security-seccomp.json` and `codex-security.apparmor` are upstream's, from
`openai/codex-security` `docker/` at tag `npm-v0.2.0`, byte for byte. The action checks their
sha256 before every run and refuses a modified copy. Upstream ships them for the same reason this
action needs them: Codex runs every command the model asks for inside a Bubblewrap sandbox, and
Bubblewrap needs new user and mount namespaces, which a Docker container is normally refused.

- **Seccomp.** Docker's default profile allows `unshare`, `clone` with namespace flags, `mount`,
  `pivot_root` and `setns` only to a container with `CAP_SYS_ADMIN`, and the scanner runs with
  `--cap-drop ALL`. Upstream's profile is still deny-by-default, an allowlist of 389 syscalls, and
  adds exactly those that Bubblewrap needs to build its sandbox without any capability.
- **AppArmor.** Ubuntu 23.10 and later, including the `ubuntu-24.04` runner, block unprivileged
  user namespaces through AppArmor, and Docker's own `docker-default` profile does not grant them.
  Upstream's `codex-security-container` profile keeps `docker-default`'s write denials on `/proc`
  and `/sys` (see `codex-security.apparmor` for the exact patterns), and denies
  `/proc/sysrq-trigger`, `/proc/kcore`, `/sys/firmware`, `/sys/devices/virtual/powercap` and
  `/sys/kernel/security` entirely. It adds `userns`, `mount`, `umount` and
  `pivot_root`. It applies to this container only: no host-wide sysctl
  change, and no `apparmor=unconfined`. The action loads it with `sudo apparmor_parser` when
  Docker uses AppArmor, and skips it on hosts that don't.

Without them, Bubblewrap cannot start, and codex-security reports the failure as "cannot access
the configured model". The action's preflight runs upstream's own sandbox check
(`codex sandbox /usr/bin/true`) first and fails with the real reason before any model call.

## Diff scans

A diff scan reviews the changes between a base and the checked-out commit:

- **Schedule.** The example runs once a day with `diff-base: last-scan`: the diff from the last
  commit a successful full or diff run on the default branch covered, found from the run titles
  and the `cynos-scan-covered` artifact. An empty diff is skipped; with no earlier scan,
  `last-scan` runs a full scan. A manual run can name another revision, or run a full scan
  (`scope: repository`) to refresh the threat model.
- **Pull requests.** [`examples/cynos-scan-pr.yml`](examples/cynos-scan-pr.yml) scans a pull
  request when it opens or is marked ready for review, and again on a
  [comment request](#comment-requests), not on every push: the diff from its merge base (empty
  `diff-base`), with the findings [on the pull request](#pull-request-comments). Its scans never mark a commit as scanned for
  `last-scan`, which reads only the default branch.
- **Knowledge base.** A diff builds one for the change before the scan, as a full scan does for
  the repository: the code graph indexed at the checked-out commit, the paths through the changed
  functions (callers up to entry points, callees down to sinks), Jev's labels for them, the
  threat model, and one brief per investigation packet, plus a `diff_baseline` brief for changed
  files outside the product code (CI, Docker, configuration, documentation, tests).
- **Workflow.** Upstream's own `security-diff-scan` skill runs the diff, phase by phase: threat
  model, review items, discovery, validation, attack paths, report. The engine gives upstream its
  own plugin with that skill's file replaced by one written for a scan with a knowledge base, so
  discovery is one helper per brief, all started at once, rather than workers the lead splits off
  after reading the code itself (the engine's `assets/scan-prompt/`).
- **Threat model.** Every full scan stores its architecture review in the knowledge-base cache. A
  diff restores the cache (its base commit's entry first, then the newest entry of a commit in its
  history, then the newest), checks the review's citations against the checkout (a citation of a
  file or line that no longer exists is cut) and redacts secrets. When the change touches what the
  review describes (a file it cites, a file with an architecture role, or an entry point, sink or
  access control added or removed), the review agent brings it up to date for the change;
  otherwise it is used unchanged, and the diff saves nothing. With no stored review in its
  history (no full scan yet, its cache evicted, or only a full scan newer than the branch), the
  diff reviews the whole repository at HEAD as a full scan does, reading `threat-model-path`, and
  saves that review in the pull request's own cache scope, so later pushes update it instead.
  Cached Jev answers cover the files the change left alone, but the review agent runs in full, so
  that first diff takes about as long as a full scan's knowledge base. Listing the cache entries
  needs `actions: read`.
- **History.** Check out with `fetch-depth: 0`.
- **Code scanning.** Upload a diff's SARIF under its own category (for example
  `cynos-scan-diff`), never the full scan's: code scanning closes the alerts of a category that
  a newer upload on the same ref no longer reports.

## The threat model

A full scan of the default branch saves its regenerated threat model. `update-threat-model` then opens or
updates **one** PR, from branch `cynos-scan/threat-model`, that writes it to
`threat-model-path`, with trailing whitespace and final newlines normalised. Expect its wording to
change every time even when nothing important changed, because an LLM writes it fresh and cites
`path:line`. Merge it when what it describes is right, close it otherwise.

The example workflows do not open it. To, add a job to `examples/cynos-scan.yml` that needs the
scan job and runs when its `threat-model` output is `'true'`, with `contents: write` and
`pull-requests: write`: an `actions/checkout` with `persist-credentials: false`, then this action
with `operation: update-threat-model`.

`update-threat-model` runs only on the default branch, on a checkout at the scanned commit with nothing
staged, and refuses a `threat-model-path` through a symlink, so the branch it force-pushes is that
commit plus one commit that changes only the threat model. It runs Git with hooks off and pushes to
the repository's own URL, with the token as a header for that origin only.

GitHub doesn't start other workflows for a PR opened by GitHub Actions, so close and reopen it to run
required checks.

## Severity rubric and false positives

Two files in the repository steer what a scan reports. Both are read from the checkout, refused
when missing or reached through a symlink, and checked by the engine before the scan starts: a
file it cannot use fails the step with no model cost.

- **`severity-rubric`**: a Markdown file that replaces upstream's [default severity rubric](https://github.com/openai/codex-security/blob/main/plugins/codex-security/references/default-severity-rubric.md). The
  scan's lead and every helper grade findings by it.
- **`false-positives`**: a JSON array of the findings your reviewers dismissed. Each entry needs a
  `reason` (up to 2,400 characters), the finding's `title` and at least one location; the
  `fingerprint` (`fingerprints.primary` in `findings.json`, the value in an issue's marker) is
  optional:

  ```json
  [
    {
      "reason": "Only an administrator can reach this endpoint, and administrators can run SQL anyway.",
      "title": "SQL injection in report export",
      "locations": [{ "path": "app/reports.py", "startLine": 42 }],
      "fingerprint": "codex-security/v1:sha256:…"
    }
  ]
  ```

  The scan reads them as reviewer feedback, as upstream's own scan reads dismissals made with
  `codex-security findings false-positive`, and decides whether a new finding is one of them by
  its title and location. A finding the scan still reports whose fingerprint an entry names gets no
  issue (`file-issues`) and no review comment (`pr-comments`); the summary comment counts it as
  dismissed, and the reports and the SARIF keep it.

On a pull request, both files come from the pull request's checkout, so a pull request that edits
them changes how its own scan grades and dismisses findings. Give them a code owner who reviews
every change to them.

## GitHub issues and duplicates

With `file-issues`, every completed scan files one issue per finding, labeled `cynos-scan` and
`cynos-scan:<severity>`, titled `[cynos-scan] <finding title>`.

- **No duplicates.** Each issue carries codex-security's fingerprint (`fingerprints.primary`, the
  `codexSecurity/v1` value in SARIF) in a hidden marker (`<!-- cynos-scan-fingerprint: … -->`), and a finding that already has an issue,
  open or closed, is skipped.
- **Close what isn't real:** a closed issue is never filed again. To tell later scans why a
  finding is not real, add it to [`false-positives`](#severity-rubric-and-false-positives).
- **Issues are never closed automatically.**
- **No pings:** `@mentions` in the model-written text are broken, so nobody is notified.

A finding keeps its issue as long as codex-security gives it the same fingerprint. If a later scan
describes the same weakness differently, it files a second issue: close that one as a duplicate.

## Pull request comments

A diff scan of a pull request (`pr-comments`, on by default) that completes with findings puts
them on the pull request:

- **A summary comment** lists every finding, most severe first, with its location at the scanned
  commit and its review comment. Every scan posts a new one.
- **A review comment per finding**, on the line of the pull request's diff it points at, with the
  title, summary, and the finding's issue when `file-issues` filed one. Under **More details** it
  holds the finding's full JSON from `findings.json` (root cause, remediation, attack path, code
  evidence, confidence), cut to fit GitHub's comment limit; with `upload-artifacts`, a cut
  finding's note names the reports artifact that holds it whole. The new review comments of one scan
  come as one review, so one notification.
- **Only changed lines.** GitHub takes a review comment only on a line of the diff (an added or a
  context line), so a finding is anchored at its first location, most relevant first (root
  control, sink, source, entry point), on such a line. A finding with no location in the diff is
  only in the summary comment, marked _not on a changed line_.
- **Updated, not duplicated.** Each review comment carries the finding's fingerprint in the same
  hidden marker as its issue. When a later push's scan finds it again, the earlier review comment
  is updated if GitHub still shows it on the same line; otherwise (the line moved, or the comment
  is outdated) the finding gets a new review comment. Only a top-level review comment the
  action's token posted, starting with the marker, is ever updated: a reply or anyone else's
  comment is left alone, even when it quotes a marker.
- **Only the head's scan.** A scan whose commit is no longer the pull request's head (another
  push landed during the scan, or an older run was re-run) posts nothing: its lines would not
  match the pull request's diff. The newer commit's scan reports on it.
- **No annotations.** A scan that posts its findings on the pull request emits no source
  annotations: GitHub would draw each one on the same changed line as the finding's review
  comment. A scan that posts nothing (no findings, a stale scan, or a failure) keeps them.
- **Never deleted.** A finding a later scan does not report keeps its comments: one scan missing a
  finding is not evidence that it was fixed. Resolve the conversation instead.
- **Not on failure.** A partial or failed scan, a scan whose reports were withheld (the key was
  found in them), or a scan with no findings posts nothing. A mock scan posts, marked as
  synthetic, to test the workflow without a key. A job without `pull-requests: write` gets a
  warning, and the scan's result stands.

## Comment requests

A workflow can scan a pull request once, when it opens, and again only when someone asks, rather
than on every push: [`examples/cynos-scan-pr.yml`](examples/cynos-scan-pr.yml) runs on
`pull_request` (`opened`, `ready_for_review`) and on `issue_comment`, scanning on a comment that
reads `cynos scan`. The action takes such an `issue_comment` as a **comment request**, a scan of
that pull request, exactly as its own `pull_request` event would scan it:

- **Who and where.** The comment must be on an open pull request, from the repository's owner, a
  member of its organization or a collaborator (`author_association`): its run holds the
  workflow's secrets, so anyone else's comment would spend the key. Which comments ask for a scan
  is the workflow's choice; the action checks who asked, and where.
- **The same pull request checks.** The comment's payload names the pull request only by number,
  so the action fetches it and refuses a fork's, as on `pull_request`. The checkout must be its
  head commit: the example checks out `refs/pull/<number>/head`, and a push that lands between the
  checkout and the action's fetch fails the run (comment again).
- **Never the default branch's record.** GitHub runs every `issue_comment` workflow on the
  default branch, with `GITHUB_REF` naming it, but a comment request scans a pull request. It is
  never a `last-scan` starting point, never stores the threat model, and saves nothing to the
  knowledge-base cache (whose entries it would scope to the default branch); it still restores
  from it.
- **Not a check.** A comment request's run is not on the pull request's checks (GitHub attaches
  it to the default branch). The example reacts to the comment with 👀 when the scan starts, and
  the summary comment links the run. Do not make the pull request scan a required check: with no
  scan on push, it would wait on every later commit.

## Telemetry

A scan that calls the model reports its start and its finish to cynos, with the same key as the
scan, so that a scan that fails or slows down is noticed without you reporting it. A report holds:

- the run's outcome (completed, failed or cancelled) and duration;
- the scan kind (full or diff), the runtime and the action's version;
- each phase's status and duration, and whether the knowledge-base cache was a hit, a miss or
  failed;
- the number of changed (diff) or product (full) files;
- on failure, the phase that failed, the kind of error and its message, with keys, the checkout's
  path and other secrets removed.

The repository is identified only by a hash of `<host>/<owner>/<repo>`. No code, findings or file
names are sent. A mock scan or `dry-run` sends nothing.

## Limits

| Limit                 | Where            | What happens                                                   |
| --------------------- | ---------------- | -------------------------------------------------------------- |
| job `timeout-minutes` | GitHub           | the job is cancelled; the action's post step kills the scanner |
| cynos key budget      | cynos governance | requests refused; the scan fails                               |

As with upstream's action, the scan has no time limit of its own: the job's `timeout-minutes` is
the caller's limit, at most 6 hours on a GitHub-hosted runner. `max-time-hours` is upstream's
deep-scan discovery duration, passed to the CLI. When the job is cancelled, the action stops the
scanner and the scan fails; whatever it wrote is published only if the step gets that far before
the runner ends it, and the post step deletes the rest. The cynos key's budget is the only cost
limit.

The `estimated-cost` output is the CLI's own estimate, as with upstream's action. The CLI prices
no cynos model id, so it is normally empty, which upstream defines as unavailable, not zero. The
job summary still reports the tokens Codex recorded, and the cynos key's usage is the bill.

## Why not upstream's GitHub Action

[`openai/codex-security`](https://github.com/openai/codex-security/tree/main/github-action) ships an
Action, but it can't target cynos without patching it:

- It always runs `--provider openai` with the key passed as `OPENAI_API_KEY`.
- It builds the scanner's environment from scratch, so no endpoint or project-config override can
  reach it.
- It has no released `action-v*` tag yet.

This action keeps its interface, so a workflow can move to it unchanged once it accepts a custom
provider.

## Releases

`dist/` is not committed on branches. The release workflow builds every action and commits `dist/` into the release tag, so pin the action to the commit a release
tag points to. `bun run build` builds it locally, with bun 1.3 or later as CI uses: an older bun
leaves the engine's `import.meta.url` in `dist/main.js`, and Node then loads it as an ES module,
which fails.

The engine, `@averlon-ai/cynos-scan-engine`, is pinned to an exact version in
`package.json` and bundled into `dist/`, so the action's users need no registry access. It is
published publicly on npm, so installing it needs no token.

The build leaves out the engine's `assets/image.json` (`assets-exclude`), so the action builds the
scanner image on the runner from the engine's Dockerfile. The engine release also provides a
public prebuilt image, but this action does not include that image pin.

## The knowledge base

A full scan otherwise spends most of its turns finding and reading code: helpers list, search and
read in small pieces, the lead maps the repository before it starts any helper, and on a larger
repository the scan reads only part of the code. So every scan first does that work once, in the
action's own process (the engine's `src/knowledge-base/`):

1. **Code graph and labels.** codebase-memory-mcp (a pinned release, checked by sha256 in the
   Dockerfile) indexes functions and calls, in a container of the scanner image with no network
   and the checkout read-only. Jev (`typesafe/jev-1.14`, through cynos's Decisions API) answers fixed
   questions about every function and file: entry point, sink, whether an attacker's path runs
   through it, and, for every text file, whether it holds a secret.
2. **Architecture review.** A Codex agent (through cynos, router and judge off) reviews the
   architecture from a core of evidence chosen by each file's architecture role, loading the rest on
   demand, and writes the threat model the scan submits; its citations are checked against what it
   read. It is stored in the cache for later [diff scans](#diff-scans).
3. **Packets.** One strong-model call (through cynos) designs up to 8 investigation packets from
   the threat model and a digest of the labels; Jev asks of every product file, packet by packet,
   whether it belongs, so a file can be in several packets. Files on an attacker's path go to one
   baseline auditor.
4. **Output.** A short index for the lead and, for each helper, a brief: its core files with their
   own line numbers, a map of its other files, entry-point-to-sink chains and the whole threat
   model, with a reader (`kb`) that loads any other file on demand.

The scan's workflow (the engine's `assets/scan-prompt/`) then starts every helper in its first
two replies, one per packet and the baseline auditor, and merges their saved results without
re-reviewing them. On ten RealVuln repositories this cut the mean scan from about 62 to 23 minutes
and raised the mean F3 from 60.2 to 66.9, at a similar cynos cost; the knowledge base itself costs
cents of Jev per repository.

Mock and dry-run scans make no model call and build none. A diff builds its own, sized to the
change (see [Diff scans](#diff-scans)). A failed build fails the run: the scan's workflow is
planned around the knowledge base. Every model call it makes goes through cynos with the cynos
key, like the scan's own, and a build stops once it has spent $5 on Jev.

## Files

The scan itself (runtimes, image, hardening, knowledge base, prompt, reports) is the engine,
`@averlon-ai/cynos-scan-engine` from
[`averlon-ai/cynos-scan`](https://github.com/averlon-ai/cynos-scan) (`packages/engine`),
which the cynos-scan CLI and the benchmarks run too; this directory keeps what is GitHub's. The
build copies the engine's `assets/` into `dist/assets`, so a release's `dist/` holds everything
the action and the benchmark CLI run.

| File                                                      | What it is                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `action.yml`                                              | The interface: upstream's inputs and outputs, then this action's                      |
| `src/main.ts`                                             | The steps of a run, in order; `src/post.ts` kills the scanner if the job is cancelled |
| `src/inputs.ts`, `src/target.ts`                          | Upstream's input validation and checkout checks                                       |
| `src/last-scanned.ts`                                     | The run-title check and `diff-base: last-scan`                                        |
| `src/ci-cache.ts`                                         | The knowledge-base cache, carried between runs in the Actions cache                   |
| `src/issues.ts`, `src/threat-model.ts`                    | GitHub issues and the threat-model PR                                                 |
| `src/false-positives.ts`                                  | The dismissed fingerprints that get no issue or review comment                        |
| `src/reporting.ts`, `src/artifacts.ts`, `src/evidence.ts` | Job summary, annotations, artifacts and the run's evidence                            |
| `src/bench.ts`                                            | `dist/bench.js`, the engine's benchmark CLI                                           |
| `examples/cynos-scan.yml`                                 | The calling workflow to copy                                                          |
| the engine's `src/pipeline.ts`                            | `scanCheckout`: steps 3 to 7 of a run (see the engine's README for its other files)   |
| the engine's `assets/`                                    | The Dockerfile, entrypoint, profiles, base instructions and scan prompt               |

Run the tests with `bun test cynos-scan` (bun 1.3 or later, as CI uses); the
engine's tests are in its own repository.

## Upgrading codex-security

Upstream's pins live in the engine. Change all of these together there, then move this action to
the engine version that carries them:

- `CODEX_SECURITY_VERSION` and `CODEX_SECURITY_SHA256` in the engine's `assets/Dockerfile`. Get the hash by running
  `npm pack @openai/codex-security@<v>`, then `sha256sum` on the tarball.
- Both profiles in the engine's `assets/`, from `openai/codex-security` `docker/` at tag `npm-v<v>`.
- `PROFILE_SHA256` and `IMAGE` in the engine's `src/constants.ts`.
- `assets/codex-base-instructions.md` and `BASE_INSTRUCTIONS_SHA256`, if the new version pins
  another Codex: `codex-rs/models-manager/prompt.md` at that Codex's `rust-v<v>` tag. Check that
  `modelCatalog` in the engine's `src/scan-command.ts` still matches that Codex's `model_info_from_slug`.

Then check that `CODEX_BIN` in the engine's `src/constants.ts` still matches upstream's
`docker/verify-container-sandbox.sh`. Here, update `UPSTREAM_INPUTS` in `src/inputs.ts` and the
output list in `src/__tests__/interface.test.ts` if upstream's `action.yml` changed, and run a mock
scan before a real one.
