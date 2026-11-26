// @exec: {"yield_time_ms": 60000, "max_output_tokens": 2000}
const task = '<task name>';
// A helper's result, saved where the lead reads it: artifacts/helpers/<task>.json in the scan dir.
// The scan's tools serve only the lead's thread: a helper's call fails with "This scan requires
// its owning Codex thread". So the helper writes the file with shell commands, in a sandbox where
// only the scan dir is writable: no heredoc (the shell keeps its body in /tmp, which is
// read-only), and no command longer than one argument may be (128 KiB on Linux), since the shell
// gets the whole command as one.
//
// 1. The task name names the file the lead reads, and goes into a command: only a task's name.
if (!/^[a-z0-9_]+$/.test(task))
  throw new Error(`Put your task name in the script's second line, not ${JSON.stringify(task)}.`);
// 2. The whole result so far, as the helper stored it.
const result = load('result');
const fields = ['findings', 'resolved_questions', 'fully_reviewed_files'];
if (!result || fields.some(f => !Array.isArray(result[f])))
  throw new Error(
    `First store('result', ...) your whole result: ${fields.join(', ')}, each a list.`
  );
// 3. As JSON a single-quoted shell word holds as it is: every character outside printable ASCII,
// and the apostrophe, as its \u escape. They occur only inside JSON strings, where the escape is
// the same character; the text has no other quote, so it can be cut anywhere.
const json = JSON.stringify(result).replace(
  /[^\x20-\x26\x28-\x7e]/g,
  c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
);
// 4. Written in pieces to a partial file beside the result, then renamed over it once whole: the
// lead never reads half a result, and a save cut short leaves the last whole one in place.
const dir = '{{SCAN_DIR}}/artifacts/helpers';
const partial = `${dir}/.${task}.json.partial`;
const sh = cmd => tools.exec_command({ cmd, yield_time_ms: 60000, max_output_tokens: 2000 });
const PIECE = 60000;
for (let at = 0; at < json.length; at += PIECE) {
  const piece = `printf '%s' '${json.slice(at, at + PIECE)}'`;
  await sh(at === 0 ? `mkdir -p ${dir} && ${piece} > ${partial}` : `${piece} >> ${partial}`);
}
const saved = await sh(
  `test $(wc -c < ${partial}) -eq ${json.length} && mv -f ${partial} ${dir}/${task}.json && echo SAVED`
);
if (!saved.output.includes('SAVED'))
  throw new Error(`Not saved; the last one stays in place: ${saved.output.slice(0, 500)}`);
text(
  `saved artifacts/helpers/${task}.json: ${fields.map(f => `${f}=${result[f].length}`).join(' ')}`
);
