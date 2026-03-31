import fs from 'node:fs';
import path from 'node:path';

import type { GitDockerfileRequest, KVPair } from '@averlon/shared';
import { FILTER_BITS } from './constants';

/**
 * Converts a path to a relative path.
 *
 * @param p - The path to convert.
 * @returns The relative path.
 */
export function toRelativePath(p: string): string {
  const cwd = process.cwd();
  return path.relative(cwd, path.resolve(cwd, p)) || p;
}

/**
 * Normalizes and joins continued lines by handling line continuation characters.
 *
 * This function processes text that may contain line continuations (lines ending with '\')
 * and joins them into single logical lines. This is commonly used in Dockerfiles and shell scripts
 * where long commands are split across multiple lines using backslash continuation.
 *
 * @param text - The text to normalize and join.
 * @returns An array of normalized lines with continuations properly joined.
 *
 * @example
 * ```typescript
 * const input = `FROM node:18 \\
 *   AS builder \\
 *   WORKDIR /app`;
 * const result = normalizeAndJoinContinuedLines(input);
 * // Returns: ['FROM node:18 AS builder', 'WORKDIR /app']
 * ```
 */
function normalizeAndJoinContinuedLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const joined: string[] = [];
  let buffer = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith('\\')) {
      buffer += trimmed.slice(0, -1) + ' ';
      continue;
    }
    if (buffer) {
      joined.push((buffer + trimmed).trim());
      buffer = '';
    } else {
      joined.push(trimmed);
    }
  }
  if (buffer) joined.push(buffer.trim());
  return joined;
}

/**
 * Parses Docker labels from Dockerfile content.
 *
 * This function extracts LABEL instructions from Dockerfile content and parses them into
 * key-value pairs. It handles multi-line labels, quoted values, and various label formats.
 * The function processes each line, identifies LABEL instructions, and uses regex to parse
 * the label syntax into individual key-value pairs.
 *
 * @param fileContent - The Dockerfile content to parse.
 * @returns A record of parsed label key-value pairs.
 *
 * @example
 * ```typescript
 * const dockerfile = `FROM node:18
 * LABEL maintainer="John Doe" version="1.0.0"
 * LABEL description="My application"`;
 * const labels = parseDockerLabels(dockerfile);
 * // Returns: { maintainer: "John Doe", version: "1.0.0", description: "My application" }
 * ```
 */
function parseDockerLabels(fileContent: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const lines = normalizeAndJoinContinuedLines(fileContent);
  for (const line of lines) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('LABEL ')) {
      const rest = line.slice(6).trim();
      // Complex regex to parse Docker LABEL syntax:
      // (?:[^\s"=]+|"[^"]*")+=?(?:[^\s"]+|"[^"]*")*
      // Breakdown:
      // - (?:[^\s"=]+|"[^"]*")+ : Matches key part (non-space chars OR quoted string)
      // - =? : Optional equals sign
      // - (?:[^\s"]+|"[^"]*")* : Matches value part (non-space chars OR quoted string)
      // This handles: key=value, "key"="value", key="value with spaces", etc.
      const parts = rest.match(/(?:[^\s"=]+|"[^"]*")+=?(?:[^\s"]+|"[^"]*")*/g) || [];
      for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim();
        let value = part.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key) labels[key] = value;
      }
    }
  }
  return labels;
}

/**
 * Builds the GitDockerfileRequest objects for the Dockerfiles.
 *
 * @param dockerfiles - The list of Dockerfiles.
 * @param imageMap - The image map.
 * @returns The list of GitDockerfileRequest objects.
 */
export function buildDockerfileRequests(
  dockerfiles: string[],
  imageMap: Record<string, string>
): GitDockerfileRequest[] {
  return dockerfiles.map(p => {
    const rel = toRelativePath(p);
    const content = fs.readFileSync(p, 'utf8');
    const labels: KVPair[] = [];
    const parsedLabels = parseDockerLabels(content);
    for (const [k, v] of Object.entries(parsedLabels)) {
      if (k && v) labels.push({ Key: k, Value: String(v) });
    }
    const imageRepository = imageMap[rel] || '';
    return {
      Path: rel,
      Content: content,
      Labels: labels,
      ImageRepository: imageRepository,
    };
  });
}

/**
 * Gets the Git repository URL.
 *
 * @returns The Git repository URL.
 */
export function getGitRepoUrl(): string {
  const server = process.env['GITHUB_SERVER_URL'] || 'https://github.com';
  const repo = process.env['GITHUB_REPOSITORY'];
  if (!repo) return '';
  return `${server}/${repo}.git`;
}

/**
 * Parses security filter flags from a comma-separated string.
 *
 * This function converts human-readable filter names into a bitmask for efficient
 * filtering of security recommendations. Each filter type corresponds to a specific
 * bit in the returned number, allowing for efficient bitwise operations.
 *
 * @param input - Comma-separated string of filter names (e.g., "Critical,High,MediumApplication").
 * @returns A bitmask where each bit represents an enabled filter type.
 *
 * @example
 * ```typescript
 * const filters = parseFilters("Critical,High");
 * // Returns: 6 (0x2 | 0x4 = Critical | High)
 * ```
 */
export function parseFilters(input: string | undefined): number {
  if (!input) return 0;
  let mask = 0;
  const parts = input
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (FILTER_BITS[part] != null) mask |= FILTER_BITS[part];
  }
  return mask;
}
