# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-11-26

### Added

- `cynos-scan` reports each scan's start and finish to Cynos (scan telemetry): its status, each phase's duration, the knowledge-base cache's hit or miss, and on failure the failed phase and error kind. The repository is sent only as a hash, and no code or findings are sent. See the action's README (Telemetry).

### Changed

- Update the Cynos scan engine to `@averlon-ai/cynos-scan-engine@0.3.2`: a native scan no longer ends by asking to patch its findings, a scan that resubmits an accepted draft no longer fails at the end, and a scan no longer slows to a crawl on long runs of one character in a remote URL, a C file or a minified line.

### Fixed

- Release notes no longer publish the release job's GitHub token. The notes were the release step's `body:` input, which GitHub evaluates, so the installation example's `${{ secrets.GITHUB_TOKEN }}` became the job's token in the notes of v2.1.0 and v2.1.1 (it expired when its job ended). The notes are now written to a file and passed as `body_path`, which GitHub does not evaluate.

## [2.1.1] - 2026-11-19

### Changed

- Update the Cynos scan engine to `@averlon-ai/cynos-scan-engine@0.3.0`.

### Fixed

- Request remediation PR tickets after code-defect feedback is saved, so tickets include the defects their PR fixes.

## [2.1.0] - 2026-11-18

### Added

- Public `cynos-scan` action for code security scans, threat models, and findings reported as issues or PR comments.
- Terraform remediation with Claude in IaC Misconfiguration Analysis, plus `account-id` cloud discovery.
- Container base-image-only remediation and the `base-image-status` output.
- Optional Jira or Linear tickets for container remediation PRs.

### Changed

- **Breaking:** IaC Misconfiguration Analysis is now a composite action requiring Node.js 20+ on `PATH` and bash, including in the default Copilot mode. Claude mode supports Terraform only.
- Share Claude setup, validation, cleanup, and feedback between remediation actions; default to `claude-opus-5-5` (or `us.anthropic.claude-opus-5-5` on Bedrock).
- Register agent-created and analyzed PRs through `RegisterGitPullRequest`, with PR state and links from fixed code defects to remediation PRs. Requires an Averlon server that stores PRs separately from Git issues.
- **Breaking (shared API):** `registerGitPullRequest` returns the registered PR; remove unused Git issue/PR lookup and status helpers.
- Fail the action when the coding agent fails, while still submitting feedback and cleaning up.

### Fixed

- Read all pages of labeled open issues to avoid duplicate IaC and Kubernetes issues.
- Register remediation PRs using their GitHub titles.

## [2.0.8] - 2026-10-16

- bugfixes in container-analysis action
- label every container remediation PR, not only the first
- retry rate-limited Averlon API calls
- reject unsupported workflow triggers in container-analysis
- pull the MCP image first and keep skills out of PRs

## [2.0.7] - 2026-09-11

- support podman for container-analysis action
- support claude-via-bedrock for container-analysis action

## [2.0.6] - 2026-09-10

- support podman for container-analysis action
- support claude-via-bedrock for container-analysis action

## [2.0.5] - 2026-08-12

- handle expired anthropic key in container analysis
- handle merged PR's properly

## [2.0.4] - 2026-07-23

- Update the analysis for updated signature of backend
- update dependencies

## [2.0.2] - 2026-07-15

- Update to support Pulumi for IAC Misconfiguration Analysis
- Update other actions for simplified Averlon API calls

## [2.0.1] - 2026-03-30

- Major update to container analysis using composite actions to create PR

## [1.0.11] - 2026-02-18

- fix empty github issue creation

## [1.0.10] - 2026-02-18

- Update iac and k8s-analysis for better issue management
- Update iac analysis to handle multiple paths in same repo

## [1.0.9] - 2026-02-09

- Update pre-cog agent, iac and k8s-analysis for better issue management

## [1.0.8] - 2026-01-29

- Update k8s-analysis for external image

## [1.0.7] - 2026-01-24

- Update k8s-analysis for external image

## [1.0.6] - 2026-01-22

- add include-resources-without-issues option for iac-misconfig-analysis
- Update readme

## [1.0.5] - 2026-01-13

- add ignore-path option
- Update readme

## [1.0.4] - 2026-01-03

- replace api-key and api-secret with averlon-api-key and averlon-api-secret
- Update readme

## [1.0.3] - 2025-12-22

- Update readme for actions for more accurate information
- Update filters for container security

## [1.0.2] - 2025-12-18

- Update readme for actions to reflect the latest release version
- Update actions to create consitent github issue labels
- Update MCP documentation to specify missing server url
- Update K8S remediation agent to remove requiring yq and simplify manifest handling

## [1.0.1] - 2025-12-17

- Minor changes to readme and example workflows

## [1.0.0] - 2025-12-16

### Added

- Adding the first version of Averlon Github actions
