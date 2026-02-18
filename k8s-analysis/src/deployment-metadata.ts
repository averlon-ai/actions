import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import { ParsedResource } from './resource-parser';

export type CloudProvider = 'aws' | 'azure';

export interface DeploymentMetadata {
  provider?: CloudProvider;
  accountId?: string;
  resourceGroup?: string;
  region?: string;
  cluster?: string;
  environment?: string;
}

export function extractDeploymentMetadata(valuesYaml?: string): DeploymentMetadata | null {
  if (!valuesYaml) return null;
  try {
    const parsed = yaml.load(valuesYaml);
    if (!isRecord(parsed)) return null;

    const app = isRecord(parsed.app) ? parsed.app : {};
    const aws = isRecord(parsed.aws) ? parsed.aws : {};
    const azure = isRecord(parsed.azure) ? parsed.azure : {};
    const global = isRecord(parsed.global) ? parsed.global : {};

    const accountId =
      getStr(parsed, 'accountId', 'account_id', 'subscriptionId', 'subscription_id') ??
      getStr(app, 'accountId', 'account_id') ??
      getStr(aws, 'accountId', 'account_id') ??
      getStr(azure, 'subscriptionId', 'subscription_id') ??
      getStr(global, 'accountId', 'account_id');

    const region =
      getStr(parsed, 'region', 'awsRegion', 'location') ??
      getStr(app, 'region') ??
      getStr(aws, 'region') ??
      getStr(azure, 'location', 'region') ??
      getStr(global, 'region');

    const cluster =
      getStr(parsed, 'cluster', 'clusterName', 'cluster_name') ??
      getStr(app, 'cluster', 'cluster_name') ??
      getStr(aws, 'cluster') ??
      getStr(azure, 'cluster', 'clusterName', 'aksCluster') ??
      getStr(global, 'cluster');

    const metadata: DeploymentMetadata = {
      accountId: accountId ?? undefined,
      region: region ?? undefined,
      cluster: cluster ?? undefined,
      environment: getStr(app, 'env') ?? getStr(parsed, 'environment') ?? undefined,
    };
    const hasAny =
      metadata.accountId || metadata.region || metadata.cluster || metadata.environment;
    return hasAny ? metadata : null;
  } catch {
    return null;
  }
}

function getStr(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

const EKS_LABEL_PREFIX = 'eks.amazonaws.com/';
const AZURE_LABEL_PREFIX = 'kubernetes.azure.com/';

function hasLabelOrAnnotationKey(obj: Record<string, unknown>, prefix: string): boolean {
  return Object.keys(obj).some(k => k.startsWith(prefix));
}

export function detectProvider(resources: ParsedResource[]): CloudProvider | undefined {
  let aws = false;
  let azure = false;
  for (const r of resources) {
    const labels = r.labels || {};
    const annotations = r.annotations || {};
    const text = JSON.stringify(labels) + JSON.stringify(annotations);
    if (
      hasLabelOrAnnotationKey(labels, EKS_LABEL_PREFIX) ||
      hasLabelOrAnnotationKey(annotations, EKS_LABEL_PREFIX) ||
      text.includes('arn:aws:') ||
      annotations['aws.amazon.com/region']
    )
      aws = true;
    if (
      hasLabelOrAnnotationKey(labels, AZURE_LABEL_PREFIX) ||
      hasLabelOrAnnotationKey(annotations, AZURE_LABEL_PREFIX) ||
      text.includes('/subscriptions/') ||
      text.includes('Microsoft.ContainerService')
    )
      azure = true;
    if (r.kind === 'ConfigMap' && r.data) {
      for (const v of Object.values(r.data)) {
        if (typeof v === 'string') {
          if (v.includes('/subscriptions/')) azure = true;
          if (v.includes('arn:aws:')) aws = true;
        }
      }
    }
  }
  if (azure && !aws) return 'azure';
  if (aws) return 'aws';
  return undefined;
}

function parseAwsArnString(awsArn: string): { region?: string; accountId?: string } {
  const parts = awsArn.split(':');
  const region =
    parts.length >= 4 && parts[3]?.match(/^[a-z]{2}-[a-z]+-\d+$/) ? parts[3] : undefined;
  const accountId = parts.length >= 5 && parts[4]?.match(/^\d{12}$/) ? parts[4] : undefined;
  return { region, accountId };
}

const AZURE_AKS_ID =
  /\/subscriptions\/([a-f0-9-]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerService\/managedClusters\/([a-zA-Z0-9_-]+)/i;
const AZURE_REGIONS =
  /\b(eastus|eastus2|westus|westus2|centralus|northeurope|westeurope|uksouth|southeastasia|eastasia|australiaeast|canadacentral|brazilsouth|japaneast|japanwest)\b/i;

const AZURE_RESOURCE_GROUP_PATTERNS = [
  /(?:resourceGroup|resource_group|resourceGroupName|aks_resource_group)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)["']?/i,
  /RESOURCE_GROUP\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/i,
  /(?:azure\.)?resourceGroup\s*:\s*["']?([a-zA-Z0-9_-]+)["']?/i,
];

const AZURE_SUBSCRIPTION_ID_PATTERNS = [
  /(?:subscriptionId|subscription_id|azure\.subscriptionId)\s*[:=]\s*["']?([a-f0-9-]{36})["']?/i,
  /SUBSCRIPTION_ID\s*=\s*["']?([a-f0-9-]{36})["']?/i,
  /(?:subscriptionId|subscription_id)\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']?/i,
];

function fromAzureText(text: string): {
  region?: string;
  cluster?: string;
  accountId?: string;
  resourceGroup?: string;
} {
  const id = text.match(AZURE_AKS_ID);
  const region = text.match(AZURE_REGIONS)?.[1]?.toLowerCase();
  let resourceGroup = id?.[2];
  if (!resourceGroup) {
    for (const re of AZURE_RESOURCE_GROUP_PATTERNS) {
      const m = text.match(re);
      if (m?.[1]?.trim() && !m[1].startsWith('${')) {
        resourceGroup = m[1].trim();
        break;
      }
    }
  }
  let accountId = id?.[1];
  if (!accountId) {
    for (const re of AZURE_SUBSCRIPTION_ID_PATTERNS) {
      const m = text.match(re);
      if (m?.[1]?.trim() && !m[1].startsWith('${')) {
        accountId = m[1].trim();
        break;
      }
    }
  }
  return {
    accountId,
    resourceGroup,
    cluster: id?.[3],
    region: region ?? text.match(/(?:location|region)[=:]\s*([a-z0-9]+)/i)?.[1]?.toLowerCase(),
  };
}

function fromConfigMapData(data: Record<string, string>): {
  region?: string;
  cluster?: string;
  accountIdAws?: string;
  accountIdAzure?: string;
  resourceGroupAzure?: string;
} {
  let region: string | undefined;
  let cluster: string | undefined;
  let accountIdAws: string | undefined;
  let accountIdAzure: string | undefined;
  let resourceGroupAzure: string | undefined;

  const rgKeys = ['resourceGroup', 'resource_group', 'resourceGroupName', 'aks_resource_group'];
  const subKeys = ['subscriptionId', 'subscription_id', 'azure_subscription_id'];
  for (const key of Object.keys(data)) {
    const k = key.toLowerCase().replace(/[-.]/g, '_');
    if (rgKeys.some(rg => rg.toLowerCase().replace(/[-.]/g, '_') === k)) {
      const v = data[key];
      if (typeof v === 'string' && v.trim() && !v.startsWith('${')) resourceGroupAzure = v.trim();
    }
    if (subKeys.some(sk => sk.toLowerCase().replace(/[-.]/g, '_') === k)) {
      const v = data[key];
      if (
        !accountIdAzure &&
        typeof v === 'string' &&
        v.trim() &&
        !v.startsWith('${') &&
        /^[a-f0-9-]{36}$/i.test(v.trim())
      )
        accountIdAzure = v.trim();
    }
  }

  for (const value of Object.values(data)) {
    if (typeof value !== 'string') continue;

    const arnMatches = value.match(/arn:aws:[^:]+:[^:]*:[^:]*:[^\s"'\n,}]*/g);
    if (arnMatches?.length) {
      for (const awsArn of arnMatches) {
        const { region: r, accountId: a } = parseAwsArnString(awsArn);
        if (r && !region) region = r;
        if (a && !accountIdAws) accountIdAws = a;
      }
    }
    if (!region) {
      const m = value.match(/(?:hub_region|region|AWS_REGION)[=:\s]+([a-z]{2}-[a-z]+-\d+)/i);
      if (m?.[1]) region = m[1];
    }
    const az = fromAzureText(value);
    if (az.region && !region) region = az.region;
    if (az.cluster && !cluster) cluster = az.cluster;
    if (az.accountId && !accountIdAzure) accountIdAzure = az.accountId;
    if (az.resourceGroup && !resourceGroupAzure) resourceGroupAzure = az.resourceGroup;
    if (!cluster) {
      const m =
        value.match(/cluster\s*[:=]\s*([a-zA-Z0-9_-]+)/i) ??
        value.match(/cluster[_\-]name\s*[:=]\s*([a-zA-Z0-9_-]+)/i) ??
        value.match(/eks_cluster\s*[:=]\s*([a-zA-Z0-9_-]+)/i) ??
        value.match(/CLUSTER_NAME\s*[:=]\s*([a-zA-Z0-9_-]+)/);
      if (m?.[1] && !m[1].startsWith('${')) cluster = m[1];
    }
  }

  return { region, cluster, accountIdAws, accountIdAzure, resourceGroupAzure };
}

export function extractMetadataFromResources(resources: ParsedResource[]): {
  region?: string;
  cluster?: string;
  accountId?: string;
  provider?: CloudProvider;
  resourceGroup?: string;
} {
  const provider = detectProvider(resources);
  let region: string | undefined;
  let cluster: string | undefined;
  let accountIdAws: string | undefined;
  let accountIdAzure: string | undefined;
  let resourceGroup: string | undefined;

  for (const r of resources) {
    if (r.kind !== 'ConfigMap' || !r.data) continue;
    const cm = fromConfigMapData(r.data);
    if (cm.region && !region) region = cm.region;
    if (cm.cluster && !cluster) cluster = cm.cluster;
    if (cm.accountIdAws && !accountIdAws) accountIdAws = cm.accountIdAws;
    if (cm.accountIdAzure && !accountIdAzure) accountIdAzure = cm.accountIdAzure;
    if (cm.resourceGroupAzure && !resourceGroup) resourceGroup = cm.resourceGroupAzure;
  }

  for (const r of resources) {
    const labels = r.labels || {};
    const annotations = r.annotations || {};
    const meta = r.metadata;

    if (!region) {
      region =
        labels['topology.kubernetes.io/region'] ||
        labels['failure-domain.beta.kubernetes.io/region'] ||
        meta?.region ||
        meta?.awsRegion ||
        annotations['aws.amazon.com/region'];
      if (!region && labels['topology.kubernetes.io/zone']) {
        const z = labels['topology.kubernetes.io/zone'];
        const m = z.match(/^([a-z]{2}-[a-z]+-\d+)[a-z]$/);
        if (m) region = m[1];
      }
    }

    if (!cluster) {
      cluster =
        labels['cluster'] ||
        labels['cluster-name'] ||
        labels['eks.amazonaws.com/cluster'] ||
        labels['eks.amazonaws.com/cluster-name'] ||
        labels['kubernetes.azure.com/cluster'] ||
        labels['app.kubernetes.io/instance'] ||
        meta?.cluster ||
        annotations['eks.amazonaws.com/cluster-name'] ||
        annotations['eks.amazonaws.com/cluster'];
      if (labels['kubernetes.azure.com/cluster']?.startsWith('/')) {
        const az = fromAzureText(labels['kubernetes.azure.com/cluster']);
        if (az.cluster) cluster = az.cluster;
        if (az.accountId && !accountIdAzure) accountIdAzure = az.accountId;
        if (az.resourceGroup && !resourceGroup) resourceGroup = az.resourceGroup;
      }
      for (const v of Object.values(annotations)) {
        if (typeof v === 'string' && v.includes('/subscriptions/')) {
          const az = fromAzureText(v);
          if (az.cluster && !cluster) cluster = az.cluster;
          if (az.accountId && !accountIdAzure) accountIdAzure = az.accountId;
          if (az.resourceGroup && !resourceGroup) resourceGroup = az.resourceGroup;
        }
      }
    }

    if (provider === 'aws') {
      if (!accountIdAws) {
        accountIdAws = meta?.accountId ?? annotations['aws.amazon.com/account-id'];
        if (!accountIdAws) {
          for (const v of Object.values(annotations)) {
            if (typeof v === 'string' && v.startsWith('arn:aws:')) {
              const { accountId: a } = parseAwsArnString(v);
              if (a) {
                accountIdAws = a;
                break;
              }
            }
          }
        }
      }
      if (!region) {
        for (const v of Object.values(annotations)) {
          if (typeof v === 'string' && v.startsWith('arn:aws:')) {
            const { region: r } = parseAwsArnString(v);
            if (r) {
              region = r;
              break;
            }
          }
        }
      }
    }
  }

  const accountId =
    provider === 'azure' ? (accountIdAzure ?? accountIdAws) : (accountIdAws ?? accountIdAzure);

  if (region) core.info(`✓ Detected region: ${region}`);
  if (cluster) core.info(`✓ Detected cluster: ${cluster}`);
  if (accountId) core.info(`✓ Detected account ID`);
  if (provider) core.info(`✓ Detected provider: ${provider}`);
  if (resourceGroup) core.info(`✓ Detected resource group: ${resourceGroup}`);

  return { region, cluster, accountId, provider, resourceGroup };
}

export function logDeploymentMetadata(metadata: DeploymentMetadata | null): void {
  if (!metadata) return;
  core.info('\nDeployment metadata:');
  if (metadata.provider) core.info(`  Provider: ${metadata.provider}`);
  if (metadata.accountId) core.info(`  Account ID: ${metadata.accountId}`);
  if (metadata.region) core.info(`  Region: ${metadata.region}`);
  if (metadata.cluster) core.info(`  Cluster: ${metadata.cluster}`);
  if (metadata.environment) core.info(`  Environment: ${metadata.environment}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
