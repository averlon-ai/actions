// @exec: {"yield_time_ms": 60000, "max_output_tokens": 90000}
const scanId = '<scan id from the message that started this scan>';
const sh = (cmd, max = 60000) =>
  tools.exec_command({ cmd, yield_time_ms: 60000, max_output_tokens: max });
const [refs, kb, tm] = await Promise.all([
  sh(
    `cd "$CODEX_SECURITY_PLUGIN_ROOT" && for f in references/artifact-storage.md references/scan-runtime.md references/access-advisory.md references/security-guidance.md references/final-report.md skills/finding-discovery/SKILL.md skills/validation/SKILL.md skills/attack-path-analysis/SKILL.md; do echo "=== $f ==="; cat "$f"; done`
  ),
  // Read from the knowledge base's own directory, by name: upstream stages every knowledge base
  // side by side, where a pattern could match another's file.
  sh(
    `ls -1 "$CODEX_SECURITY_KNOWLEDGE_BASE"; cat "{{KNOWLEDGE_BASE}}/code-graph.md"; echo "=== BRIEFS ==="; ls -1 "{{KB_INDEX}}/packets"`
  ),
  sh(`cat "{{KNOWLEDGE_BASE}}/threat-model.json"`, 30000),
]);
text(refs.output);
text(kb.output);
// scan-runtime.md: the scan's progress advanced to its threat-model phase. Its access advisory
// is skipped: this scan runs on an API key alone, which access-advisory.md says to skip silently.
const progress = phase =>
  tools.mcp__codex_security__update_codex_security_scan_progress({ scanId, phase });
// The threat-model phase: the knowledge base's model, kept in a `complete: false` draft as the skill says.
await progress('threat_model');
const threatModel = JSON.parse(tm.output.slice(tm.output.indexOf('{'))).threatModel;
store('threatModel', threatModel);
const draft = await tools.mcp__codex_security__record_codex_security_scan_draft({
  scanId,
  complete: false,
  threatModel,
  findings: [],
  reviewState: { surfaces: [], explicitExclusions: [], deferred: [] },
});
text('DRAFT ' + JSON.stringify(draft).slice(0, 400));
const prepared = await tools.mcp__codex_security__prepare_codex_security_review_items({ scanId });
text('PREPARED ' + JSON.stringify(prepared).slice(0, 1000));
// Every page: a page's nextCursor is there only while more items follow.
const items = [];
let cursor;
do {
  const page = await tools.mcp__codex_security__list_codex_security_review_items({
    scanId,
    limit: 1000,
    ...(cursor ? { cursor } : {}),
  });
  const content = page.structuredContent || {};
  items.push(...(content.items || []));
  cursor = content.nextCursor;
} while (cursor);
store('reviewItems', items);
text(`ITEMS ${items.length}: ` + items.map(i => i.path).join(', '));
// Entering discovery: the context the progress update returns is the phase's own, for the helpers.
const entered = await progress('discovery');
const context = entered?.structuredContent?.scan?.userContext || '';
store('discoveryContext', context);
text('DISCOVERY CONTEXT ' + (context ? JSON.stringify(context) : '(none)'));
