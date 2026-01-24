import * as core from '@actions/core';
import { log } from 'node:console';
import {
  ApiClient,
  IssueSeverityEnum,
  IssueTypeEnum,
  OpenSearchIssue,
  OpenSearchNamedQueryEnum,
  VulnerabilityClassEnum,
} from '@averlon/shared';
import { ParsedResource, ResourceIssue } from './resource-parser';

/**
 * Extended OpenSearchIssue that may include ImageRepository field
 * when querying for image-related issues
 */
interface OpenSearchIssueWithImage extends OpenSearchIssue {
  ImageRepository?: string;
  imageRepository?: string;
}

/**
 * OpenSearch response for Asset queries
 * The response structure for Asset queries differs from Issue queries
 */
interface OpenSearchAssetResponse {
  Assets?: Array<{ RepositoryName?: string }>;
}

/** Resource kinds that can have container images */
const CONTAINER_RESOURCE_KINDS = new Set([
  'Pod',
  'Deployment',
  'DaemonSet',
  'StatefulSet',
  'Job',
  'CronJob',
]);

/**
 * Normalize an image string to its repository name by stripping tag/digest
 * Examples:
 * - nginx:1.19 -> nginx
 * - ghcr.io/org/repo:latest -> ghcr.io/org/repo
 * - 123456.dkr.ecr.us-west-2.amazonaws.com/my-app@sha256:abc -> 123456.dkr.ecr.us-west-2.amazonaws.com/my-app
 */
function normalizeImageToRepository(image: string): string | null {
  if (!image || image.trim() === '') {
    return null;
  }
  const repo = image.split(':')[0].split('@')[0];
  return repo && repo.trim() !== '' ? repo : null;
}

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
      const repo = normalizeImageToRepository(image);
      if (repo) {
        imageRepos.add(repo);
      }
    }
  }

  return imageRepos;
}

/**
 * Query OpenSearch for public images
 */
async function getPublicImages(
  client: ApiClient,
  cloudId: string,
  verbose: boolean
): Promise<Set<string>> {
  const publicImages = new Set<string>();

  try {
    const filterQuery = JSON.stringify({
      bool: {
        filter: [{ term: { 'image.IsPublic': true } }],
      },
    });

    if (verbose) {
      core.info('Querying OpenSearch for public images');
      core.info(`  CloudID: ${cloudId}`);
      core.info(`  FilterQuery: ${filterQuery}`);
    }

    const response = (await client.orgOpenSearchQuery({
      CloudIDs: [cloudId],
      QueryID: OpenSearchNamedQueryEnum.Image,
      FilterQuery: filterQuery,
      Limit: 10000, // Large limit to get all public images
      IncludeFields: ['image.RepositoryName'],
    })) as unknown as OpenSearchAssetResponse;

    if (verbose) {
      core.debug(`OpenSearch response for public images: ${JSON.stringify(response, null, 2)}`);
    }

    // Extract repository names from response
    if (response && typeof response === 'object' && response.Assets) {
      for (const asset of response.Assets) {
        if (asset?.RepositoryName) {
          publicImages.add(asset.RepositoryName);
        }
      }
    }

    core.info(`✓ Found ${publicImages.size} public image repositories`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to query public images: ${message}`);
    // Don't throw - continue without image issue detection
  }

  return publicImages;
}

/**
 * Query OpenSearch for image issues and attach them to resources
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
  const verboseLogging = Boolean(params.verbose);

  // Filter to only public image repositories
  const publicImageRepos = Array.from(params.imageRepositories).filter(repo =>
    params.publicImages.has(repo)
  );

  if (publicImageRepos.length === 0) {
    if (verboseLogging) {
      core.info('No public image repositories found in resources');
    }
    return;
  }

  core.info(`Found ${publicImageRepos.length} public image repositories to check for issues`);

  // Create mapping from image repository to resources that use it
  const imageRepoToResources = new Map<string, ParsedResource[]>();

  for (const resource of params.resources) {
    if (!CONTAINER_RESOURCE_KINDS.has(resource.kind)) {
      continue;
    }

    const images = resource.metadata?.images || [];
    for (const image of images) {
      const repo = normalizeImageToRepository(image);
      if (repo && params.publicImages.has(repo)) {
        const resourcesList = imageRepoToResources.get(repo) || [];
        resourcesList.push(resource);
        imageRepoToResources.set(repo, resourcesList);
      }
    }
  }

  // Batch image repositories for querying
  const chunkSize = Number(process.env['IMAGE_REPOSITORY_QUERY_BATCH'] ?? 50);
  const maxIssuesPerResource = Number(process.env['MAX_ISSUES_PER_RESOURCE'] ?? 50);
  const severityValues =
    params.severityFilters.length > 0 ? params.severityFilters.map(sev => sev.toString()) : [];

  const chunks = chunkArray(publicImageRepos, chunkSize);

  for (const chunk of chunks) {
    if (chunk.length === 0) {
      continue;
    }

    const filterQuery = buildImageIssueFilter({
      cloudId: params.cloudId,
      imageRepositories: chunk,
      severityValues,
      verbose: verboseLogging,
    });

    const limit = Math.min(chunk.length * maxIssuesPerResource, 1000);

    try {
      if (verboseLogging) {
        core.info(`Querying OpenSearch for image issues:`);
        core.info(`  CloudID: ${params.cloudId}`);
        core.info(`  Image Repositories: ${chunk.length}`);
        core.info(`  FilterQuery: ${filterQuery.substring(0, 200)}...`);
      } else {
        core.info(`Querying image issues for ${chunk.length} repositories`);
      }

      const response = await params.client.orgOpenSearchQuery({
        CloudIDs: [params.cloudId],
        QueryID: OpenSearchNamedQueryEnum.Issue,
        FilterQuery: filterQuery,
        Limit: limit,
        IncludeFields: [
          'issue.ImageRepository',
          'issue.ID',
          'issue.Severity',
          'issue.Classification',
          'issue.Title',
          'issue.Summary',
          'issue.Type',
          'issue.Status',
        ],
        Aggregations: 'default',
      });

      const issues = response.Issues ?? [];
      for (const issue of issues) {
        // Get image repository from issue
        // ImageRepository is included in IncludeFields, so it should be available
        const issueWithImage = issue as OpenSearchIssueWithImage;
        const imageRepo = issueWithImage.ImageRepository || issueWithImage.imageRepository;
        if (!imageRepo || typeof imageRepo !== 'string') {
          continue;
        }

        // Find all resources using this image repository
        const resourcesUsingImage = imageRepoToResources.get(imageRepo) || [];
        for (const resource of resourcesUsingImage) {
          if (!resource.issues) {
            resource.issues = [];
          }
          if (resource.issues.length >= maxIssuesPerResource) {
            continue;
          }

          const mapped = mapOpenSearchIssue(issue, imageRepo);
          if (mapped) {
            resource.issues.push(mapped);
          }
        }
      }

      if (verboseLogging) {
        core.info(
          `✓ Retrieved and annotated image issues: ${issues.length} issues found for ${chunk.length} repositories`
        );
      } else {
        core.info(`✓ Annotated ${issues.length} image issues`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed OrgOpenSearchQuery for image issues: ${message}`);

      if (message.includes('no indices provided')) {
        core.warning(`CloudID "${params.cloudId}" may not exist or has no scan data.`);
      }
    }
  }
}

/** Result type for image issues grouped by repository */
export interface ImageIssueGroup {
  imageRepository: string;
  images: string[];
  issues: Array<{ id: string; title?: string; severity?: string }>;
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
      issues: Map<string, { id: string; title?: string; severity?: string }>;
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
      const imageRepo = normalizeImageToRepository(image);
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

      // Add issues for this image repository
      for (const issue of imageIssues) {
        const issueImageRepo: string = issue.imageRepository ?? imageRepo;
        if (issueImageRepo === imageRepo && issue.id) {
          entry.issues.set(issue.id, {
            id: issue.id,
            title: issue.title,
            severity: issue.severity,
          });
        }
      }
    }
  }

  // Convert to final format
  const result = new Map<string, ImageIssueGroup>();

  for (const [repo, entry] of imageRepoMap.entries()) {
    result.set(repo, {
      imageRepository: repo,
      images: Array.from(entry.images).sort(),
      issues: Array.from(entry.issues.values()),
      resources: Array.from(entry.resources).map(resourceStr => {
        const [kind, namespace, name] = resourceStr.split('/');
        return { kind, namespace, name };
      }),
    });
  }

  return result;
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
  ];

  // If severity filters are provided, add them to the base filters
  if (options.severityValues.length > 0) {
    baseFilters.push({
      terms: {
        'issue.Severity': [...options.severityValues],
      },
    });
  }

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
  core.info(`═══ Inside annotateIssuesFromOpenSearch ═══`);
  core.info(`CloudId: ${params.cloudId}`);
  core.info(`Resources received: ${params.resources.length}`);
  if (verboseLogging) {
    core.info(`Type of params.resources: ${typeof params.resources}`);
    core.info(`Is array: ${Array.isArray(params.resources)}`);

    if (params.resources.length > 0) {
      const first = params.resources[0];
      core.info(`First resource type: ${typeof first}`);
      core.info(`First resource keys: ${Object.keys(first).join(', ')}`);
      core.info(`First resource: ${JSON.stringify(first, null, 2)}`);
    }
  }

  const resourcesWithArn = params.resources.filter(resource => resource.arn);
  core.info(`Filtered resources with ARN: ${resourcesWithArn.length}`);

  if (resourcesWithArn.length === 0) {
    core.warning('⚠️  No resource ARNs available for issue lookup');
    core.warning('This usually means region/cluster were not provided');
    return;
  }

  const arnToResource = new Map<string, ParsedResource>();
  const resourcesByKind = new Map<string, ParsedResource[]>();
  for (const resource of resourcesWithArn) {
    const arn = resource.arn!;
    arnToResource.set(arn, resource);
    const list = resourcesByKind.get(resource.kind) ?? [];
    list.push(resource);
    resourcesByKind.set(resource.kind, list);
  }

  const chunkSize = Number(process.env['RESOURCE_KIND_QUERY_BATCH'] ?? 50);
  const maxIssuesPerResource = Number(process.env['MAX_ISSUES_PER_RESOURCE'] ?? 50);
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
        if (verboseLogging) {
          core.info(`  FilterQuery: ${filterQuery.substring(0, 200)}...`);
        }

        if (verboseLogging) {
          log(
            `Executing OrgOpenSearchQuery for ${kind} with ${resourceArns.length} resources`,
            params.cloudId,
            filterQuery
          );
        }
        const response = await params.client.orgOpenSearchQuery({
          CloudIDs: [params.cloudId],
          QueryID: OpenSearchNamedQueryEnum.Issue,
          FilterQuery: filterQuery,
          Limit: limit,
          IncludeFields: [
            'issue.ResourceID',
            'issue.ID',
            'issue.Severity',
            'issue.Classification',
            'issue.Title',
            'issue.Summary',
            'issue.Type',
            'issue.Status',
          ],
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
        if (verboseLogging) {
          log(
            `✓ Retrieved and annotated issues for ${kind}: ${issues.length} issues found`,
            response
          );
        } else {
          core.info(`✓ Annotated ${issues.length} issues for ${kind}`);
        }
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

  // Step 2: Query for image issues if there are container resources
  const hasContainerResources = params.resources.some(resource =>
    CONTAINER_RESOURCE_KINDS.has(resource.kind)
  );

  if (hasContainerResources) {
    core.info('═══ Checking for image issues in container resources ═══');

    // Extract image repositories from resources
    const imageRepositories = extractImageRepositories(params.resources);
    if (imageRepositories.size > 0) {
      core.info(`Found ${imageRepositories.size} unique image repositories in resources`);

      // Query for public images
      const publicImages = await getPublicImages(params.client, params.cloudId, verboseLogging);

      if (publicImages.size > 0) {
        // Query for image issues and attach to resources
        await annotateImageIssues({
          client: params.client,
          cloudId: params.cloudId,
          resources: params.resources,
          imageRepositories,
          publicImages,
          severityFilters: params.severityFilters,
          verbose: params.verbose,
        });
      } else {
        core.info('No public images found in system, skipping image issue detection');
      }
    } else {
      if (verboseLogging) {
        core.info('No image repositories found in container resources');
      }
    }
  }
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

  // If severity filters are provided, add them to the base filters
  if (options.severityValues.length > 0) {
    baseFilters.push({
      terms: {
        'issue.Severity': [...options.severityValues],
      },
    });
  }

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
  imageRepository?: string
): ResourceIssue | null {
  if (!issue.ID) {
    return null;
  }

  const issueType = imageRepository ? 'Vulnerability' : 'Misconfiguration';

  return {
    id: issue.ID,
    severity: severityToString(issue.Severity),
    severityValue: issue.Severity,
    title: issue.Title,
    summary: issue.Summary,
    type: issueType,
    classification: classificationNames(issue.Classification),
    status: issue.Status !== undefined ? issue.Status.toString() : undefined,
    ...(imageRepository && { imageRepository }), // Add imageRepository if provided
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
