#!/bin/bash

# Generate a Markdown table of all available actions using metadata from each action.yml.
# This keeps release notes and README in sync.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACTION_DIRS="$("${ROOT_DIR}/scripts/discover-actions.sh")"

escape_pipes() {
  echo "$1" | sed 's/|/\\|/g'
}

TABLE="| Action | Description | Documentation |\n"
TABLE+="| --- | --- | --- |\n"

for ACTION_NAME in $ACTION_DIRS; do
  ACTION_FILE="${ROOT_DIR}/${ACTION_NAME}/action.yml"

  if [[ ! -f "${ACTION_FILE}" ]]; then
    continue
  fi

  RAW_NAME=$(grep -m1 "^name:" "${ACTION_FILE}" | sed 's/^name:[[:space:]]*//')
  RAW_DESCRIPTION=$(grep -m1 "^description:" "${ACTION_FILE}" | sed 's/^description:[[:space:]]*//')

  ACTION_DISPLAY=$(echo "${RAW_NAME}" | sed "s/^['\"]//; s/['\"]$//")
  ACTION_DESCRIPTION=$(echo "${RAW_DESCRIPTION}" | sed "s/^['\"]//; s/['\"]$//")

  DOC_PATH="${ACTION_NAME}/README.md"
  TABLE+="| **[$(escape_pipes "${ACTION_DISPLAY}")](${DOC_PATH})** | $(escape_pipes "${ACTION_DESCRIPTION}") | [📖 Read More](${DOC_PATH}) |\n"
done

printf "%b" "${TABLE}"
