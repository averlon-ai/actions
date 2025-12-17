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

# Build the action
bun build "$ACTION_NAME/src/main.ts" --outdir "$ACTION_NAME/dist" --target node --format cjs --minify

echo "✓ Built $ACTION_NAME successfully"
