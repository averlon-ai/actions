import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import { DeploymentMetadata } from './deployment-metadata';

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
  resourceId?: string;
  issues?: ResourceIssue[];
  metadata?: ResourceMetadata;
  data?: Record<string, string>;
}

export interface ResourceMetadata {
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  region?: string;
  zone?: string;
  cluster?: string;
  awsRegion?: string;
  accountId?: string;
  images?: string[];
  containerNames?: string[];
  replicas?: number;
  serviceType?: string;
  serviceName?: string;
  loadBalancerClass?: string;
  ingressClass?: string;
  storageClass?: string;
  configMapRefs?: string[];
  secretRefs?: string[];
  volumeClaims?: string[];
  referencedResourceIds?: string[];
  ownerReferences?: Array<{ kind: string; name: string; uid: string }>;
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
  imageRepository?: string; // For image/CVE issues, indicates which image repository the issue belongs to
  imageId?: string; // For image/CVE issues, the image asset ID from the backend
}

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

export function parseHelmManifest(manifestYaml: string): ParsedResource[] {
  const resources: ParsedResource[] = [];

  try {
    const documents = manifestYaml.split(/^---$/m).filter(doc => doc.trim() !== '');
    core.info(`Found ${documents.length} YAML documents in manifest`);

    for (const doc of documents) {
      try {
        const parsed = yaml.load(doc) as K8sResource;

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
          metadata: extractResourceMetadata(parsed),
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

function extractResourceMetadata(resource: K8sResource): ResourceMetadata {
  const metadata: ResourceMetadata = {};

  try {
    const spec = resource.spec as Record<string, unknown>;
    const resMetadata = resource.metadata as Record<string, unknown>;

    if (resMetadata.uid) metadata.uid = resMetadata.uid as string;
    if (resMetadata.resourceVersion) {
      metadata.resourceVersion = resMetadata.resourceVersion as string;
    }
    if (resMetadata.generation) {
      metadata.generation = resMetadata.generation as number;
    }

    if (resMetadata.labels) {
      const labelRecord = resMetadata.labels as Record<string, unknown>;
      metadata.region =
        getStringValue(labelRecord, 'topology.kubernetes.io/region') ||
        getStringValue(labelRecord, 'failure-domain.beta.kubernetes.io/region');
      metadata.zone =
        getStringValue(labelRecord, 'topology.kubernetes.io/zone') ||
        getStringValue(labelRecord, 'failure-domain.beta.kubernetes.io/zone');
      metadata.cluster =
        getStringValue(labelRecord, 'cluster') ||
        getStringValue(labelRecord, 'eks.amazonaws.com/cluster') ||
        getStringValue(labelRecord, 'eks.amazonaws.com/cluster-name');
      if (!metadata.region && metadata.zone) {
        const zoneMatch = (metadata.zone as string).match(/^([a-z]{2}-[a-z]+-\d+)[a-z]$/);
        if (zoneMatch) {
          metadata.region = zoneMatch[1];
        }
      }
    }

    if (resMetadata.annotations) {
      const annotationRecord = resMetadata.annotations as Record<string, unknown>;
      metadata.awsRegion = getStringValue(annotationRecord, 'aws.amazon.com/region');
      metadata.accountId = getStringValue(annotationRecord, 'aws.amazon.com/account-id');

      const eksCluster = getStringValue(annotationRecord, 'eks.amazonaws.com/cluster-name');
      if (eksCluster) {
        metadata.cluster = eksCluster;
      }

      const awsArnMatches = extractAwsArnStringsFromText(JSON.stringify(resMetadata.annotations));
      if (awsArnMatches.length > 0) {
        metadata.referencedResourceIds = awsArnMatches;
      }
    }

    const containerData = extractContainerData(spec);
    metadata.images = containerData.images;
    metadata.containerNames = containerData.names;

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

    if (resource.kind === 'Ingress' && resMetadata.annotations) {
      const annotationRecord = resMetadata.annotations as Record<string, unknown>;
      metadata.ingressClass =
        getStringValue(annotationRecord, 'kubernetes.io/ingress.class') ||
        getStringValue(annotationRecord, 'ingressClassName');
    }

    if (resource.kind === 'PersistentVolumeClaim' && spec) {
      metadata.storageClass = (spec as { storageClassName?: string }).storageClassName;
    }

    const volumeClaims = extractVolumeClaims(spec);
    if (volumeClaims.length > 0) metadata.volumeClaims = volumeClaims;

    const refs = extractConfigMapSecretRefs(spec);
    if (refs.configMaps.length > 0) metadata.configMapRefs = refs.configMaps;
    if (refs.secrets.length > 0) metadata.secretRefs = refs.secrets;

    if (resMetadata.ownerReferences) {
      metadata.ownerReferences = (
        resMetadata.ownerReferences as Array<Record<string, unknown>>
      ).map(ref => ({
        kind: ref.kind as string,
        name: ref.name as string,
        uid: ref.uid as string,
      }));
    }

    if (spec && typeof spec.replicas === 'number') {
      metadata.replicas = spec.replicas;
    }

    if (spec && spec.selector && typeof spec.selector === 'object') {
      const selectorRecord = (spec.selector as { matchLabels?: Record<string, string> })
        ?.matchLabels;
      if (selectorRecord) {
        metadata.selector = selectorRecord;
      }
    }

    const envAwsArns = extractAwsArnStringsFromEnvVars(spec);
    if (envAwsArns.length > 0) {
      metadata.referencedResourceIds = [...(metadata.referencedResourceIds || []), ...envAwsArns];
      metadata.referencedResourceIds = Array.from(new Set(metadata.referencedResourceIds));
    }

    if (metadata.referencedResourceIds && metadata.referencedResourceIds.length > 0) {
      const accountIds = extractAccountIdsFromAwsArnStrings(metadata.referencedResourceIds);
      if (accountIds.length > 0 && !metadata.accountId) {
        metadata.accountId = accountIds[0];
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

    if (templateSpec && templateSpec.volumes) {
      for (const volume of templateSpec.volumes as Array<Record<string, unknown>>) {
        if ((volume.configMap as Record<string, unknown>)?.name)
          configMaps.push((volume.configMap as Record<string, unknown>).name as string);
        if ((volume.secret as Record<string, unknown>)?.secretName)
          secrets.push((volume.secret as Record<string, unknown>).secretName as string);
      }
    }

    if (templateSpec && templateSpec.containers) {
      for (const container of templateSpec.containers as Array<Record<string, unknown>>) {
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

function extractAwsArnStringsFromEnvVars(spec: Record<string, unknown>): string[] {
  const out: string[] = [];

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
              const found = extractAwsArnStringsFromText(envVar.value);
              out.push(...found);
            }
          }
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to extract AWS ARN strings from env vars: ${error}`);
  }

  return Array.from(new Set(out));
}

function extractAwsArnStringsFromText(text: string): string[] {
  const pattern = /arn:aws:[\w-]+:[\w-]*:(?:\d{12})?:[\w\-\/:.*]+/g;
  const matches = text.match(pattern);
  return matches ? Array.from(new Set(matches)) : [];
}

function extractAccountIdsFromAwsArnStrings(awsArnStrings: string[]): string[] {
  const accountIds: string[] = [];

  for (const s of awsArnStrings) {
    const match = s.match(/arn:aws:[\w-]+:[\w-]*:(\d{12}):/);
    if (match) {
      accountIds.push(match[1]);
    }
  }

  return Array.from(new Set(accountIds));
}

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

    const templateSpec = parsed.spec?.template?.spec;
    if (templateSpec) {
      const containers = templateSpec.containers || [];
      const initContainers = templateSpec.initContainers || [];
      images.push(...(containers.map(c => c.image).filter(Boolean) as string[]));
      images.push(...(initContainers.map(c => c.image).filter(Boolean) as string[]));
    }

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

export function annotateResourceIds(
  resources: ParsedResource[],
  metadata: DeploymentMetadata | null
): void {
  if (!metadata?.cluster) {
    core.warning('Cannot generate resource IDs: missing cluster in metadata');
    return;
  }

  const provider = metadata.provider;
  core.info(
    `Annotating resource IDs for ${resources.length} resources (provider: ${provider ?? 'auto'})`
  );

  if (provider === 'azure') {
    if (!metadata.region || !metadata.cluster) {
      core.warning('Azure: missing region or cluster; cannot build resource IDs');
      return;
    }
    let count = 0;
    for (const resource of resources) {
      resource.resourceId = buildResourceId(metadata, resource);
      count++;
    }
    core.info(
      `✓ Annotated ${count} resources with Azure resource IDs (region:cluster:namespace:Kind:name)`
    );
  } else {
    if (!metadata.region) {
      core.warning('AWS: missing region; cannot build resource IDs');
      return;
    }
    let count = 0;
    for (const resource of resources) {
      resource.resourceId = buildResourceId(metadata, resource);
      count++;
    }
    core.info(
      `✓ Annotated ${count} resources with AWS resource IDs (region:cluster:namespace:Kind:name)`
    );
  }

  if (resources.length > 0 && resources[0].resourceId) {
    core.info(`Sample: ${resources[0].resourceId}`);
  }
}

function buildResourceId(metadata: DeploymentMetadata, resource: ParsedResource): string {
  const region = metadata.region!;
  const cluster = metadata.cluster!;
  const namespace = resource.namespace || 'default';
  return `${region}:${cluster}:${namespace}:${resource.kind}:${resource.name}`;
}

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
