import { IssueSeverityEnum, type ApiClient, type TerraformResource } from '@averlon/shared';
import {
  buildGcpTerraformTypeCandidates,
  expandGcpCandidates,
  isGcpPulumiType,
  isGcpTerraformType,
  pulumiTypeToTerraformGoogleType,
  type GcpCandidateContext,
} from './gcp-resource-id';
import { correlateExistingIssues } from './local-analysis';

export interface ParsedIacResource {
  /** Terraform address or Pulumi URN */
  id: string;
  type: string;
  name: string;
  operation: string;
  candidateResourceIds: string[];
}

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function isStableResourceId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.includes('known after apply')) return false;
  if (lower.includes('(sensitive value)')) return false;
  return true;
}

export function dedupeResourceIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!isStableResourceId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function collectFieldCandidates(record: JsonRecord, keys: string[]): string[] {
  const ids: string[] = [];
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) ids.push(value);
  }
  return ids;
}

function terraformCandidateKeys(type: string): string[] {
  if (type.startsWith('aws_iam_') || type.startsWith('aws_s3_')) {
    return ['arn', 'id', 'bucket', 'resource_id', 'resourceId', 'name'];
  }
  if (type.startsWith('aws_')) {
    return ['arn', 'id', 'resource_id', 'resourceId', 'bucket', 'topic_arn', 'queue_url'];
  }
  if (type.startsWith('azurerm_')) {
    // Azure assets are keyed by the full ARM resource ID, which Terraform exposes as `id`.
    return ['id', 'resource_id', 'name'];
  }
  if (type.startsWith('google_')) {
    if (type.endsWith('_iam_member') || type.endsWith('_iam_binding')) {
      return [
        'bucket',
        'project',
        'org_id',
        'repository',
        'repository_id',
        'location',
        'region',
        'service',
        'service_account_id',
        'key_ring_id',
        'crypto_key_id',
        'secret_id',
        'billing_account_id',
      ];
    }
    return [
      'self_link',
      'id',
      'name',
      'email',
      'unique_id',
      'project',
      'bucket',
      'url',
      'role_id',
      'number',
    ];
  }
  return [
    'arn',
    'id',
    'resource_id',
    'resourceId',
    'resourceID',
    'bucket',
    'topic_arn',
    'queue_url',
    'name',
  ];
}

/**
 * Averlon stores Azure asset ResourceIDs lowercased (see backend trivy_config
 * `strings.ToLower` for Azure), while Terraform emits the canonical mixed-case
 * ARM path. Emit both so the lowercase form matches stored issues.
 */
function expandAzureCandidates(ids: string[]): string[] {
  const expanded: string[] = [];
  for (const id of ids) {
    expanded.push(id);
    if (id.startsWith('/subscriptions/')) {
      const lower = id.toLowerCase();
      if (lower !== id) expanded.push(lower);
    }
  }
  return expanded;
}

export { deriveGcpFullResourceName } from './gcp-resource-id';

export function extractTerraformCandidateIds(
  type: string,
  change?: JsonRecord,
  gcpContext?: GcpCandidateContext
): string[] {
  if (!change) return [];
  const after = isRecord(change['after']) ? change['after'] : undefined;
  const before = isRecord(change['before']) ? change['before'] : undefined;
  const projectNumbers = gcpContext?.projectNumbers;
  const keys = terraformCandidateKeys(type);
  let candidates = [
    ...(after ? collectFieldCandidates(after, keys) : []),
    ...(before ? collectFieldCandidates(before, keys) : []),
    ...(after ? buildGcpTerraformTypeCandidates(type, after, projectNumbers) : []),
    ...(before ? buildGcpTerraformTypeCandidates(type, before, projectNumbers) : []),
  ];

  if (type.startsWith('azurerm_')) {
    candidates = expandAzureCandidates(candidates);
  } else if (isGcpTerraformType(type)) {
    candidates = expandGcpCandidates(candidates);
  }

  return dedupeResourceIds(candidates);
}

const PULUMI_CANDIDATE_KEYS = [
  'arn',
  'id',
  'resourceId',
  'resourceID',
  'resource_id',
  'physicalName',
  'bucket',
  'queueUrl',
  'topicArn',
  'role',
  'instance',
  'name',
];

/**
 * Collects candidate IDs from a single Pulumi resource state object
 * (a step's oldState/newState, or the step itself for flattened shapes).
 *
 * Provider-computed identifiers such as `arn` live under `outputs`/`inputs`,
 * while the physical resource `id` sits at the top level of the state object,
 * so both levels must be inspected. Nested maps are read first so ARNs rank
 * ahead of the raw physical id.
 */
function collectFromStateObject(state: unknown, ids: string[]): void {
  if (!isRecord(state)) return;
  for (const nestedKey of ['outputs', 'inputs']) {
    const nested = state[nestedKey];
    if (isRecord(nested)) ids.push(...collectFieldCandidates(nested, PULUMI_CANDIDATE_KEYS));
  }
  ids.push(...collectFieldCandidates(state, PULUMI_CANDIDATE_KEYS));
}

export function extractPulumiCandidateIds(
  record: JsonRecord,
  type?: string,
  gcpContext?: GcpCandidateContext
): string[] {
  const ids: string[] = [];
  collectFromStateObject(record['newState'], ids);
  collectFromStateObject(record['oldState'], ids);
  collectFromStateObject(record['state'], ids);
  // Handles flattened shapes where outputs/inputs/id sit directly on the step.
  collectFromStateObject(record, ids);

  const resourceType = type ?? asString(record['type']);
  if (resourceType && isGcpPulumiType(resourceType)) {
    const terraformType = pulumiTypeToTerraformGoogleType(resourceType);
    const projectNumbers = gcpContext?.projectNumbers;
    for (const stateKey of ['newState', 'oldState', 'state'] as const) {
      const state = record[stateKey];
      if (isRecord(state)) {
        ids.push(...buildGcpTerraformTypeCandidates(terraformType, state, projectNumbers));
        if (isRecord(state['outputs'])) {
          ids.push(
            ...buildGcpTerraformTypeCandidates(terraformType, state['outputs'], projectNumbers)
          );
        }
        if (isRecord(state['inputs'])) {
          ids.push(
            ...buildGcpTerraformTypeCandidates(terraformType, state['inputs'], projectNumbers)
          );
        }
      }
    }
    if (isRecord(record['outputs'])) {
      ids.push(
        ...buildGcpTerraformTypeCandidates(terraformType, record['outputs'], projectNumbers)
      );
    }
    if (isRecord(record['inputs'])) {
      ids.push(...buildGcpTerraformTypeCandidates(terraformType, record['inputs'], projectNumbers));
    }
    return dedupeResourceIds(expandGcpCandidates(ids));
  }

  return dedupeResourceIds(ids);
}

export function toTerraformResource(
  resource: ParsedIacResource,
  cloudId?: string,
  matchedResourceId?: string
): TerraformResource {
  return {
    ID: resource.id,
    Type: resource.type,
    Name: resource.name,
    Asset: {
      CloudID: cloudId,
      ResourceID: matchedResourceId ?? resource.candidateResourceIds[0],
    },
    Issues: [],
  };
}

export async function analyzeParsedResources(params: {
  resources: ParsedIacResource[];
  apiClient: ApiClient;
  cloudId?: string;
  severityFilters?: IssueSeverityEnum[];
  resourceTypeFilter?: string[];
  sourceName: string;
}): Promise<TerraformResource[]> {
  const allowedTypes = params.resourceTypeFilter ? new Set(params.resourceTypeFilter) : undefined;
  const filtered = params.resources.filter(
    resource => !allowedTypes || allowedTypes.has(resource.type)
  );

  return correlateExistingIssues({
    resources: filtered,
    apiClient: params.apiClient,
    cloudId: params.cloudId,
    severityFilters: params.severityFilters,
    sourceName: params.sourceName,
    toTerraformResource: (resource, matchedResourceId) =>
      toTerraformResource(resource, params.cloudId, matchedResourceId),
  });
}
