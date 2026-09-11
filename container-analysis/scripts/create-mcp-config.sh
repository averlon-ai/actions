#!/usr/bin/env bash
#
# Writes the Averlon MCP server config for the Coding Agent and reports the
# file path as the `config-path` step output.
#
# Required environment:
#   MCP_API_KEY, MCP_API_SECRET, SECDI_SERVER, MCP_IMAGE_REF, GITHUB_OUTPUT
# Optional environment:
#   CONTAINER_ENGINE - engine command to use instead of the detected one, either
#                      a name on PATH or an absolute path to the binary

set -euo pipefail

# Docker and podman take the same `run --rm -i <image>` invocation, so the
# engine only decides the command name. Sets ENGINE rather than printing it, so
# that the workflow commands below reach the log instead of a substitution.
resolve_engine() {
  if [ -n "${CONTAINER_ENGINE:-}" ]; then
    case $CONTAINER_ENGINE in
      */*)
        if [ ! -x "$CONTAINER_ENGINE" ]; then
          echo "::error::container-engine '$CONTAINER_ENGINE' is not an executable file on the runner."
          return 1
        fi
        ;;
      *)
        if ! command -v "$CONTAINER_ENGINE" > /dev/null 2>&1; then
          echo "::error::container-engine '$CONTAINER_ENGINE' was not found on PATH. Give an absolute path if it is installed outside PATH."
          return 1
        fi
        ;;
    esac
    ENGINE=$CONTAINER_ENGINE
  elif command -v docker > /dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman > /dev/null 2>&1; then
    ENGINE=podman
  else
    echo "::error::No container engine found on the runner. The Averlon MCP server runs as a container - install docker or podman, or set the container-engine input to its path."
    return 1
  fi
}

json_escape() {
  local value=${1//\\/\\\\}
  printf '%s' "${value//\"/\\\"}"
}

main() {
  resolve_engine
  echo "Averlon MCP server container engine: $ENGINE"

  # The X's have to end the template: BSD mktemp does not substitute them
  # mid-template, so a directory keeps the config named config.json.
  local dir config
  dir=$(mktemp -d /tmp/averlon-mcp.XXXXXX)
  chmod 700 "$dir"
  config="$dir/config.json"

  cat > "$config" << EOF
{
  "mcpServers": {
    "averlon-mcp": {
      "command": "$(json_escape "$ENGINE")",
      "args": [
        "run", "--rm", "-i",
        "-e", "AVERLON_API_KEY=$(json_escape "${MCP_API_KEY:-}")",
        "-e", "AVERLON_API_SECRET=$(json_escape "${MCP_API_SECRET:-}")",
        "-e", "SECDI_SERVER=$(json_escape "${SECDI_SERVER:-}")",
        "$(json_escape "${MCP_IMAGE_REF:-}")"
      ]
    }
  }
}
EOF
  chmod 600 "$config"

  echo "config-path=$config" >> "$GITHUB_OUTPUT"
  echo "config-dir=$dir" >> "$GITHUB_OUTPUT"
}

main "$@"
