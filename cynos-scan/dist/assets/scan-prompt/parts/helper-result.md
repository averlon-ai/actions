## Your result

Your result is one JSON object: `findings` (each in the shape below), `resolved_questions` (what
you settled without a finding: uncertainty and control-based rejections, kept distinct from
vulnerabilities, and any question you leave open) and `fully_reviewed_files` (every file you read,
core included). Create no receipts or inventories.

**Save early, save whole.** Keep your whole result so far in `store('result', result)`, and save
it with the script below: as soon as you have your first findings, again after each batch that adds
findings, and at the end. It writes `artifacts/helpers/<your task name>.json` in the scan directory
(for example `artifacts/helpers/packet_auth.json`; never the brief id or another name), replacing
the file with the whole result so far, so a helper stopped by a budget or a limit keeps what it last
saved. The lead reads this file, not your final message.

Run the script as it is, with your task name in its second line. This file is the one you write,
and the script is how: the scan's tools refuse a helper (only the lead's thread owns the scan), and
the sandbox's read-only `/tmp` breaks a heredoc.

```js
{{SCRIPT save-helper-result.js}}
```

**End with a short final message**, after your last save: the artifact path, the number of
findings, and one line per finding (title, `path:line`, CWE). Do not repeat the findings' full
text in it.

{{INCLUDE finding-shape.md}}
