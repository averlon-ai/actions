#!/bin/bash
#
# Sync the "Available Actions" table in docs from action metadata.
# Usage:
#   ./scripts/sync-action-list.sh [target_file...]
# If no targets are provided, defaults to updating README.md.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACTION_LIST_FILE="$(mktemp)"

"${ROOT_DIR}/scripts/generate-action-list.sh" > "$ACTION_LIST_FILE"

START_MARKER="<!-- ACTION_LIST:START -->"
END_MARKER="<!-- ACTION_LIST:END -->"

update_file() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    echo "Skipping missing file: $file" >&2
    return
  fi

  local tmp
  tmp="$(mktemp)"

  awk -v start="$START_MARKER" -v end="$END_MARKER" -v table_file="$ACTION_LIST_FILE" '
    BEGIN {
      in_block = 0
      # load table content (with newlines) from temp file
      while ((getline line < table_file) > 0) {
        table = table line "\n"
      }
      close(table_file)
    }
    $0 ~ start { print start; printf "%s", table; in_block = 1; next }
    $0 ~ end && in_block { print end; in_block = 0; next }
    in_block { next }
    { print }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
  echo "Updated action list in $file"
}

if [[ $# -eq 0 ]]; then
  update_file "${ROOT_DIR}/README.md"
else
  for target in "$@"; do
    update_file "$target"
  done
fi

