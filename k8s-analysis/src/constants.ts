/**
 * Central constants and env-based configuration for k8s-analysis.
 * Query limits are configurable via environment variables to support
 * large deployments and avoid incomplete results (e.g. pagination limits).
 */

/** Parse a numeric env var; returns default if unset, empty, or invalid. */
export function getEnvNumber(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const n = Number(v);
  return Number.isNaN(n) ? defaultValue : n;
}

/** Default limit for OpenSearch public images query. Increase if > 10k public images. */
export const PUBLIC_IMAGES_QUERY_LIMIT_DEFAULT = 10000;

/** Default batch size when chunking resources by kind for issue queries. */
export const RESOURCE_KIND_QUERY_BATCH_DEFAULT = 50;

/** Default max issues attached per resource (avoids unbounded growth). */
export const MAX_ISSUES_PER_RESOURCE_DEFAULT = 50;

/** Default batch size when chunking image repositories for image-issue queries. */
export const IMAGE_REPOSITORY_QUERY_BATCH_DEFAULT = 50;

export const ENV_KEYS = {
  PUBLIC_IMAGES_QUERY_LIMIT: 'PUBLIC_IMAGES_QUERY_LIMIT',
  RESOURCE_KIND_QUERY_BATCH: 'RESOURCE_KIND_QUERY_BATCH',
  MAX_ISSUES_PER_RESOURCE: 'MAX_ISSUES_PER_RESOURCE',
  IMAGE_REPOSITORY_QUERY_BATCH: 'IMAGE_REPOSITORY_QUERY_BATCH',
} as const;

/** Public images query limit (env: PUBLIC_IMAGES_QUERY_LIMIT). */
export function getPublicImagesQueryLimit(): number {
  return getEnvNumber(ENV_KEYS.PUBLIC_IMAGES_QUERY_LIMIT, PUBLIC_IMAGES_QUERY_LIMIT_DEFAULT);
}

/** Resource kind query batch size (env: RESOURCE_KIND_QUERY_BATCH). */
export function getResourceKindQueryBatch(): number {
  return getEnvNumber(ENV_KEYS.RESOURCE_KIND_QUERY_BATCH, RESOURCE_KIND_QUERY_BATCH_DEFAULT);
}

/** Max issues per resource (env: MAX_ISSUES_PER_RESOURCE). */
export function getMaxIssuesPerResource(): number {
  return getEnvNumber(ENV_KEYS.MAX_ISSUES_PER_RESOURCE, MAX_ISSUES_PER_RESOURCE_DEFAULT);
}

/** Image repository query batch size (env: IMAGE_REPOSITORY_QUERY_BATCH). */
export function getImageRepositoryQueryBatch(): number {
  return getEnvNumber(ENV_KEYS.IMAGE_REPOSITORY_QUERY_BATCH, IMAGE_REPOSITORY_QUERY_BATCH_DEFAULT);
}
