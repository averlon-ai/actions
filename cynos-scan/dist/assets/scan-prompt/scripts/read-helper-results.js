// @exec: {"yield_time_ms": 60000, "max_output_tokens": 4000}
const dir = '{{SCAN_DIR}}/artifacts/helpers';
const files = (await tools.exec_command({ cmd: `ls -1 ${dir}`, max_output_tokens: 2000 })).output
  .split('\n')
  .map(s => s.trim())
  // Only task names (lowercase, digits, _): a saved file's name goes into the cat below.
  .filter(s => /^[a-z0-9_]+\.json$/.test(s));
// A helper saves its whole result so far as it works and again at the end, so every result is read
// again each time: one read while its helper ran grows later. Only a result that changed is stored
// again and printed.
const names = new Set(load('helper_names') || []);
for (const file of files) {
  const n = file.replace(/\.json$/, '');
  const raw = (await tools.exec_command({ cmd: `cat ${dir}/${file}`, max_output_tokens: 100000 }))
    .output;
  try {
    const h = JSON.parse(raw);
    if (names.has(n) && JSON.stringify(load('helper_' + n)) === JSON.stringify(h)) continue;
    store('helper_' + n, h);
    names.add(n);
    text(
      `${n}: findings=${(h.findings || []).length} reviewed=${(h.fully_reviewed_files || []).length}`
    );
  } catch (e) {
    text(`${n}: not JSON (${String(e).slice(0, 80)})`);
  }
}
store('helper_names', [...names]);
// Files reviewed so far across every stored helper, for the progress line. A diff stored its review
// items: helpers also read supporting files, which are no review item and must not count past
// filesTotal. A full scan stored none, and counts every file.
const items = load('reviewItems');
const inScope = items ? new Set(items.map(i => i.path)) : undefined;
const reviewed = new Set();
for (const n of names)
  (load('helper_' + n)?.fully_reviewed_files || []).forEach(
    f => (!inScope || inScope.has(f)) && reviewed.add(f)
  );
text(`REVIEWED ${reviewed.size}`);
