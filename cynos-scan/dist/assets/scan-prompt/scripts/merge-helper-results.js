// @exec: {"yield_time_ms": 60000, "max_output_tokens": 30000}
const names = load('helper_names') || [];
const all = [],
  reviewed = new Set(),
  questions = [];
for (const n of names) {
  const h = load('helper_' + n) || { findings: [] };
  for (const f of h.findings || []) {
    f.provenance = { ...(f.provenance || {}), source: 'local_plugin' };
    if (!Array.isArray(f.taxonomy?.cwe))
      f.taxonomy = { ...(f.taxonomy || {}), cwe: f.taxonomy?.cwe ? [f.taxonomy.cwe] : [] };
    all.push(Object.assign(f, { _helper: n }));
  }
  (h.fully_reviewed_files || []).forEach(p => reviewed.add(p));
  questions.push(
    ...(h.resolved_questions || []).map(
      q => `${n}: ${typeof q === 'string' ? q : JSON.stringify(q)}`
    )
  );
}
// Duplicates: the same weakness reported twice, which only the same line can show. Two findings
// are duplicates when they have the same CWE and the same sink line (path and startLine), or,
// when neither has a sink, the same reported line (the root_control location, else the first).
// Sibling operations on neighbouring lines are separate findings. The copy with more evidence
// wins and takes the other's locations too; findings keep their order otherwise.
const at = f => (f.locations || []).find(l => l.role === 'root_control') || f.locations?.[0] || {};
const sink = f => (f.locations || []).find(l => l.role === 'sink');
const cwe = f => (f.taxonomy?.cwe || [])[0];
const key = f => `${at(f).path}:${at(f).startLine}:${cwe(f)}`;
const line = l => `${l.path}:${l.startLine}`;
const duplicate = (a, b) => {
  if (cwe(a) !== cwe(b)) return false;
  const [sa, sb] = [sink(a), sink(b)];
  if (sa || sb) return !!(sa && sb) && line(sa) === line(sb);
  return line(at(a)) === line(at(b));
};
const merged = [];
for (const f of all) {
  const i = merged.findIndex(o => duplicate(o, f));
  if (i < 0) {
    merged.push(f);
    continue;
  }
  const [keep, other] =
    (f.codeEvidence || []).length > (merged[i].codeEvidence || []).length
      ? [f, merged[i]]
      : [merged[i], f];
  const known = new Set((keep.locations || []).map(l => `${line(l)}:${l.role}`));
  keep.locations = [
    ...(keep.locations || []),
    ...(other.locations || []).filter(l => !known.has(`${line(l)}:${l.role}`)),
  ];
  merged[i] = keep;
}
// Identities: the draft tool takes an anchor or instance only as a lowercase slug
// (^[a-z0-9][a-z0-9._/-]*$) and rejects the whole draft for one that is not, while helpers write
// file paths such as .github/workflows/ci.yml and code names such as UpdateProviderKey. So each
// becomes the slug upstream's workbench makes of a name (retained_records.py,
// _semantic_identifier): accents dropped, lowercased, every other run of characters a "-", no
// leading non-alphanumerics or trailing "-". A finding whose rule, anchor and instance an earlier
// one has, which the workbench refuses, gets the workbench's own split: its instance with -2, -3,
// ..., taking no other finding's identity.
const slug = (value, fallback) =>
  String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '') || fallback;
merged.forEach((f, i) => {
  for (const field of ['anchor', 'instance'])
    if (f.identity?.[field] !== undefined)
      f.identity[field] = slug(f.identity[field], `finding-${i + 1}`);
});
const identified = merged.filter(f => f.identity);
const identity = f => JSON.stringify([f.ruleId, f.identity.anchor, f.identity.instance]);
const taken = new Set(identified.map(identity)),
  used = new Set();
for (const f of identified) {
  if (used.has(identity(f))) {
    const base = f.identity.instance ?? 'saved';
    for (let n = 2; taken.has(identity(f)); n++) f.identity.instance = `${base}-${n}`;
    taken.add(identity(f));
  }
  used.add(identity(f));
}
store('merged', merged);
store('reviewed', [...reviewed]);
store('questions', questions);
merged.forEach((f, i) =>
  text(
    `${i} ${f._helper} ${f.ruleId} ${f.severity?.level} ${(f.taxonomy?.cwe || []).join()} ${key(f)} | ${f.title}`
  )
);
text(`reviewed files: ${reviewed.size}`);
text(questions.slice(0, 40).join('\n'));
