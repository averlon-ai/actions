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
  identity: { anchor: "app/routes/login.py", instance: "login-query" },
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

Do not add `findingId`, `occurrenceId` or `fingerprints`, and never try to compute them: the
workbench derives them from each finding's `ruleId` and `identity.anchor`.
