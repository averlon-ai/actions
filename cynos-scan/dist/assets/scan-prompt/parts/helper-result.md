## Your result

Your result is one JSON object: `findings` (each in the shape below), `resolved_questions` (what
you settled without a finding: uncertainty and control-based rejections, kept distinct from
vulnerabilities, and any question you leave open) and `fully_reviewed_files` (every file you read,
core included). Create no receipts or inventories.

**Save early, save whole.** Save it at exactly `artifacts/helpers/<your task name>.json` (for
example `artifacts/helpers/packet_auth.json`; never the brief id or another name): as soon as you
have your first findings, again after each batch that adds findings, and at the end. Each save
replaces the file with the whole result so far, so a helper stopped by a budget or a limit keeps
what it last saved. The lead reads this file, not your final message.

```js
const r = await tools.mcp__codex_security__save_codex_security_artifact({
  scanId: '<scanId>',
  storage: 'persistent',
  path: 'artifacts/helpers/<task_name>.json',
  content: JSON.stringify(result),
});
text(JSON.stringify(r));
```

**End with a short final message**, after your last save: the artifact path, the number of
findings, and one line per finding (title, `path:line`, CWE). Do not repeat the findings' full
text in it.

{{INCLUDE finding-shape.md}}
