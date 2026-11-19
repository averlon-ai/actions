# Changelog

Changes to the cynos-scan action (named codex-security until the rename below), kept beside it
rather than in the repository's CHANGELOG.md, which records only that the action was added: it
was internal until its move below, and this file keeps its whole history in one place.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- New inputs `severity-rubric` and `false-positives`, repository-relative files: the rubric the scan grades severity by instead of upstream's default, and the findings your reviewers dismissed, each with a reason, its title and a location. The scan reads the dismissals as reviewer feedback and decides whether a new finding is one of them; a finding it still reports whose fingerprint a dismissal names gets no issue and no review comment, and the summary comment counts it (README: Severity rubric and false positives; engine 0.2.6).

- The action now scans a pull request on a comment request: an `issue_comment` on an open pull request from its repository's owner, a member or a collaborator. It fetches the pull request and scans and comments on it as on its `pull_request` event (no forks; the checkout must be its head), and never treats the run as the default branch's, though GitHub runs it there: no `last-scan` starting point, no threat model, no knowledge-base cache save. `examples/cynos-scan-pr.yml` now scans a pull request once when it opens or is marked ready for review, and again on a `cynos scan` comment, instead of on every push (README: Comment requests).

- The action now puts a pull request's findings on the pull request: on a `pull_request` diff scan that completes with findings, a summary comment listing them and a review comment on each finding's changed line, anchored at its most relevant location in the diff. A later push's scan updates a finding's review comment still on the same line, and posts a new summary. New input `pr-comments` (default `true`; needs `pull-requests: write`, and only warns without it), and a new example, `examples/cynos-scan-pr.yml`.
- The action now builds a knowledge base before every scan that calls the model (new required `openrouter-api-key`). A pinned codebase-memory-mcp and Jev on OpenRouter map entry points, sinks and attack paths, one model call designs the investigation packets, and the scan reads a briefing with read scripts instead of searching. A failed build fails the run. On ten RealVuln repositories the mean scan went from about 62 to 23 minutes.
- The action's scan prompt now starts every `exec` that prints source with an `// @exec` output-budget header (Codex otherwise returns 10,000 tokens and drops the middle), and forbid `cat -n` over several files, which numbered lines continuously and made cited lines wrong.

### Changed

- Update the public `@averlon-ai/cynos-scan-engine` dependency from 0.2.0 to 0.3.0, including helper result saving and finding identity fixes. The action inputs are unchanged.

- The action now installs its engine from npm as `@averlon-ai/cynos-scan-engine`, published publicly, instead of `@averlon-security/cynos-scan-engine` from GitHub Packages: building it needs no token, and the repository's workflows no longer grant `packages: read` for it. Callers see no change (engine 0.2.0).
- `examples/cynos-scan.yml` no longer opens the threat-model PR: its `threat-model` job (`operation: update-threat-model`) is gone, and the scan job no longer exports the `threat-model` output. The operation is unchanged; README: The threat model says how to add the job back.
- **BREAKING:** the action moves from `internal/cynos-scan` to `cynos-scan`, a public action of `averlon-ai/actions`: the public export no longer removes it. A calling workflow changes its `uses:` to `averlon-ai/actions/cynos-scan@<sha>` (or `averlon-security/actions/cynos-scan@<sha>`), pinned to a release tag's commit as before. Nothing else about the interface changes.
- A diff scan with no stored review in its history no longer fails: it reviews the whole repository at HEAD as a full scan does, reading `threat-model-path`, and saves that review in the pull request's own cache scope, so later pushes update it instead. Cached Jev answers cover the files the change left alone, but the review agent runs in full, so that first diff takes about as long as a full scan's knowledge base. The job summary says when a diff built its threat model (engine 0.2.8).
- A scan now restores the knowledge-base cache of the newest commit in its checkout's history before the repository's newest entry, so a pull request branched before the default branch's latest full scan updates an ancestor's review instead of building one. The action lists the cache entries for it (the Caches API), which needs `actions: read`; the examples grant it, and a listing that fails only logs why and restores as before (engine 0.2.8).

- A finding's review comment now shows its title and summary, and holds the finding's full JSON from `findings.json` (root cause, remediation, attack path, code evidence, confidence) under a collapsed **More details**, cut to fit GitHub's comment limit. Root cause and remediation are no longer in the message itself. The footer of review comments, summary comments and issues is now only `Found by cynos-scan at commit …` (an issue adds its rule): no model name, and no "Scanner findings are model output: confirm before fixing". The job summary no longer shows the model or the reasoning effort either.
- A scan that posts its findings on the pull request (`pr-comments`) no longer emits source annotations: GitHub drew each one on the same changed line as the finding's review comment, so every finding showed twice. A scan that posts nothing on the pull request keeps its annotations.
- **BREAKING:** the action is renamed from `codex-security` to `cynos-scan`, so that `codex-security` names only OpenAI's upstream package (`@openai/codex-security`) and its CLI. Every name the action owns changes, and none of the old ones is kept as an alias:

  | What                               | Was                                                     | Now                                             |
  | ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
  | Action path                        | `internal/codex-security`                               | `internal/cynos-scan`                           |
  | Package                            | `@averlon/codex-security-action`                        | `@averlon/cynos-scan-action`                    |
  | `artifact-name` default            | `codex-security`                                        | `cynos-scan`                                    |
  | `model` default                    | `deepseek/deepseek-v4.1-flash` in `action.yml`          | none: empty uses the engine's default model     |
  | Key in the step env                | `CODEX_API_KEY`, `OPENAI_API_KEY`                       | `CYNOS_API_KEY` first, then those two           |
  | Run titles (`run-name`)            | `codex-security: full\|diff\|mock`                      | `cynos-scan: full\|diff\|mock`                  |
  | Issue label                        | `codex-security`                                        | `cynos-scan`                                    |
  | Severity labels                    | `codex-security:<severity>`                             | `cynos-scan:<severity>`                         |
  | Issue title prefix                 | `[codex-security]`                                      | `[cynos-scan]`                                  |
  | Issue fingerprint marker           | `<!-- codex-security-fingerprint: … -->`                | `<!-- cynos-scan-fingerprint: … -->`            |
  | Threat-model branch                | `codex-security/threat-model`                           | `cynos-scan/threat-model`                       |
  | Threat-model commit and PR titles  | `codex-security: …`, `… the codex-security full scan`   | `cynos-scan: …`, `… the cynos-scan full scan`   |
  | Knowledge-base cache key prefix    | `codex-security-knowledge-base-v1-`                     | `cynos-scan-knowledge-base-v1-`                 |
  | Artifacts                          | `codex-security-threat-model`, `codex-security-covered` | `cynos-scan-threat-model`, `cynos-scan-covered` |
  | Job summary heading                | `Codex Security`                                        | `cynos-scan`                                    |
  | Example workflow                   | `examples/codex-security.yml`                           | `examples/cynos-scan.yml`                       |
  | Example environments               | `codex-security`, `codex-security-mock`                 | `cynos-scan`, `cynos-scan-mock`                 |
  | Example secret                     | `CYNOS_CODEX_SECURITY_API_KEY`                          | `CYNOS_API_KEY`                                 |
  | Example repository variable        | `CODEX_SECURITY_FILE_ISSUES`                            | `CYNOS_SCAN_FILE_ISSUES`                        |
  | Example concurrency group, step id | `codex-security`                                        | `cynos-scan`                                    |
  | Example SARIF category for a diff  | `codex-security-diff`                                   | `cynos-scan-diff`                               |

  The fingerprint value (`codex-security/v1:sha256:<hex>`) is upstream's and does not change. A repository already running the action must, when it moves to the new path, rename its workflow's `run-name` prefix to `cynos-scan:` (the action fails a run whose title does not match), its environments to `cynos-scan` and `cynos-scan-mock`, the environment secret to `CYNOS_API_KEY` and the `CODEX_SECURITY_FILE_ISSUES` variable to `CYNOS_SCAN_FILE_ISSUES`. Its first run then finds no earlier scan by run title or `cynos-scan-covered` artifact, so `diff-base: last-scan` runs a full scan; it files every finding again as a new issue, because existing issues carry the old label and marker (close the old ones or the new ones as duplicates); it opens a new threat-model PR from `cynos-scan/threat-model` (close the old PR and delete `codex-security/threat-model`); and it builds a new knowledge-base cache under the new key prefix.

- The action now runs its scans on `@averlon-security/cynos-scan-engine` (0.2.8), the engine moved out of this repository into `averlon-security/cynos-scan`, with no change for callers. Its new `runtime` input keeps `docker`, the scanner container, as the default; `native` is refused until the action installs upstream on the runner.
- The action's scan lead validates every helper finding against the source again, as upstream's scan does, and submits it or records its rejection with the evidence: self-only or privileged-only behavior with no boundary crossed is no longer reported, and no helper finding is dropped unseen. The prompt no longer requires low-severity findings such as missing login throttling or credentials written to stdout, and helpers now get upstream's shared worker instructions. Scans take longer: the validation adds lead work after the helpers finish (engine 0.1.3).
- The action's knowledge base now makes every model call through cynos with the cynos key: Jev's labels (now `typesafe/jev-1.14`) go through cynos's Decisions API instead of OpenRouter, and the $5 build cap counts Jev's tokens at cynos's rate (engine 0.1.4).
- The action's helpers now set severity by upstream's Finding Severity rules (impact and likelihood, downgrades for internal or constrained paths), which only the lead had; and a missing application-wide control (rate limiting, CSRF protection, cookie flags, security headers, CORS) is no longer reported without an attack path (engine 0.1.4).
- The action's diff scans now build a knowledge base for the change, as full scans do for the repository: the code graph at the checked-out commit, the paths through the changed functions, Jev's labels for them, the stored threat model brought up to date by the review agent when the change touches what it describes, and one brief per investigation packet. Upstream's `security-diff-scan` workflow runs with one helper per brief, all started at once. **BREAKING:** a diff now needs a stored full-scan review: without one the build fails and no scan starts (run a full scan first), and `threat-model-path` is no longer read by a diff (engine 0.2.3).
- The action gives upstream the scan's workflow as its own plugin (upstream's bundled plugin with the workflow files replaced), so the knowledge base's plan is the workflow the lead follows rather than user context it cannot override; upstream `@openai/codex-security` moves from 0.7.0 to 0.8.2 (engine 0.2.3).
- Upstream `@openai/codex-security` moves from 0.8.2 to 0.9.1 (Codex 0.165.0 to 0.167.0). 0.9.1 grades findings with a severity rubric it puts in the lead's task message; the action's scans use upstream's default rubric unless `severity-rubric` gives one (engine 0.2.5).
- A full scan's knowledge base now adds up to three hypothesis packets: questions computed before the scan from Jev's labels and the code graph, about state a request leaves behind when it stops part-way, each for one helper to settle either way. They start with the other packets. Jev's spend cap goes from $5 to $10 for the extra labels (engine 0.2.5).
- The action has one scan prompt, planned around the knowledge base, and runs full repository scans only for now: `scope: diff` and `paths` are refused until they have a plan of their own. The example workflow runs a weekly full scan instead of a daily diff and a monthly full scan.
- A scan with an empty `model` input now runs on DeepSeek V4 Pro (`deepseek/deepseek-v4-pro-0813`, a dated snapshot) instead of DeepSeek V4.1 Flash, at $1.30 / $2.60 per million input / output tokens against $0.14 / $0.42, so such a scan costs more. The knowledge base's architecture review and packet design stay on `deepseek/deepseek-v4.1-flash`, so its cost does not change. Set `model` to keep the old default (engine 0.2.7).

### Removed

- The action's `openrouter-api-key` input, and `OPENROUTER_API_KEY` in the step env: the knowledge base needs only the cynos key (engine 0.1.4). A workflow that still passes the input gets GitHub's unexpected-input warning; drop it and the `OPENROUTER_API_KEY` environment secret.

### Fixed

- A knowledge base on a repository whose code graph has 100,000 calls or more builds again: codebase-memory-mcp refuses a query result that large, and the build failed with no scan started; the code graph is now read in parts (engine 0.2.8).
- A diff that removes a large hunk (over 256 KiB, such as a regenerated document) has it labelled again: Jev's request was refused for size and the hunk went unlabelled; it is now sent in chunks (engine 0.2.8).
- An architecture review whose final answer is not valid JSON is asked for again, once, in the same session, instead of being dropped for the pack review (engine 0.2.8).

- No command the scan's model runs sees the cynos key: Codex 0.167.0 (upstream 0.9.1) stopped removing variables named `*KEY*`, `*SECRET*` and `*TOKEN*` from those commands' environment, so a lead that ran `env` printed the key into its session, which the evidence artifact uploads. The engine turns Codex's default excludes back on (engine 0.2.6; the action skips 0.2.5, which has upstream 0.9.1 without this fix).
- The action's completed scans pass reporting again: since v1.0.24 (upstream 0.8.2), upstream writes no `coverage.json`, but the action still required it, so every completed scan failed with `Scan completed, but required reporting failed.` after filing its issues and uploading its artifacts. The manifest and the findings are the required reports, as upstream's rules and the engine's say; `coverage-path` is empty.
- The action's scans start again: release v1.0.24's engine (0.2.3) looked for upstream's bundled plugin on the runner, where the action does not install upstream, and every scan that called the model failed with `@openai/codex-security is not installed`. The docker runtime now copies the plugin out of the scanner image, after checking the image's upstream is the pinned version (engine 0.2.4).
- The action leaves no cynos key on disk after a stopped scan, and the lead's index names exactly the files a scan does not review (engine 0.2.2).
- The action's key-leak check now reads the whole stage outside Codex's own state, so a key in the knowledge base or the architecture review's log, which the evidence artifact uploads, withholds the run's outputs; and the check before saving the knowledge-base cache reads the cache's files, which it never did (engine 0.1.3).
