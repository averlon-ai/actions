#!/usr/bin/env bun
/**
 * Update all README/templates that pin averlon-ai/actions usages to the latest release version.
 *
 * Usage:
 *   bun scripts/update-action-versions.ts 1.2.3
 *   bun scripts/update-action-versions.ts v1.2.3
 *
 * The script looks for occurrences of:
 *   averlon-ai/actions/<action-name>@v<semver>
 * across markdown, yaml and shell files and rewrites them to the provided version.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const versionArg = process.argv[2];

if (!versionArg) {
  console.error('Usage: bun scripts/update-action-versions.ts <version>');
  process.exit(1);
}

const normalizedVersion = versionArg.startsWith('v') ? versionArg : `v${versionArg}`;
const versionPattern = /^v\d+\.\d+\.\d+$/;

if (!versionPattern.test(normalizedVersion)) {
  console.error(`Invalid version "${versionArg}". Expected format: v<major>.<minor>.<patch>`);
  process.exit(1);
}

const repoRoot = join(__dirname, '..');
const allowedExtensions = new Set(['.md', '.mdx', '.yml', '.yaml', '.sh', '.ts', '.js']);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '.turbo', '.next', 'coverage']);

function shouldSkipDir(entry: string): boolean {
  return ignoredDirectories.has(entry);
}

function shouldProcessFile(filePath: string): boolean {
  return allowedExtensions.has(extname(filePath));
}

function getFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        files.push(...getFiles(join(dir, entry.name)));
      }
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (shouldProcessFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

const usageRegex = /averlon-ai\/actions\/([-A-Za-z0-9_{}]+)@v\d+(?:\.\d+){0,2}/g;
const files = getFiles(repoRoot);
let updatedCount = 0;

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  const replaced = original.replace(usageRegex, (_match, actionName) => {
    return `averlon-ai/actions/${actionName}@${normalizedVersion}`;
  });

  if (replaced !== original) {
    writeFileSync(file, replaced);
    updatedCount += 1;
    console.log(`Updated ${relative(repoRoot, file)}`);
  }
}

if (updatedCount === 0) {
  console.warn('No action usage examples were updated. Is the version already current?');
} else {
  console.log(`\nDone. Updated ${updatedCount} file(s) to ${normalizedVersion}.`);
}
