import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

import type { GitFileRecommendationRequest, KVPair } from '@averlon/shared';

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
 * Finds all Dockerfiles in the repository.
 *
 * @returns The list of Dockerfiles.
 */
export async function findDockerfiles(): Promise<string[]> {
  const patterns = [
    // Standard Dockerfile patterns
    '**/Dockerfile',
    '**/dockerfile',
    '**/Dockerfile.*',
    '**/dockerfile.*',

    // Hidden Dockerfile patterns
    '**/.dockerfile',
    '**/.Dockerfile',
    '**/.dockerfile.*',
    '**/.Dockerfile.*',

    // Files with .dockerfile extension
    '**/*.dockerfile',
    '**/*.Dockerfile',

    // Docker files with prefixes and suffixes
    '**/*Dockerfile*',
    '**/*dockerfile*',

    // Common custom naming patterns
    '**/docker.*.dockerfile',
    '**/*.docker.*.dockerfile',
  ];
  const entries = await fg(patterns, {
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: true,
    unique: true,
  });
  return entries.sort();
}

/**
 * Parses the image map from a multiline string.
 *
 * This function parses a multiline string where each line contains a file path
 * and its corresponding image repository, separated by an equals sign.
 * It's commonly used to map Dockerfile paths to their target image repositories.
 *
 * @param multiline - The multiline string to parse, where each line has format "filepath=repository".
 * @returns A record mapping file paths to their corresponding image repositories.
 *
 * @example
 * ```typescript
 * const input = `Dockerfile=myregistry/myapp:latest
 * cmd/Dockerfile=myregistry/myapp-cmd:v1.0
 * api/Dockerfile=myregistry/myapp-api:dev`;
 * const map = parseImageMap(input);
 * // Returns: {
 * //   "Dockerfile": "myregistry/myapp:latest",
 * //   "cmd/Dockerfile": "myregistry/myapp-cmd:v1.0",
 * //   "api/Dockerfile": "myregistry/myapp-api:dev"
 * // }
 * ```
 */
export function parseImageMap(multiline: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!multiline) return map;
  const lines = multiline
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const filePath = line.slice(0, idx).trim();
    const repo = line.slice(idx + 1).trim();
    if (filePath && repo) map[filePath] = repo;
  }
  return map;
}

/**
 * Builds the GitFileRecommendationRequest objects for the Dockerfiles.
 *
 * @param dockerfiles - The list of Dockerfiles.
 * @param imageMap - The image map.
 * @returns The list of GitFileRecommendationRequest objects.
 */
export function buildDockerfileRequests(
  dockerfiles: string[],
  imageMap: Record<string, string>
): GitFileRecommendationRequest[] {
  return dockerfiles.map(p => {
    const rel = toRelativePath(p);
    const content = fs.readFileSync(p, 'utf8');
    const metadata: KVPair[] = [];
    const labels = parseDockerLabels(content);
    for (const [k, v] of Object.entries(labels)) {
      if (k && v) metadata.push({ Key: `label:${k}`, Value: String(v) });
    }
    const imageRepository = imageMap[rel] || '';
    if (imageMap[rel]) metadata.push({ Key: 'ImageRepository', Value: imageMap[rel] });
    return {
      Path: rel,
      Type: 1,
      Content: '',
      Metadata: metadata,
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
  const nameToBit: Record<string, number> = {
    RecommendedOrExploited: 0x1,
    Critical: 0x2,
    High: 0x4,
    HighRCE: 0x8,
    MediumApplication: 0x10,
  };
  let mask = 0;
  const parts = input
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (nameToBit[part] != null) mask |= nameToBit[part];
  }
  return mask;
}
