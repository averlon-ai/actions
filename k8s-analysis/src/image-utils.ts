/**
 * Normalize container image references using parse-docker-image-name.
 * Match via canonical repo name; when multiple tags exist for the same repo
 * (e.g. nginx:1.2 and nginx:1.3), we treat them as one repo and can pick
 * the latest tag (1.3) for query/display.
 */

import parseDockerImage from 'parse-docker-image-name';
import semver from 'semver';

const DEFAULT_REGISTRY = 'docker.io';
const DOCKER_INDEX = 'index.docker.io';

/** Parsed components from parse-docker-image-name (domain/path may be omitted) */
export interface ParsedDockerImage {
  domain?: string;
  path: string;
  tag?: string;
  digest?: string;
}

/**
 * Type guard for parse-docker-image-name result. Validates that the parsed value
 * has the required `path` property (string) so we can safely use it for canonical repo.
 */
function isParsedDockerImage(value: unknown): value is ParsedDockerImage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    typeof (value as ParsedDockerImage).path === 'string'
  );
}

/**
 * Build canonical repository string (registry + path, no tag/digest).
 * - With domain: use domain/path; normalize index.docker.io → docker.io
 * - Without domain (Docker Hub short): docker.io/library/path when path has no /,
 *   else docker.io/path
 */
export function normalizeImageToCanonicalRepository(image: string): string | null {
  const parsed = parseDockerImage(image);
  if (!isParsedDockerImage(parsed)) {
    return null;
  }

  const path = String(parsed.path).trim();
  if (!path) {
    return null;
  }

  const domain = parsed.domain ? String(parsed.domain).trim() : undefined;

  if (domain) {
    const normDomain =
      domain === DOCKER_INDEX || domain === 'docker.io' ? DEFAULT_REGISTRY : domain;
    return `${normDomain}/${path}`;
  }

  // Docker Hub: no domain. path can be "nginx" or "org/app"
  if (!path.includes('/')) {
    return `${DEFAULT_REGISTRY}/library/${path}`;
  }
  return `${DEFAULT_REGISTRY}/${path}`;
}

/**
 * Compare two image tags for "latest" ordering. Uses semver when both are
 * valid versions; otherwise "latest" is greatest, then string compare.
 * Returns: positive if a > b, negative if a < b, 0 if equal.
 *
 * Uses semver with { loose: true } so that common image tags like "1.2" or "1.2.3"
 * (without patch/minor) are accepted. Strict semver would reject "1.2" as invalid;
 * loose parsing normalizes them for comparison (e.g. "1.2" → "1.2.0").
 */
export function compareTags(a: string | undefined, b: string | undefined): number {
  const tagA = a ?? '';
  const tagB = b ?? '';
  if (tagA === tagB) return 0;
  if (tagA === 'latest') return 1;
  if (tagB === 'latest') return -1;

  const validA = semver.valid(tagA, { loose: true });
  const validB = semver.valid(tagB, { loose: true });
  if (validA && validB) {
    return semver.compare(validA, validB);
  }
  return tagA.localeCompare(tagB, undefined, { numeric: true });
}

/**
 * Given a list of image strings that all refer to the same repository,
 * return the one with the "latest" tag (e.g. nginx:1.3 over nginx:1.2).
 * If only one image, returns it. Uses compareTags for ordering.
 */
export function pickLatestImageInRepo(images: string[]): string | null {
  if (!images.length) return null;
  if (images.length === 1) return images[0]!;

  const parsed = images.map(img => {
    const p = parseDockerImage(img);
    return { image: img, parsed: isParsedDockerImage(p) ? p : null };
  });

  let best = parsed[0]!;
  for (let i = 1; i < parsed.length; i++) {
    const curr = parsed[i]!;
    const bestTag = best.parsed?.tag;
    const currTag = curr.parsed?.tag;
    if (compareTags(currTag, bestTag) > 0) {
      best = curr;
    }
  }
  return best.image;
}

/**
 * Group image strings by canonical repository and pick the latest tag
 * per repo. Returns a Map: canonicalRepository -> single image ref (latest tag).
 */
export function groupImagesByRepoAndPickLatest(images: string[]): Map<string, string> {
  const byRepo = new Map<string, string[]>();

  for (const image of images) {
    const repo = normalizeImageToCanonicalRepository(image);
    if (!repo) continue;
    const list = byRepo.get(repo) ?? [];
    list.push(image);
    byRepo.set(repo, list);
  }

  const result = new Map<string, string>();
  for (const [repo, list] of byRepo) {
    const chosen = pickLatestImageInRepo(list);
    if (chosen) result.set(repo, chosen);
  }
  return result;
}
