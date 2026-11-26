// @exec: {"yield_time_ms": 60000, "max_output_tokens": 90000}
const sh = (cmd, max = 60000) =>
  tools.exec_command({ cmd, yield_time_ms: 60000, max_output_tokens: max });
const [refs, kb] = await Promise.all([
  sh(
    `cd "$CODEX_SECURITY_PLUGIN_ROOT/references" && for f in scan-prologue.md scan-runtime.md access-advisory.md finding-detail-fields.md; do echo "=== $f ==="; cat "$f"; done`
  ),
  sh(
    `env | grep '^CODEX_SECURITY' | sort; echo "=== KNOWLEDGE BASE ==="; ls -1 "$CODEX_SECURITY_KNOWLEDGE_BASE"; cat "$CODEX_SECURITY_KNOWLEDGE_BASE"/*code-graph*; echo "=== BRIEFS ==="; ls -1 "{{KB_INDEX}}/packets"`
  ),
]);
text(refs.output);
text(kb.output);
