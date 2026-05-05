#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PHASE1=()
while IFS= read -r f; do
  PHASE1+=("$f")
done < <(
  git ls-files '*.test.ts' \
    | grep -Ev '^(iac-misconfig-analysis|k8s-analysis)/test/unit/github-issues\.test\.ts$' \
    || true
)

if [[ ${#PHASE1[@]} -eq 0 ]]; then
  echo "run-tests.sh: no test files matched" >&2
  exit 1
fi

bun test "${PHASE1[@]}"
bun test \
  iac-misconfig-analysis/test/unit/github-issues.test.ts \
  k8s-analysis/test/unit/github-issues.test.ts
