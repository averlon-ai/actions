## Code mode

`exec` is your only tool. Every other tool is a function on the global `tools` object, which you
call from the JavaScript you pass to `exec`; `store(key, value)` keeps a value across `exec` calls
and context checkpoints, and `load(key)` returns it.

- **Results.** One `exec` can run several tools; return every result you need with `text(...)`.
  A script that never calls `text(...)` returns nothing, even when its commands succeed.
- **Output budget.** Codex returns at most 10,000 tokens of an `exec` result unless the script's
  first line is a header such as `// @exec: {"yield_time_ms": 60000, "max_output_tokens": 60000}`;
  beyond that it keeps the start and the end and drops the middle (`Warning: truncated output`).
  `max_output_tokens` passed to `tools.exec_command` inside the script does not lift it. Start
  every `exec` that prints source, a document or a long list with that header.
- **Scan tools.** The codex-security tools are functions too:
  `tools.mcp__codex_security__<tool name>(...)`, for example
  `text(JSON.stringify(await tools.mcp__codex_security__record_codex_security_scan_draft({...})))`.
  They serve only the scan's owner, the lead's thread, and refuse a helper.
- **Environment.** The JavaScript has no `process` or `process.env`. Use environment variables
  inside the shell commands you pass to `tools.exec_command` (for example
  `cat "$CODEX_SECURITY_PLUGIN_ROOT/references/scan-runtime.md"`), never by echoing them into
  JavaScript first. There is no `tools.apply_patch`.
- **Short scripts.** Keep a script under about 10,000 characters, and build anything large (the
  findings of a result or a draft) across several calls: `store()` each part, then make one short
  call that `load()`s the parts. If an `exec` fails with a `SyntaxError` and the script shows up
  wrapped as `{"input": "..."}`, the call was damaged on its way to `exec`, not written wrong:
  sending it again fails the same way, so split it into smaller scripts.
- **Few, full replies.** Every reply costs close to a minute however little it does. Make each
  one do as much as it can, and make a tool call in every reply until your final answer.
- **Reading.** Read several files per command, each numbered from its own line 1, with the
  knowledge base's reader (`sh {{KB_INDEX}}/kb read a.py b.py:40-90`): several files or ranges per
  command, about 3,000 lines at most, in an `exec` with the header above. Never print several files
  with one `cat -n` (it numbers lines continuously across them, so every line cited from the second
  file on is wrong), never pipe the reader through `head` or `tail`, and never read a file twice.
  If a result says `Warning: truncated output`, read the missing part by range.
- **Searching.** Search with one `rg` call that carries every pattern (`rg -n -e A -e B -e C`),
  limited to product files. Skip vendored, minified, generated and lock files unless a finding
  depends on one.
- **Context checkpoints** ("CONTEXT CHECKPOINT COMPACTION"). What you keep in `store()` survives
  one; what you only read does not. Write only the summary: what you are doing, the scan id, and
  what you have stored and saved or submitted. Make no tool call in it and do not write a tool
  call as text. When continuing from a summary, an action counts as done only if its tool result
  is visible; otherwise do it again.

## The sandbox

- Only the scan directory is writable; `/tmp` and `$TMPDIR` are not. You need no scratch files:
  keep intermediate results in JavaScript and in `store()`.
- Never start a command that waits for input on stdin; it waits forever.
- The repository's dependencies are not installed. Reason about a library from the code that
  calls it and the version the repository declares; one look at the dependency metadata
  (requirements files, pyproject.toml, go.mod, lockfiles) is enough, and versions need no
  research. Never search the rest of the filesystem (the home directory, other projects, module
  caches) for library source or for anything else.
- Never read Codex session logs or the plugin's own scripts to work out how the scan is checked.
- A question you cannot settle in a few attempts is an open question: record it and move on,
  rather than repeating the same command.
