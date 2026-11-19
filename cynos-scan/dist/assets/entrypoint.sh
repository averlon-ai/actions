#!/bin/sh
# Runs `codex-security <args>` with the cynos key under the one name Codex reads.
#
# The cynos key arrives as CYNOS_API_KEY (docker run -e, value from the
# workflow step's env). Upstream codex-security accepts an API key only from
# OPENAI_API_KEY or CODEX_API_KEY and hands it to Codex as CODEX_API_KEY, which
# the custom `cynos` provider names as its env_key. Map it once here and drop the
# original name, so the key exists in the container under exactly one variable.
#
# `export`, `scan --mock` and `scan --dry-run` make no model call, so they run without a
# key; any other command without one is a configuration error, reported before Codex starts.
set -eu

needs_key=true
case "${1:-}" in
  export) needs_key=false ;;
esac
for arg in "$@"; do
  case "$arg" in
    --mock | --dry-run) needs_key=false ;;
  esac
done

if [ -n "${CYNOS_API_KEY:-}" ]; then
  CODEX_API_KEY="$CYNOS_API_KEY"
  export CODEX_API_KEY
elif [ "$needs_key" = true ]; then
  echo "entrypoint: CYNOS_API_KEY is not set (pass it with docker run -e)" >&2
  exit 2
fi
unset CYNOS_API_KEY

exec codex-security "$@"
