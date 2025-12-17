#!/bin/bash

# This script discovers all GitHub Actions in the repository
# by looking for directories containing action.yml files at the root level

set -e

# Find all action directories by looking for action.yml files at root level
# Exclude common non-action directories
find . -maxdepth 1 -mindepth 1 -type d \
  -not -path "*/\.*" \
  -not -path "./packages" \
  -not -path "./node_modules" \
  -not -path "./scripts" \
  -not -path "./test" \
  -not -path "./src" \
  -not -path "./actions" | while read dir; do
  if [ -f "$dir/action.yml" ]; then
    echo "$(basename "$dir")"
  fi
done | sort
