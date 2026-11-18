#!/bin/bash

# This script builds a single action
# Usage: ./scripts/build-action.sh <action-name>

set -e

ACTION_NAME=$1

if [ -z "$ACTION_NAME" ]; then
  echo "Error: Please provide an action name"
  echo "Usage: $0 <action-name>"
  exit 1
fi

if [ ! -f "$ACTION_NAME/action.yml" ]; then
  echo "Error: Action '$ACTION_NAME' not found (no action.yml file)"
  exit 1
fi

if [ ! -f "$ACTION_NAME/src/main.ts" ]; then
  echo "Error: Action '$ACTION_NAME' has no src/main.ts file"
  exit 1
fi

echo "Building action: $ACTION_NAME"

# Create dist directory if it doesn't exist
mkdir -p "$ACTION_NAME/dist"

# Build the action — main entry point
bun build "$ACTION_NAME/src/main.ts" --outdir "$ACTION_NAME/dist" --target node --format cjs --minify

# Build additional entry points if they exist
for extra in "$ACTION_NAME"/src/submit-feedback.ts "$ACTION_NAME"/src/setup-skills.ts "$ACTION_NAME"/src/cleanup-skills.ts "$ACTION_NAME"/src/validate-anthropic-key.ts "$ACTION_NAME"/src/post.ts "$ACTION_NAME"/src/bench.ts; do
  if [ -f "$extra" ]; then
    bun build "$extra" --outdir "$ACTION_NAME/dist" --target node --format cjs --minify
  fi
done

# Files the bundle cannot carry (a Dockerfile, profiles, prompts), from the package that owns them:
# an action that declares "assets-from" (a directory, relative to the action) in its package.json
# gets a copy of it as dist/assets, so dist/ is self-contained. A node_modules/ path is looked up as
# Node looks up a package: in the action's own node_modules, then in each parent's, since the
# workspace install may hoist the package to the root.
ASSETS_FROM=$(bun -e "console.log(require('./$ACTION_NAME/package.json')['assets-from'] ?? '')")
if [ -n "$ASSETS_FROM" ]; then
  ASSETS_DIR="$ACTION_NAME/$ASSETS_FROM"
  if [ ! -d "$ASSETS_DIR" ] && [[ "$ASSETS_FROM" == node_modules/* ]]; then
    SEARCH_DIR=$(cd "$ACTION_NAME" && pwd)
    while [ "$SEARCH_DIR" != "/" ] && [ ! -d "$SEARCH_DIR/$ASSETS_FROM" ]; do
      SEARCH_DIR=$(dirname "$SEARCH_DIR")
    done
    ASSETS_DIR="$SEARCH_DIR/$ASSETS_FROM"
  fi
  if [ ! -d "$ASSETS_DIR" ]; then
    echo "Error: assets-from directory '$ACTION_NAME/$ASSETS_FROM' not found"
    exit 1
  fi
  rm -rf "$ACTION_NAME/dist/assets"
  cp -RL "$ASSETS_DIR" "$ACTION_NAME/dist/assets"
  # "assets-exclude" lists files of it the action must not carry, relative to the directory.
  ASSETS_EXCLUDE=$(bun -e "console.log((require('./$ACTION_NAME/package.json')['assets-exclude'] ?? []).join('\n'))")
  while IFS= read -r excluded; do
    [ -n "$excluded" ] && rm -f "$ACTION_NAME/dist/assets/$excluded"
  done <<< "$ASSETS_EXCLUDE"
fi

echo "✓ Built $ACTION_NAME successfully"
