## How to fill the finding fields

A finding is written in the scan draft's own shape, from the helper's saved result to the
submitted draft, so nothing is converted on the way. Each needs a rule and title, its CWE,
severity and confidence with their rationale, the attacker, the violated invariant, the
source-to-sink or disclosure path, the concrete impact, repository-relative locations, source
evidence copied from the lines read, counterevidence, and remediation. For example (all values
are examples):

```js
{
  ruleId: "sql-injection-login-query", title: "SQL injection in login", summary: "...",
  identity: { anchor: "login-query-construction" },
  severity: { level: "high", rationale: "..." },          // critical|high|medium|low|informational
  confidence: { level: "high", rationale: "..." },        // high|medium|low
  taxonomy: { category: "injection", cwe: ["CWE-89"] },
  locations: [
    { path: "app/routes/login.py", startLine: 12, role: "entrypoint" },
    { path: "app/routes/login.py", startLine: 20, role: "sink" },
  ],
  codeEvidence: [{ id: "sink", label: "...", path: "app/routes/login.py", startLine: 20,
                   endLine: 21, role: "sink", code: "...", explanation: "..." }],
  rootCause: { summary: "...", evidenceRefs: ["sink"] },
  attackPath: { summary: "...", reachability: { attacker: "...", entrypoint: "...",
                outcome: "...", summary: "..." } },
  remediation: "...",
  provenance: { source: "local_plugin" },
}
```

`identity.anchor` names the root control the finding breaks (upstream's "semantic root-control
anchor"), never a file path or a code identifier: a lowercase slug of `a-z`, `0-9`, `.`, `_`, `/`
and `-` that starts with a letter or digit, so `password-reset-token-check`, not
`.github/workflows/ci.yml` or `UpdateProviderKey`. The paths go in `locations` and `codeEvidence`.
Give `identity.instance`, the same kind of slug, only to tell apart sibling findings that share a
`ruleId` and anchor.

Do not add `findingId`, `occurrenceId` or `fingerprints`, and never try to compute them: the
workbench derives them from each finding's `ruleId` and `identity`.
