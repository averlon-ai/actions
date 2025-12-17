import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import { ParsedResource } from './resource-parser';

export interface DeploymentMetadata {
  accountId?: string;
  region?: string;
  cluster?: string;
  environment?: string;
}

/**
 * Extract deployment metadata from helm USER-SUPPLIED VALUES
 * Generic approach: checks multiple common field name variations
 */
export function extractDeploymentMetadata(valuesYaml?: string): DeploymentMetadata | null {
  if (!valuesYaml) {
    core.debug('No userSuppliedValues provided to extractDeploymentMetadata');
    return null;
  }

  try {
    const parsed = yaml.load(valuesYaml);
    if (!isRecord(parsed)) {
      core.debug('Parsed userSuppliedValues is not a record');
      return null;
    }

    // Check both top-level and nested sections (app, aws, global, etc.)
    const appSection = isRecord(parsed.app) ? parsed.app : {};
    const awsSection = isRecord(parsed.aws) ? parsed.aws : {};
    const globalSection = isRecord(parsed.global) ? parsed.global : {};

    // Generic account ID extraction (multiple field name variations)
    const accountId =
      getString(parsed, 'accountId') ??
      getString(parsed, 'account_id') ??
      getString(parsed, 'awsAccountId') ??
      getString(parsed, 'aws_account_id') ??
      getString(appSection, 'accountId') ??
      getString(appSection, 'account_id') ??
      getString(awsSection, 'accountId') ??
      getString(awsSection, 'account_id') ??
      getString(globalSection, 'accountId') ??
      getString(globalSection, 'account_id');

    // Generic region extraction (multiple field name variations)
    const region =
      getString(parsed, 'region') ??
      getString(parsed, 'awsRegion') ??
      getString(parsed, 'aws_region') ??
      getString(appSection, 'region') ??
      getString(appSection, 'aws_region') ??
      getString(awsSection, 'region') ??
      getString(globalSection, 'region');

    // Generic cluster extraction (multiple field name variations)
    const cluster =
      getString(parsed, 'cluster') ??
      getString(parsed, 'clusterName') ??
      getString(parsed, 'cluster_name') ??
      getString(parsed, 'eksCluster') ??
      getString(parsed, 'eks_cluster') ??
      getString(appSection, 'cluster') ??
      getString(appSection, 'cluster_name') ??
      getString(awsSection, 'cluster') ??
      getString(globalSection, 'cluster');

    core.debug(
      `Extracted from values: accountId=${accountId}, region=${region}, cluster=${cluster}`
    );

    // Also extract application-specific metadata (if present)
    const metadata: DeploymentMetadata = {
      accountId,
      region,
      cluster,
      environment: getString(appSection, 'env') ?? getString(parsed, 'environment'),
    };

    const hasMetadata = Boolean(
      metadata.accountId || metadata.region || metadata.cluster || metadata.environment
    );

    return hasMetadata ? metadata : null;
  } catch (error) {
    core.debug(
      `Failed to parse USER-SUPPLIED VALUES block for metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Extract region from any AWS ARN
 * Generic: works with IAM, ACM, WAF, ELB, EKS, etc.
 * ARN format: arn:partition:service:region:account-id:resource
 */
function extractRegionFromArn(arn: string): string | undefined {
  const parts = arn.split(':');
  // Region is at index 3, but skip if it's empty (global services like IAM)
  if (parts.length >= 4 && parts[3] && parts[3].match(/^[a-z]{2}-[a-z]+-\d+$/)) {
    return parts[3];
  }
  return undefined;
}

/**
 * Extract account ID from any AWS ARN
 * ARN format: arn:partition:service:region:account-id:resource
 */
function extractAccountFromArn(arn: string): string | undefined {
  const parts = arn.split(':');
  // Account ID is at index 4
  if (parts.length >= 5 && parts[4] && parts[4].match(/^\d{12}$/)) {
    return parts[4];
  }
  return undefined;
}

/**
 * Generic extraction from ConfigMap data
 * Scans all data values for common patterns (YAML, JSON, env vars)
 */
function extractFromConfigMapData(data: Record<string, string>): {
  region?: string;
  cluster?: string;
  accountId?: string;
} {
  let region: string | undefined;
  let cluster: string | undefined;
  let accountId: string | undefined;

  for (const [key, value] of Object.entries(data)) {
    if (region && cluster && accountId) {
      break;
    }

    if (typeof value !== 'string') {
      continue;
    }

    // Extract from ARNs anywhere in the value
    if (!region || !accountId) {
      const arnRegex = /arn:aws:[^:]+:[^:]*:[^:]*:[^\s"'\n,}]*/g;
      let match;
      while ((match = arnRegex.exec(value)) !== null) {
        const arn = match[0];
        if (!region) {
          const arnRegion = extractRegionFromArn(arn);
          if (arnRegion) {
            region = arnRegion;
            core.debug(`Extracted region '${region}' from ARN in ConfigMap['${key}']`);
          }
        }
        if (!accountId) {
          const arnAccount = extractAccountFromArn(arn);
          if (arnAccount) {
            accountId = arnAccount;
            core.debug(`Extracted accountId '${accountId}' from ARN in ConfigMap['${key}']`);
          }
        }
      }
    }

    // Extract region from common YAML/env patterns
    if (!region) {
      const regionPatterns = [
        /(?:aws[_-]?)?region:\s*([a-z]{2}-[a-z]+-\d+)/i,
        /(?:hub[_-]?)?region[_-]?name?:\s*([a-z]{2}-[a-z]+-\d+)/i,
        /AWS_REGION[=:]\s*([a-z]{2}-[a-z]+-\d+)/i,
      ];
      for (const pattern of regionPatterns) {
        const match = value.match(pattern);
        if (match && match[1] && !match[1].startsWith('${')) {
          region = match[1];
          core.debug(`Extracted region '${region}' from pattern in ConfigMap['${key}']`);
          break;
        }
      }
    }

    // Extract cluster from common patterns
    if (!cluster) {
      const clusterPatterns = [
        /^cluster:\s*([a-zA-Z0-9_-]+)/im, // "cluster: name" (most common)
        /cluster[_-]?name:\s*([a-zA-Z0-9_-]+)/i, // "cluster_name:" or "cluster-name:"
        /eks[_-]?cluster:\s*([a-zA-Z0-9_-]+)/i, // "eks_cluster:" or "eks-cluster:"
        /CLUSTER_NAME[=:]\s*([a-zA-Z0-9_-]+)/i, // "CLUSTER_NAME=" or "CLUSTER_NAME:"
      ];
      for (const pattern of clusterPatterns) {
        const match = value.match(pattern);
        if (match && match[1] && !match[1].startsWith('${')) {
          cluster = match[1];
          core.debug(`Extracted cluster '${cluster}' from pattern in ConfigMap['${key}']`);
          break;
        }
      }
    }
  }

  return { region, cluster, accountId };
}

export function extractMetadataFromResources(resources: ParsedResource[]): {
  region?: string;
  cluster?: string;
  accountId?: string;
} {
  let region: string | undefined;
  let cluster: string | undefined;
  let accountId: string | undefined;

  // PRIORITY 1: Check ConfigMaps FIRST (most reliable source - contains helm values)
  for (const resource of resources) {
    if (region && cluster && accountId) {
      break;
    }

    if (resource.kind === 'ConfigMap' && resource.data) {
      const configData = extractFromConfigMapData(resource.data);
      if (!region && configData.region) {
        region = configData.region;
        core.info(`✓ Found region in ConfigMap '${resource.name}': ${region}`);
      }
      if (!cluster && configData.cluster) {
        cluster = configData.cluster;
        core.info(`✓ Found cluster in ConfigMap '${resource.name}': ${cluster}`);
      }
      if (!accountId && configData.accountId) {
        accountId = configData.accountId;
        core.info(`✓ Found accountId in ConfigMap '${resource.name}': ${accountId}`);
      }
    }
  }

  // PRIORITY 2: Check other resources only if ConfigMaps didn't have the values
  for (const resource of resources) {
    if (region && cluster && accountId) {
      break;
    }

    // Skip ConfigMaps (already processed above)
    if (resource.kind === 'ConfigMap') {
      continue;
    }

    // 2. Extract from resource metadata (if set directly)
    const resourceMeta = resource.metadata;
    if (resourceMeta) {
      if (!region) {
        region = resourceMeta.region || resourceMeta.awsRegion;
      }
      if (!cluster) {
        cluster = resourceMeta.cluster;
      }
      if (!accountId) {
        accountId = resourceMeta.accountId;
      }
    }

    // 3. Extract from Kubernetes topology labels (standard k8s)
    if (!region && resource.labels) {
      region =
        resource.labels['topology.kubernetes.io/region'] ||
        resource.labels['failure-domain.beta.kubernetes.io/region'];

      if (!region) {
        const zone =
          resource.labels['topology.kubernetes.io/zone'] ||
          resource.labels['failure-domain.beta.kubernetes.io/zone'];
        if (zone) {
          const match = zone.match(/^(.+)[a-z]$/);
          if (match) {
            region = match[1];
            core.debug(`Extracted region '${region}' from zone '${zone}'`);
          }
        }
      }
    }

    // 4. Extract from annotations (AWS/EKS specific)
    if (resource.annotations) {
      if (!cluster) {
        cluster =
          resource.annotations['eks.amazonaws.com/cluster-name'] ||
          resource.annotations['eks.amazonaws.com/cluster'];
      }
      if (!region) {
        region = resource.annotations['aws.amazon.com/region'];
      }
      if (!accountId) {
        accountId = resource.annotations['aws.amazon.com/account-id'];
      }

      // Extract from ANY ARN in annotations (generic approach)
      if (!region || !accountId) {
        for (const value of Object.values(resource.annotations)) {
          if (typeof value === 'string' && value.startsWith('arn:aws:')) {
            if (!region) {
              const arnRegion = extractRegionFromArn(value);
              if (arnRegion) {
                region = arnRegion;
                core.debug(`Extracted region '${region}' from ARN in annotations`);
              }
            }
            if (!accountId) {
              const arnAccount = extractAccountFromArn(value);
              if (arnAccount) {
                accountId = arnAccount;
                core.debug(`Extracted accountId '${accountId}' from ARN in annotations`);
              }
            }
          }
        }
      }
    }

    // 5. Extract cluster from common labels (generic approach)
    if (!cluster && resource.labels) {
      cluster =
        resource.labels['cluster'] ||
        resource.labels['cluster-name'] ||
        resource.labels['eks.amazonaws.com/cluster'] ||
        resource.labels['eks.amazonaws.com/cluster-name'] ||
        resource.labels['app.kubernetes.io/instance']; // Helm release name
    }
  }

  if (region) {
    core.info(`✓ Detected region from resources: ${region}`);
  }
  if (cluster) {
    core.info(`✓ Detected cluster from resources: ${cluster}`);
  }
  if (accountId) {
    core.info(`✓ Detected account ID from resources: ${accountId}`);
  }

  return { region, cluster, accountId };
}

export function logDeploymentMetadata(metadata: DeploymentMetadata | null): void {
  if (!metadata) {
    return;
  }

  core.info('\nDeployment metadata extracted from values:');
  if (metadata.accountId) {
    core.info(`  Account ID: ${metadata.accountId}`);
  }
  if (metadata.region) {
    core.info(`  Region: ${metadata.region}`);
  }
  if (metadata.environment) {
    core.info(`  Environment: ${metadata.environment}`);
  }
  if (metadata.cluster) {
    core.info(`  Cluster: ${metadata.cluster}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
