#!/bin/sh
# Prints, as JSON, exactly which codex-security, Codex and plugin this image runs.
set -eu

root=$(npm root -g)/@openai/codex-security
codex_pkg=$(node -e 'console.log(require.resolve("@openai/codex/package.json", {paths: [process.argv[1]]}))' "$root")
codex_bin=$(dirname "$codex_pkg")/bin/codex.js
# Transitive dependencies are resolved at build time (no shrinkwrap); a changed
# hash between runs means the installed tree drifted.
npm_tree_sha256=$(npm ls -g --all --json 2>/dev/null | sha256sum | cut -d' ' -f1)

node - "$root" "$codex_pkg" "$codex_bin" "$npm_tree_sha256" <<'EOF'
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [root, codexPkg, codexBin, npmTreeSha256] = process.argv.slice(2);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
console.log(JSON.stringify({
  codex_security: json(`${root}/package.json`).version,
  codex_security_tgz_sha256: readFileSync("/opt/codex-security/codex-security.tgz.sha256", "utf8").split(/\s+/)[0],
  codex_security_cli: run("codex-security", ["--version"]),
  codex_npm: json(codexPkg).version,
  codex_cli: run("node", [codexBin, "--version"]),
  codex_bin: codexBin,
  plugin: json(`${root}/_bundled_plugin/.codex-plugin/plugin.json`).version,
  npm_tree_sha256: npmTreeSha256,
  node: process.version,
  python: run("python3", ["--version"]),
  patches: [],
}, null, 2));
EOF
