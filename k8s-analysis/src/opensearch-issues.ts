import * as core from '@actions/core';
import { log } from 'node:console';
import {
  ApiClient,
  IssueSeverityEnum,
  IssueTypeEnum,
  OpenSearchIssue,
  OpenSearchNamedQueryEnum,
  OpenSearchResponse,
  VulnerabilityClassEnum,
} from '@averlon/shared';
import {
  getImageRepositoryQueryBatch,
  getMaxIssuesPerResource,
  getPublicImagesQueryLimit,
  getResourceKindQueryBatch,
} from './constants';
import { normalizeImageToCanonicalRepository, pickLatestImageInRepo } from './image-utils';
import { ParsedResource, ResourceIssue } from './resource-parser';

/** Resource kinds that can have container images */
const CONTAINER_RESOURCE_KINDS = new Set([
  'Pod',
  'Deployment',
  'DaemonSet',
  'StatefulSet',
  'Job',
  'CronJob',
]);

function severityToString(value?: IssueSeverityEnum): string {
  if (value === undefined || value === null) {
    return 'Unknown';
  }
  const severityLabelMap: Record<number, string> = {
    [IssueSeverityEnum.Invalid]: 'Invalid',
    [IssueSeverityEnum.Unknown]: 'Unknown',
    [IssueSeverityEnum.Low]: 'Low',
    [IssueSeverityEnum.Medium]: 'Medium',
    [IssueSeverityEnum.High]: 'High',
    [IssueSeverityEnum.Critical]: 'Critical',
  };
  return severityLabelMap[value] ?? 'Unknown';
}

/**
 * Extract image repositories from container resources
 */
function extractImageRepositories(resources: ParsedResource[]): Set<string> {
  const imageRepos = new Set<string>();

  for (const resource of resources) {
    if (!CONTAINER_RESOURCE_KINDS.has(resource.kind)) {
      continue;
    }

    const images = resource.metadata?.images || [];
    for (const image of images) {
      const repo = normalizeImageToCanonicalRepository(image);
      if (repo) {
        imageRepos.add(repo);
      }
    }
  }

  return imageRepos;
}

/**
 * Fetch public image repositories from OpenSearch (image.IsPublic = true).
 * Returns canonical repo names for matching against resources' images.
 */
async function getPublicImages(
  client: ApiClient,
  cloudId: string,
  verbose: boolean
): Promise<Set<string>> {
  const publicImages = new Set<string>();
  try {
    const filterQuery = JSON.stringify({
      bool: { filter: [{ term: { 'image.IsPublic': true } }] },
    });
    core.info('Querying OpenSearch for public images');
    if (verbose) {
      core.info(`  CloudID: ${cloudId}`);
      core.info(`  FilterQuery: ${filterQuery}`);
    }

    const response = (await client.orgOpenSearchQuery({
      QueryID: OpenSearchNamedQueryEnum.Image,
      FilterQuery: filterQuery,
      Limit: getPublicImagesQueryLimit(),
      IncludeFields: ['image.ID', 'image.Repository'],
    })) as OpenSearchResponse;

    if (response?.Images) {
      for (const image of response.Images) {
        if (image?.Repository) {
          const canonical =
            normalizeImageToCanonicalRepository(image.Repository) ?? image.Repository;
          publicImages.add(canonical);
        }
      }
    }
    core.info(`✓ Found ${publicImages.size} public image repositories`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to query public images: ${message}`);
  }
  return publicImages;
}

/**
 * Image issues flow:
 * 1. Filter to public image repos that appear in our resources.
 * 2. Build resourceIdToResource map (resource.arn → resource).
 * 3. Query issues by those repos (chunked); attach each issue to the resource
 *    whose resource.arn equals issue.ResourceID (no fallback).
 */
async function annotateImageIssues(params: {
  client: ApiClient;
  cloudId: string;
  resources: ParsedResource[];
  imageRepositories: Set<string>;
  publicImages: Set<string>;
  severityFilters: IssueSeverityEnum[];
  verbose?: boolean;
}): Promise<void> {
  const publicImageRepos = Array.from(params.imageRepositories).filter(repo =>
    params.publicImages.has(repo)
  );
  if (publicImageRepos.length === 0) return;

  core.info(`Found ${publicImageRepos.length} public image repositories to check for issues`);

  const resourceIdToResource = new Map<string, ParsedResource>();
  for (const resource of params.resources) {
    if (resource.arn) resourceIdToResource.set(resource.arn, resource);
  }

  const chunkSize = getImageRepositoryQueryBatch();
  const maxIssuesPerResource = getMaxIssuesPerResource();
  const severityValues =
    params.severityFilters.length > 0 ? params.severityFilters.map(sev => sev.toString()) : [];
  const chunks = chunkArray(publicImageRepos, chunkSize);

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;

    const filterQuery = buildImageIssueFilter({
      cloudId: params.cloudId,
      imageRepositories: chunk,
      severityValues,
      verbose: Boolean(params.verbose),
    });
    const limit = Math.min(chunk.length * maxIssuesPerResource, 1000);

    try {
      if (Boolean(params.verbose)) {
        core.info('Querying OpenSearch for image issues:');
        core.info(`  CloudID: ${params.cloudId}`);
        core.info(`  Image Repositories: ${chunk.length}`);
      } else {
        core.info(`Querying image issues for ${chunk.length} repositories`);
      }
      const response = await params.client.orgOpenSearchQuery({
        QueryID: OpenSearchNamedQueryEnum.Issue,
        FilterQuery: filterQuery,
        Limit: limit,
        IncludeFields: [...ISSUE_INCLUDE_FIELDS_BASE, 'issue.ImageRepository', 'issue.ImageID'],
        Aggregations: 'default',
      });

      const issues = response.Issues ?? [];
      for (const issue of issues) {
        const resourceArn = issue.ResourceID;
        if (!resourceArn || !resourceIdToResource.has(resourceArn)) continue;

        const resource = resourceIdToResource.get(resourceArn)!;
        if (!resource.issues) resource.issues = [];
        if (resource.issues.length >= maxIssuesPerResource) continue;

        const mapped = mapOpenSearchIssue(
          issue,
          typeof issue.ImageRepository === 'string' ? issue.ImageRepository : undefined,
          issue.ImageID
        );
        if (mapped) resource.issues.push(mapped);
      }
      if (Boolean(params.verbose)) {
        core.info(
          `✓ Retrieved and annotated image issues: ${issues.length} issues found for ${chunk.length} repositories`
        );
      } else {
        core.info(`✓ Annotated ${issues.length} image issues`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to query image issues: ${message}`);
    }
  }
}

/** Result type for image issues grouped by repository */
export interface ImageIssueGroup {
  imageRepository: string;
  images: string[];
  issues: Array<{ id: string; title?: string; severity?: string; imageId?: string }>;
  resources: Array<{ kind: string; name: string; namespace: string }>;
}

/**
 * Extract image issues and group by image repository
 * Used for generating GitHub issue content
 */
export function extractImageIssuesForDisplay(
  resources: ParsedResource[]
): Map<string, ImageIssueGroup> {
  const imageRepoMap = new Map<
    string,
    {
      images: Set<string>;
      issues: Map<string, { id: string; title?: string; severity?: string; imageId?: string }>;
      resources: Set<string>;
    }
  >();

  for (const resource of resources) {
    if (!CONTAINER_RESOURCE_KINDS.has(resource.kind)) {
      continue;
    }

    const images = resource.metadata?.images || [];
    const issues = resource.issues || [];

    // Find image issues (those with imageRepository field or type Vulnerability)
    const imageIssues = issues.filter(
      issue => issue.imageRepository || issue.type === 'Vulnerability'
    );

    if (imageIssues.length === 0 && images.length === 0) {
      continue;
    }

    // Group by image repository
    for (const image of images) {
      const imageRepo = normalizeImageToCanonicalRepository(image);
      if (!imageRepo) {
        continue;
      }

      if (!imageRepoMap.has(imageRepo)) {
        imageRepoMap.set(imageRepo, {
          images: new Set(),
          issues: new Map(),
          resources: new Set(),
        });
      }

      const entry = imageRepoMap.get(imageRepo)!;
      entry.images.add(image);
      entry.resources.add(`${resource.kind}/${resource.namespace}/${resource.name}`);

      // Add issues for this image repository (normalize issue repo to canonical for match)
      for (const issue of imageIssues) {
        const issueImageRepo: string = issue.imageRepository ?? imageRepo;
        const issueRepoCanonical =
          normalizeImageToCanonicalRepository(issueImageRepo) ?? issueImageRepo;
        if (issueRepoCanonical === imageRepo && issue.id) {
          entry.issues.set(issue.id, {
            id: issue.id,
            title: issue.title,
            severity: issue.severity,
            imageId: issue.imageId,
          });
        }
      }
    }
  }

  // Convert to final format: one image per repo (latest tag) for display/query
  const result = new Map<string, ImageIssueGroup>();

  for (const [repo, entry] of imageRepoMap.entries()) {
    const allImages = Array.from(entry.images);
    const latestImage = pickLatestImageInRepo(allImages);
    result.set(repo, {
      imageRepository: repo,
      images: latestImage ? [latestImage] : allImages,
      issues: Array.from(entry.issues.values()),
      resources: Array.from(entry.resources).map(resourceStr => {
        const [kind, namespace, name] = resourceStr.split('/');
        return { kind, namespace, name };
      }),
    });
  }

  return result;
}

const ISSUE_SEVERITY_FIELD = 'issue.SeverityV2.Severity';

/** Common OpenSearch Issue fields returned for both misconfig and image issue queries */
const ISSUE_INCLUDE_FIELDS_BASE = [
  'issue.ResourceID',
  'issue.ID',
  ISSUE_SEVERITY_FIELD,
  'issue.Classification',
  'issue.Title',
  'issue.Summary',
  'issue.Type',
  'issue.Status',
] as const;

function pushSeverityFilterIfPresent(
  baseFilters: Array<Record<string, unknown>>,
  severityValues: string[]
): void {
  if (severityValues.length > 0) {
    baseFilters.push({
      terms: { [ISSUE_SEVERITY_FIELD]: [...severityValues] },
    });
  }
}

function buildImageIssueFilter(options: {
  cloudId: string;
  imageRepositories: string[];
  severityValues: string[];
  verbose: boolean;
}): string {
  if (options.verbose) {
    log('Building image issue filter with options:', options.imageRepositories);
  }

  const baseFilters: Array<Record<string, unknown>> = [
    { terms: { 'issue.ImageRepository': options.imageRepositories } },
    { terms: { 'issue.CloudID': [options.cloudId] } },
    { term: { 'issue.Type': IssueTypeEnum.Vulnerability } },
    { term: { 'issue.Status': 2 } },
  ];
  pushSeverityFilterIfPresent(baseFilters, options.severityValues);

  return JSON.stringify({
    bool: {
      filter: baseFilters,
    },
  });
}

export async function annotateIssuesFromOpenSearch(params: {
  client: ApiClient;
  cloudId: string;
  resources: ParsedResource[];
  severityFilters: IssueSeverityEnum[];
  verbose?: boolean;
}): Promise<void> {
  const verboseLogging = Boolean(params.verbose);
  core.info('═══ Annotating issues from OpenSearch ═══');
  core.info(`CloudID: ${params.cloudId}`);
  core.info(`Resources received: ${params.resources.length}`);

  const resourcesWithArn = params.resources.filter(resource => resource.arn);
  if (resourcesWithArn.length === 0) {
    core.warning('⚠️  No resource ARNs available for issue lookup (region/cluster may be missing)');
    return;
  }
  core.info(`Resources with ARN: ${resourcesWithArn.length}`);

  const arnToResource = new Map<string, ParsedResource>();
  const resourcesByKind = new Map<string, ParsedResource[]>();
  for (const resource of resourcesWithArn) {
    const arn = resource.arn!;
    arnToResource.set(arn, resource);
    const list = resourcesByKind.get(resource.kind) ?? [];
    list.push(resource);
    resourcesByKind.set(resource.kind, list);
  }

  const chunkSize = getResourceKindQueryBatch();
  const maxIssuesPerResource = getMaxIssuesPerResource();
  const severityValues =
    params.severityFilters.length > 0 ? params.severityFilters.map(sev => sev.toString()) : [];

  for (const [kind, resourcesOfKind] of Array.from(resourcesByKind.entries())) {
    const chunks = chunkArray(resourcesOfKind, chunkSize);
    for (const chunk of chunks) {
      const resourceArns = chunk
        .map((resource: ParsedResource) => resource.arn)
        .filter((arn): arn is string => Boolean(arn));
      if (resourceArns.length === 0) {
        continue;
      }

      const filterQuery = buildOpenSearchFilter({
        resourceType: `kubernetes:${kind}`,
        resourceArns,
        severityValues,
        cloudId: params.cloudId,
        verbose: verboseLogging,
      });

      const limit = Math.min(resourceArns.length * maxIssuesPerResource, 1000);

      try {
        core.info(`Querying OpenSearch for ${kind}:`);
        core.info(`  CloudID: ${params.cloudId}`);
        core.info(`  Resources: ${resourceArns.length}`);
        if (verboseLogging) core.info(`  FilterQuery: ${filterQuery.substring(0, 200)}...`);

        const response = await params.client.orgOpenSearchQuery({
          QueryID: OpenSearchNamedQueryEnum.Issue,
          FilterQuery: filterQuery,
          Limit: limit,
          IncludeFields: [...ISSUE_INCLUDE_FIELDS_BASE],
          Aggregations: 'default',
        });

        const issues = response.Issues ?? [];
        for (const issue of issues) {
          const resourceArn = issue.ResourceID;
          if (!resourceArn) {
            continue;
          }
          const resource = arnToResource.get(resourceArn);
          if (!resource) {
            continue;
          }
          if (!resource.issues) {
            resource.issues = [];
          }
          if (resource.issues.length >= maxIssuesPerResource) {
            continue;
          }

          const mapped = mapOpenSearchIssue(issue);
          if (mapped) {
            resource.issues.push(mapped);
          }
        }
        core.info(`✓ Annotated ${issues.length} issues for ${kind}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed OrgOpenSearchQuery for ${kind}: ${message}`);

        if (message.includes('no indices provided')) {
          core.warning(`CloudID "${params.cloudId}" may not exist or has no scan data.`);
          core.warning('Possible issues:');
          core.warning('  1. CloudID does not exist in the database for your organization');
          core.warning('  2. CloudID exists but has no completed scans (no CurrentBatchID)');
          core.warning('  3. CloudID format mismatch (should be the numeric cloud ID from secdi)');
          core.info('To fix: Ensure the cloud has been scanned at least once in secdi.');
        }
      }
    }
  }

  // Image issues: only for resources that have container images
  const hasContainerResources = params.resources.some(r => CONTAINER_RESOURCE_KINDS.has(r.kind));
  if (!hasContainerResources) return;

  core.info('═══ Checking for image issues in container resources ═══');
  const imageRepositories = extractImageRepositories(params.resources);
  if (verboseLogging) {
    core.info(`Image repositories in resources: ${Array.from(imageRepositories).join(', ')}`);
  }
  if (imageRepositories.size === 0) return;

  core.info(`Found ${imageRepositories.size} unique image repositories in resources`);
  const publicImages = await getPublicImages(params.client, params.cloudId, verboseLogging);
  if (verboseLogging) {
    core.info(`Public images from OpenSearch: ${Array.from(publicImages).join(', ')}`);
  }
  if (publicImages.size === 0) {
    core.info('No public images found in system, skipping image issue detection');
    return;
  }

  await annotateImageIssues({
    client: params.client,
    cloudId: params.cloudId,
    resources: params.resources,
    imageRepositories,
    publicImages,
    severityFilters: params.severityFilters,
    verbose: params.verbose,
  });
}

function buildOpenSearchFilter(options: {
  cloudId: string;
  resourceType: string;
  resourceArns: string[];
  severityValues: string[];
  verbose: boolean;
}): string {
  if (options.verbose) {
    log('Building OpenSearch filter with options:', options.resourceArns);
  }
  const baseFilters: Array<Record<string, unknown>> = [
    { term: { 'issue.Type': IssueTypeEnum.Misconfiguration } },
    { term: { 'issue.Status': 2 } },
    { term: { 'issue.ResourceType': options.resourceType } },
    { terms: { 'issue.ResourceID': options.resourceArns } },
    { terms: { 'issue.CloudID': [options.cloudId] } },
  ];
  pushSeverityFilterIfPresent(baseFilters, options.severityValues);

  if (options.verbose) {
    log('Base filters:', baseFilters);
  }

  return JSON.stringify({
    bool: {
      filter: baseFilters,
    },
  });
}

function mapOpenSearchIssue(
  issue: OpenSearchIssue,
  imageRepository?: string,
  imageId?: string
): ResourceIssue | null {
  if (!issue.ID) {
    return null;
  }

  const issueType = imageRepository ? 'Vulnerability' : 'Misconfiguration';

  const severityValue = issue.SeverityV2?.Severity;
  return {
    id: issue.ID,
    severity: severityToString(severityValue),
    severityValue,
    title: issue.Title,
    summary: issue.Summary,
    type: issueType,
    classification: classificationNames(issue.Classification),
    status: issue.Status !== undefined ? issue.Status.toString() : undefined,
    ...(imageRepository && { imageRepository }),
    ...(imageId != null && imageId !== '' && { imageId }),
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function classificationNames(classification?: number): string[] {
  if (!classification) {
    return [];
  }

  const labels: string[] = [];
  for (const [flagString, label] of Object.entries(vulnerabilityClassLabels)) {
    const flag = Number(flagString);
    if ((classification & flag) === flag) {
      labels.push(label);
    }
  }
  return labels;
}

const vulnerabilityClassLabels: Record<number, string> = {
  [VulnerabilityClassEnum.RemoteCodeExecution]: 'RemoteCodeExecution',
  [VulnerabilityClassEnum.PrivilegeEscalation]: 'PrivilegeEscalation',
  [VulnerabilityClassEnum.DenialOfService]: 'DenialOfService',
  [VulnerabilityClassEnum.CrossSiteRequestForgery]: 'CrossSiteRequestForgery',
  [VulnerabilityClassEnum.ServerSideRequestForgery]: 'ServerSideRequestForgery',
  [VulnerabilityClassEnum.PathTraversal]: 'PathTraversal',
  [VulnerabilityClassEnum.CrossSiteScripting]: 'CrossSiteScripting',
  [VulnerabilityClassEnum.SQLInjectionAttack]: 'SQLInjectionAttack',
  [VulnerabilityClassEnum.XEEInjection]: 'XEEInjection',
  [VulnerabilityClassEnum.InformationDisclosure]: 'InformationDisclosure',
  [VulnerabilityClassEnum.AuthenticationBypass]: 'AuthenticationBypass',
  [VulnerabilityClassEnum.NotDetermined]: 'NotDetermined',
};
