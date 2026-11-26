## Drafts and finishing

The scan's result is the drafts you submit with `record_codex_security_scan_draft`; helpers never
submit one. The workbench writes scan-manifest.json and findings.json from your accepted drafts.

- **Submitting.** Build `threatModel`, `findings` and `reviewState` as objects in JavaScript,
  pass them to the draft tool, and print its answer:

  ```js
  const r = await tools.mcp__codex_security__record_codex_security_scan_draft({
    scanId,
    complete: true,
    threatModel,
    findings,
    reviewState,
  });
  text(JSON.stringify(r));
  ```

  Leave out the fields the workbench derives (it rejects them with "expected never"), for example
  `reviewState.mode`, `reviewState.inventoryStrategy` and `reviewState.receiptRefs`.
- **The tool is the check.** It validates each draft against its schema
  (`"$CODEX_SECURITY_PLUGIN_ROOT/schemas/tools/scan-draft.schema.json"`) and either accepts it or
  lists every problem, so do not read the schema or example scans first. If it lists problems,
  look up each field it names in that schema, fix every listed item in one pass, in code, without
  dropping valid findings or evidence, and submit again; retry at most twice.
- **The review state** describes the code reviewed. Give every surface reviewed its final
  disposition: `reported`, `no_issue_found`, `rejected` (for example dead, unreachable or
  commented-out code, or a false positive) or `not_applicable`. Mark a surface `needs_follow_up`
  only when code in scope was not reviewed. Questions about how the application is deployed or
  configured at runtime are `openQuestions`, not surfaces: a static review cannot answer them, and
  they are not unfinished review. Use `deferred` for review in scope that was not finished and for
  an essential proof gap that could not be closed, never to park a finding.
- **Closing deferred tasks.** Close each task saved earlier in `reviewState.deferred` whose work is
  done. A task tied to a candidate is closed by a finding that carries that candidate's id
  (`provenance.candidateId`) or by a `rejected` surface for it; `reviewState.resolvedDeferred`
  cannot close it. List only the other finished tasks in `reviewState.resolvedDeferred`, with their
  id and a reason. Keep deferred, with its reason, whatever is genuinely unfinished: the report
  lists it as deferred work, and closing it would claim review that did not happen.
- **The manifest.** The workbench fills `status`, `startedAt`, `completedAt` and the other metadata
  itself: those values are expected, not a mistake to repair. Never hand-edit scan-manifest.json
  or findings.json; to change them, submit another draft.
- **Finishing.** A reply that contains no tool call ends your turn, and ending your turn finishes
  the scan: until the draft tool has accepted a `complete: true` draft, every reply makes a tool
  call (while a helper is still running, a `wait_agent` call). Ending your turn without an
  accepted `complete: true` draft fails the scan. The workbench wrote both canonical files when it
  accepted the draft: never list, read or edit them afterwards.
- **After the accepted draft.** An accepted `complete: true` draft finishes the scan. Submit again
  only if it leaves open a surface or task you did finish, and then only a whole draft that is
  `complete: true` again: the scan's completeness is its last draft's, so a `complete: false`
  draft after it fails the scan.
- **Findings already submitted.** The workbench keeps the findings of earlier drafts and matches a
  finding to its earlier version by its `ruleId`, `identity` and locations: a later draft that
  changes one of those adds a second finding instead of replacing the first, and a draft with
  fewer findings, or none, removes nothing. So keep those three as submitted, and never submit an
  empty or partial draft to start over. The one exception is an `identity` the evidence shows is
  wrong: correct it before the `complete: true` draft, never after, as "Historical findings and
  coverage" in `"$CODEX_SECURITY_PLUGIN_ROOT/references/final-report.md"` describes (a
  `complete: false` draft whose revision lists the earlier version in
  `provenance.previousFindings`).
