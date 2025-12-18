/**
 * Resource Parser - Unified resource processing module
 *
 * This module handles:
 * - Parsing Helm-rendered YAML input (parseHelmDryRunOutput)
 * - Parsing YAML manifests into resources (parseHelmManifest)
 * - Annotating resources with ARNs (annotateResourceArns)
 * - Resource utilities (grouping, filtering, summaries)
 */

import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import { DeploymentMetadata } from './deployment-metadata';

// ============================================================================
// Type Definitions
// ============================================================================

export interface HelmTemplateResult {
  manifestYaml: string;
  userSuppliedValues?: string;
  releaseName?: string;
  namespace?: string;
}

export interface K8sResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: unknown;
  data?: Record<string, string>;
}

export interface ParsedResource {
  kind: string;
  name: string;
  namespace: string;
  apiVersion: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  rawYaml: string;
  arn?: string;
  issues?: ResourceIssue[];
  metadata?: ResourceMetadata;
  data?: Record<string, string>; // ConfigMap data
}

export interface ResourceMetadata {
  // Core identifiers
  uid?: string;
  resourceVersion?: string;
  generation?: number;

  // Topology/Location metadata
  region?: string;
  zone?: string;
  cluster?: string;
  awsRegion?: string;
  accountId?: string;

  // Container metadata
  images?: string[];
  containerNames?: string[];

  // Deployment/workload metadata
  replicas?: number;

  // Service metadata
  serviceType?: string;
  serviceName?: string;
  loadBalancerClass?: string;

  // Ingress metadata
  ingressClass?: string;

  // Storage metadata
  storageClass?: string;

  // References to other resources
  configMapRefs?: string[];
  secretRefs?: string[];
  volumeClaims?: string[];
  referencedArns?: string[];

  // Ownership and relationships
  ownerReferences?: Array<{
    kind: string;
    name: string;
    uid: string;
  }>;

  // Selector (for matching pods, etc.)
  selector?: Record<string, string>;
}

export interface ResourceIssue {
  id: string;
  severity?: string;
  severityValue?: number;
  title?: string;
  summary?: string;
  type?: string;
  classification?: string[];
  status?: string;
}

// ============================================================================
// Helm YAML Parsing
// ============================================================================

/**
 * Parse YAML format input from helm template output
 * Accepts one or more YAML documents separated by ---
 * Normalizes and returns a single YAML string for downstream processing
 */
export function parseHelmDryRunOutput(input: string): HelmTemplateResult {
  if (!input || input.trim() === '') {
    throw new Error('Input is empty');
  }

  try {
    const docs = yaml.loadAll(input);
    const validResources = docs.filter(
      doc => doc && typeof doc === 'object' && 'kind' in doc && 'apiVersion' in doc
    ) as Array<Record<string, unknown>>;

    if (validResources.length === 0) {
      throw new Error(
        'No valid Kubernetes resources found. Each resource must have "kind" and "apiVersion" fields'
      );
    }

    core.info(`✓ Parsed ${validResources.length} Kubernetes resources from YAML input`);
    const manifestYaml = validResources.map(resource => yaml.dump(resource)).join('\n---\n');

    return {
      manifestYaml,
      userSuppliedValues: undefined,
      releaseName: undefined,
      namespace: undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML input: ${message}`);
  }
}

function getStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

// ============================================================================
// YAML Manifest Parsing
// ============================================================================

/**
 * Parse Helm template output (which contains multiple YAML documents) into individual resources
 */
export function parseHelmManifest(manifestYaml: string): ParsedResource[] {
  const resources: ParsedResource[] = [];

  try {
    // Split by YAML document separator
    const documents = manifestYaml.split(/^---$/m).filter(doc => doc.trim() !== '');

    core.info(`Found ${documents.length} YAML documents in manifest`);

    for (const doc of documents) {
      try {
        const parsed = yaml.load(doc) as K8sResource;

        // Skip empty documents or documents without required fields
        if (!parsed || !parsed.kind || !parsed.metadata?.name) {
          continue;
        }

        const resource: ParsedResource = {
          kind: parsed.kind,
          name: parsed.metadata.name,
          namespace: parsed.metadata.namespace || 'default',
          apiVersion: parsed.apiVersion || '',
          labels: parsed.metadata.labels || {},
          annotations: parsed.metadata.annotations || {},
          rawYaml: doc,
          // Extract comprehensive metadata
          metadata: extractResourceMetadata(parsed),
          // Include ConfigMap data for metadata extraction
          data: parsed.data,
        };

        resources.push(resource);
        core.debug(
          `Parsed resource: ${resource.kind}/${resource.name} in namespace ${resource.namespace}`
        );
      } catch (docError) {
        core.warning(
          `Failed to parse YAML document: ${docError instanceof Error ? docError.message : String(docError)}`
        );
        continue;
      }
    }

    core.info(`Successfully parsed ${resources.length} Kubernetes resources`);
    return resources;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse Helm manifest: ${message}`);
  }
}

/**
 * Extract comprehensive metadata from a Kubernetes resource
 */
function extractResourceMetadata(resource: K8sResource): ResourceMetadata {
  const metadata: ResourceMetadata = {};

  try {
    const spec = resource.spec as Record<string, unknown>;
    const resMetadata = resource.metadata as Record<string, unknown>;

    // Extract core metadata
    if (resMetadata.uid) metadata.uid = resMetadata.uid as string;
    if (resMetadata.resourceVersion) {
      metadata.resourceVersion = resMetadata.resourceVersion as string;
    }
    if (resMetadata.generation) {
      metadata.generation = resMetadata.generation as number;
    }

    // Extract topology/location from labels
    if (resMetadata.labels) {
      const labelRecord = resMetadata.labels as Record<string, unknown>;
      // Region
      metadata.region =
        getStringValue(labelRecord, 'topology.kubernetes.io/region') ||
        getStringValue(labelRecord, 'failure-domain.beta.kubernetes.io/region');

      // Zone
      metadata.zone =
        getStringValue(labelRecord, 'topology.kubernetes.io/zone') ||
        getStringValue(labelRecord, 'failure-domain.beta.kubernetes.io/zone');

      // Cluster
      metadata.cluster =
        getStringValue(labelRecord, 'cluster') ||
        getStringValue(labelRecord, 'eks.amazonaws.com/cluster') ||
        getStringValue(labelRecord, 'eks.amazonaws.com/cluster-name');

      // Extract region from zone if not already set
      if (!metadata.region && metadata.zone) {
        // Match AWS zone format: region (e.g., us-east-1) + zone letter (a-z)
        const zoneMatch = (metadata.zone as string).match(/^([a-z]{2}-[a-z]+-\d+)[a-z]$/);
        if (zoneMatch) {
          metadata.region = zoneMatch[1];
        }
      }
    }

    // Extract AWS-specific metadata from annotations
    if (resMetadata.annotations) {
      const annotationRecord = resMetadata.annotations as Record<string, unknown>;
      metadata.awsRegion = getStringValue(annotationRecord, 'aws.amazon.com/region');
      metadata.accountId = getStringValue(annotationRecord, 'aws.amazon.com/account-id');

      const eksCluster = getStringValue(annotationRecord, 'eks.amazonaws.com/cluster-name');
      if (eksCluster) {
        metadata.cluster = eksCluster;
      }

      // Extract ARNs from annotations
      const arnMatches = extractArnsFromText(JSON.stringify(resMetadata.annotations));
      if (arnMatches.length > 0) {
        metadata.referencedArns = arnMatches;
      }
    }

    // Extract container and image metadata
    const containerData = extractContainerData(spec);
    metadata.images = containerData.images; // Always set, even if empty array
    metadata.containerNames = containerData.names; // Always set, even if empty array

    // Extract service metadata
    if (resource.kind === 'Service' && spec) {
      metadata.serviceType = spec.type as string;
      metadata.serviceName = resMetadata.name as string;
      const serviceSpec = spec as { type?: string; loadBalancerClass?: string };
      metadata.serviceType = serviceSpec.type;
      metadata.serviceName = resMetadata.name as string;
      if (serviceSpec.loadBalancerClass) {
        metadata.loadBalancerClass = serviceSpec.loadBalancerClass;
      }
    }

    // Extract ingress metadata
    if (resource.kind === 'Ingress' && resMetadata.annotations) {
      const annotationRecord = resMetadata.annotations as Record<string, unknown>;
      metadata.ingressClass =
        getStringValue(annotationRecord, 'kubernetes.io/ingress.class') ||
        getStringValue(annotationRecord, 'ingressClassName');
    }

    // Extract storage metadata
    if (resource.kind === 'PersistentVolumeClaim' && spec) {
      metadata.storageClass = (spec as { storageClassName?: string }).storageClassName;
    }

    // Extract volume claims
    const volumeClaims = extractVolumeClaims(spec);
    if (volumeClaims.length > 0) metadata.volumeClaims = volumeClaims;

    // Extract ConfigMap and Secret references
    const refs = extractConfigMapSecretRefs(spec);
    if (refs.configMaps.length > 0) metadata.configMapRefs = refs.configMaps;
    if (refs.secrets.length > 0) metadata.secretRefs = refs.secrets;

    // Extract owner references
    if (resMetadata.ownerReferences) {
      metadata.ownerReferences = (
        resMetadata.ownerReferences as Array<Record<string, unknown>>
      ).map(ref => ({
        kind: ref.kind as string,
        name: ref.name as string,
        uid: ref.uid as string,
      }));
    }

    // Extract replicas
    if (spec && typeof spec.replicas === 'number') {
      metadata.replicas = spec.replicas;
    }

    // Extract selector
    if (spec && spec.selector && typeof spec.selector === 'object') {
      const selectorRecord = (spec.selector as { matchLabels?: Record<string, string> })
        ?.matchLabels;
      if (selectorRecord) {
        metadata.selector = selectorRecord;
      }
    }

    // Extract additional ARNs from environment variables
    const envArns = extractArnsFromEnvVars(spec);
    if (envArns.length > 0) {
      metadata.referencedArns = [...(metadata.referencedArns || []), ...envArns];
      metadata.referencedArns = Array.from(new Set(metadata.referencedArns)); // Remove duplicates
    }

    // Try to extract account ID from any ARNs we found
    if (metadata.referencedArns && metadata.referencedArns.length > 0) {
      const accountIds = extractAccountIdsFromArns(metadata.referencedArns);
      if (accountIds.length > 0 && !metadata.accountId) {
        metadata.accountId = accountIds[0]; // Use first found account ID
      }
    }
  } catch (error) {
    core.debug(
      `Failed to extract metadata from ${resource.kind}/${resource.metadata.name}: ${error}`
    );
  }

  return metadata;
}

/**
 * Extract container images and names from resource spec
 */
function extractContainerData(spec: Record<string, unknown>): {
  images: string[];
  names: string[];
} {
  const images: string[] = [];
  const names: string[] = [];

  try {
    // For Deployment, StatefulSet, DaemonSet, Job, CronJob
    const templateSpec = (spec?.template as Record<string, unknown>)?.spec as Record<
      string,
      unknown
    >;
    if (templateSpec) {
      const containers = (templateSpec.containers || []) as Array<Record<string, unknown>>;
      const initContainers = (templateSpec.initContainers || []) as Array<Record<string, unknown>>;

      for (const container of [...containers, ...initContainers]) {
        if (container.image) images.push(container.image as string);
        if (container.name) names.push(container.name as string);
      }
    }

    // For Pod
    if (spec && !templateSpec) {
      const containers = (spec.containers || []) as Array<Record<string, unknown>>;
      const initContainers = (spec.initContainers || []) as Array<Record<string, unknown>>;

      for (const container of [...containers, ...initContainers]) {
        if (container.image) images.push(container.image as string);
        if (container.name) names.push(container.name as string);
      }
    }
  } catch (error) {
    core.debug(`Failed to extract container data: ${error}`);
  }

  return {
    images: Array.from(new Set(images)),
    names: Array.from(new Set(names)),
  };
}

/**
 * Extract volume claim references
 */
function extractVolumeClaims(spec: Record<string, unknown>): string[] {
  const claims: string[] = [];

  try {
    const templateSpec = ((spec?.template as Record<string, unknown>)?.spec || spec) as Record<
      string,
      unknown
    >;
    if (templateSpec && templateSpec.volumes) {
      for (const volume of templateSpec.volumes as Array<Record<string, unknown>>) {
        if ((volume.persistentVolumeClaim as Record<string, unknown>)?.claimName) {
          claims.push(
            (volume.persistentVolumeClaim as Record<string, unknown>).claimName as string
          );
        }
      }
    }

    // For StatefulSet volumeClaimTemplates
    if (spec?.volumeClaimTemplates) {
      for (const template of spec.volumeClaimTemplates as Array<Record<string, unknown>>) {
        if ((template.metadata as Record<string, unknown>)?.name) {
          claims.push((template.metadata as Record<string, unknown>).name as string);
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to extract volume claims: ${error}`);
  }

  return Array.from(new Set(claims));
}

/**
 * Extract ConfigMap and Secret references from resource spec
 */
function extractConfigMapSecretRefs(spec: Record<string, unknown>): {
  configMaps: string[];
  secrets: string[];
} {
  const configMaps: string[] = [];
  const secrets: string[] = [];

  try {
    const templateSpec = ((spec?.template as Record<string, unknown>)?.spec || spec) as Record<
      string,
      unknown
    >;

    // From volumes
    if (templateSpec && templateSpec.volumes) {
      for (const volume of templateSpec.volumes as Array<Record<string, unknown>>) {
        if ((volume.configMap as Record<string, unknown>)?.name)
          configMaps.push((volume.configMap as Record<string, unknown>).name as string);
        if ((volume.secret as Record<string, unknown>)?.secretName)
          secrets.push((volume.secret as Record<string, unknown>).secretName as string);
      }
    }

    // From env and envFrom
    if (templateSpec && templateSpec.containers) {
      for (const container of templateSpec.containers as Array<Record<string, unknown>>) {
        // From env
        if (container.env) {
          for (const envVar of container.env as Array<Record<string, unknown>>) {
            if (
              (
                (envVar.valueFrom as Record<string, unknown>)?.configMapKeyRef as Record<
                  string,
                  unknown
                >
              )?.name
            ) {
              configMaps.push(
                (
                  (envVar.valueFrom as Record<string, unknown>).configMapKeyRef as Record<
                    string,
                    unknown
                  >
                ).name as string
              );
            }
            if (
              (
                (envVar.valueFrom as Record<string, unknown>)?.secretKeyRef as Record<
                  string,
                  unknown
                >
              )?.name
            ) {
              secrets.push(
                (
                  (envVar.valueFrom as Record<string, unknown>).secretKeyRef as Record<
                    string,
                    unknown
                  >
                ).name as string
              );
            }
          }
        }

        // From envFrom
        if (container.envFrom) {
          for (const envFrom of container.envFrom as Array<Record<string, unknown>>) {
            if ((envFrom.configMapRef as Record<string, unknown>)?.name)
              configMaps.push((envFrom.configMapRef as Record<string, unknown>).name as string);
            if ((envFrom.secretRef as Record<string, unknown>)?.name)
              secrets.push((envFrom.secretRef as Record<string, unknown>).name as string);
          }
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to extract ConfigMap/Secret refs: ${error}`);
  }

  return {
    configMaps: Array.from(new Set(configMaps)),
    secrets: Array.from(new Set(secrets)),
  };
}

/**
 * Extract ARNs from environment variables
 */
function extractArnsFromEnvVars(spec: Record<string, unknown>): string[] {
  const arns: string[] = [];

  try {
    const templateSpec = ((spec?.template as Record<string, unknown>)?.spec || spec) as Record<
      string,
      unknown
    >;

    if (templateSpec && templateSpec.containers) {
      for (const container of templateSpec.containers as Array<Record<string, unknown>>) {
        if (container.env) {
          for (const envVar of container.env as Array<Record<string, unknown>>) {
            if (envVar.value && typeof envVar.value === 'string') {
              const foundArns = extractArnsFromText(envVar.value);
              arns.push(...foundArns);
            }
          }
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to extract ARNs from env vars: ${error}`);
  }

  return Array.from(new Set(arns));
}

/**
 * Extract AWS ARNs from text using regex
 * Handles both standard ARNs with account IDs and S3-style ARNs without account IDs
 */
function extractArnsFromText(text: string): string[] {
  // Account ID is optional (e.g., S3: arn:aws:s3:::bucket/path)
  // Also allow * for wildcards (e.g., arn:aws:s3:::bucket/*)
  const arnPattern = /arn:aws:[\w-]+:[\w-]*:(?:\d{12})?:[\w\-\/:.*]+/g;
  const matches = text.match(arnPattern);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Extract AWS account IDs from ARNs
 */
function extractAccountIdsFromArns(arns: string[]): string[] {
  const accountIds: string[] = [];

  for (const arn of arns) {
    const match = arn.match(/arn:aws:[\w-]+:[\w-]*:(\d{12}):/);
    if (match) {
      accountIds.push(match[1]);
    }
  }

  return Array.from(new Set(accountIds));
}

/**
 * Group resources by kind for easier processing
 */
export function groupResourcesByKind(resources: ParsedResource[]): Map<string, ParsedResource[]> {
  const grouped = new Map<string, ParsedResource[]>();

  for (const resource of resources) {
    const existing = grouped.get(resource.kind) || [];
    existing.push(resource);
    grouped.set(resource.kind, existing);
  }

  return grouped;
}

/**
 * Get a unique identifier for a resource
 */
export function getResourceIdentifier(resource: ParsedResource): string {
  return `${resource.kind}/${resource.namespace}/${resource.name}`;
}

/**
 * Filter resources by kind (useful for focusing on specific resource types)
 */
export function filterResourcesByKind(
  resources: ParsedResource[],
  kinds: string[]
): ParsedResource[] {
  return resources.filter(resource => kinds.includes(resource.kind));
}

/**
 * Get resource summary statistics
 */
export function getResourceSummary(resources: ParsedResource[]): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const resource of resources) {
    summary[resource.kind] = (summary[resource.kind] || 0) + 1;
  }

  return summary;
}

/**
 * Extract container images from Deployment, StatefulSet, DaemonSet, Pod resources
 */
export function extractContainerImages(resource: ParsedResource): string[] {
  try {
    const parsed = yaml.load(resource.rawYaml) as {
      spec?: {
        template?: {
          spec?: {
            containers?: Array<{ image?: string }>;
            initContainers?: Array<{ image?: string }>;
          };
        };
        containers?: Array<{ image?: string }>;
        initContainers?: Array<{ image?: string }>;
      };
    };

    const images: string[] = [];

    // For Deployment, StatefulSet, DaemonSet, Job, CronJob
    const templateSpec = parsed.spec?.template?.spec;
    if (templateSpec) {
      const containers = templateSpec.containers || [];
      const initContainers = templateSpec.initContainers || [];
      images.push(...(containers.map(c => c.image).filter(Boolean) as string[]));
      images.push(...(initContainers.map(c => c.image).filter(Boolean) as string[]));
    }

    // For Pod
    const podSpec = parsed.spec;
    if (podSpec && !templateSpec) {
      const containers = podSpec.containers || [];
      const initContainers = podSpec.initContainers || [];
      images.push(...(containers.map(c => c.image).filter(Boolean) as string[]));
      images.push(...(initContainers.map(c => c.image).filter(Boolean) as string[]));
    }

    return Array.from(new Set(images)); // Remove duplicates
  } catch (error) {
    core.debug(`Failed to extract images from ${resource.kind}/${resource.name}: ${error}`);
    return [];
  }
}

// ============================================================================
// ARN Annotation
// ============================================================================

/**
 * Annotate resources with ARNs based on deployment metadata
 */
export function annotateResourceArns(
  resources: ParsedResource[],
  metadata: DeploymentMetadata | null
): void {
  core.info(`Annotating ARNs for ${resources.length} resources`);
  core.info(`Metadata: region=${metadata?.region}, cluster=${metadata?.cluster}`);

  if (!metadata?.region || !metadata?.cluster) {
    core.warning('Cannot generate ARNs: missing region or cluster in metadata');
    return;
  }

  let annotatedCount = 0;
  for (const resource of resources) {
    resource.arn = buildResourceArn(metadata.region, metadata.cluster, resource);
    annotatedCount++;
  }

  core.info(`✓ Annotated ${annotatedCount} resources with ARNs`);
  if (resources.length > 0) {
    core.info(`Sample ARN: ${resources[0].arn}`);
  }
}

function buildResourceArn(region: string, cluster: string, resource: ParsedResource): string {
  const namespace = resource.namespace || 'default';
  return `${region}:${cluster}:${namespace}:${resource.kind}:${resource.name}`;
}

/**
 * Log resource metadata summary
 */
export function logResourceMetadataSummary(resources: ParsedResource[]): void {
  core.info('\n═══ Resource Metadata Summary ═══');
  core.info(`Total resources: ${resources.length}`);

  const summary = getResourceSummary(resources);
  core.info('Resource types:');
  for (const [kind, count] of Object.entries(summary)) {
    core.info(`  - ${kind}: ${count}`);
  }

  core.info('═════════════════════════════════\n');
}
