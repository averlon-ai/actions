#!/bin/bash
set -e

# This script builds all actions in the monorepo

# Get list of all action directories using the discover script
ACTION_DIRS=$(./scripts/discover-actions.sh)

if [ -z "$ACTION_DIRS" ]; then
  echo "No actions found to build."
  exit 0
fi

echo "Found actions: $(echo $ACTION_DIRS | tr '\n' ' ')"

# Build each action
for ACTION_NAME in $ACTION_DIRS; do
  ./scripts/build-action.sh "$ACTION_NAME"
done

echo "All actions built successfully!"
