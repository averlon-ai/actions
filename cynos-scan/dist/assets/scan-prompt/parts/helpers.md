## Starting and waiting for helpers

Every helper starts with an empty context: the message you start it with (`spawn_agent`'s
message, below "the helper's first message") is all it knows. It reads its instructions and its
brief from files, so its first message only says which brief is its own. Do not copy a helper's
instructions or its brief into it: writing them out again for each helper costs minutes per
helper.

- **Starting.** Call `spawn_agent` with `fork_turns: "none"` on every call, and the task name the
  index gives the helper. Without `fork_turns: "none"` the helper gets your whole conversation,
  your instructions to run the scan included, and tries to run the scan itself. If you are unsure
  of the tools' names, list them (`text(ALL_TOOLS.map((tool) => tool.name).join("\n"))`) and use
  the ones whose names contain `spawn_agent` and `wait_agent`.
- **The helper's first message** is this text, with the helper's brief id, task name and the
  scan id in place of `<brief id>`, `<task name>` and `<scanId>`:

  ```text
  Before anything else, make this ONE exec call; it prints your instructions (follow them in
  full), the scan's severity rubric and your brief, which ends with your core files. You are in
  code mode: the exec body is JavaScript, so write the exec exactly as these two lines. The first
  line must be the `// @exec:` header: without it Codex returns only 10,000 tokens of the result,
  the start and the end, and drops the middle (`max_output_tokens` inside the script does not lift
  that). A bare shell line is a syntax error.
    // @exec: {"yield_time_ms": 60000, "max_output_tokens": 100000}
    const r = await tools.exec_command({cmd: `cat {{HELPER_CONTEXT}} {{RUBRIC}} {{KB_INDEX}}/packets/<brief id>.md`, yield_time_ms: 60000, max_output_tokens: 100000}); text(r.output);
  You are a helper agent, not the scan lead. Your task name is <task name>; the scan id is <scanId>.
  ```

  Add to it, as further lines, the scan's rendered investigation time allowance when it has one
  (unchanged), and anything else this file gives for the helper.
- **A full worker pool.** If `spawn_agent` refuses a helper because every worker slot is in use,
  start it in the same response as the next `wait_agent` that returns a finished helper.
- **Waiting.** Call `wait_agent` with `timeout_ms: 300000`, only while a helper is still running:
  a helper is running until its final message has arrived, so count the final messages you have
  received against the helpers you started. Once every helper's final message has arrived, never
  call `wait_agent` again: it waits for a new message, and with no helper running it blocks until
  its timeout. If you are unsure whether a helper is still running, check it with
  `list_agents({path_prefix: "/root/<task name>"})` (a direct tool call, not one from inside
  `exec`); a running helper's entry is one short line.
- **Results.** A helper saves its result at `artifacts/helpers/<task name>.json` as it works and
  ends with a short final message. One that stopped with an error (a budget or a limit) keeps
  the result it last saved. One whose final message has arrived but whose file is missing saved
  it nowhere: take its findings from the JSON in its final message instead. To ask a finished
  helper a follow-up question, resume it with `followup_task`; `send_message` alone does not
  start a new turn.
