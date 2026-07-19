import { IssueSeverityEnum, type ApiClient, type TerraformResource } from '@averlon/shared';
import {
  analyzeParsedResources,
  asString,
  extractPulumiCandidateIds,
  isRecord,
  type ParsedIacResource,
} from './iac-resource';

type JsonRecord = Record<string, unknown>;

function parseUrn(urn: string): { type: string; name: string } {
  const parts = urn.split('::');
  const rawType = parts.length >= 3 ? parts[parts.length - 2] || '' : '';
  const typeChain = rawType.split('$');
  return {
    type: typeChain[typeChain.length - 1] || 'unknown',
    name: parts[parts.length - 1] || urn,
  };
}

function isInternalPulumiType(type: string): boolean {
  return type === 'pulumi:pulumi:Stack' || type.startsWith('pulumi:providers:');
}

function stackResourceRecords(parsed: unknown): JsonRecord[] {
  if (!isRecord(parsed)) return [];
  const deployment = parsed['deployment'];
  if (!isRecord(deployment)) return [];
  const resources = deployment['resources'];
  if (!Array.isArray(resources)) return [];
  return resources.filter(isRecord);
}

function extractResource(record: JsonRecord): ParsedIacResource | undefined {
  const urn = asString(record['urn']);
  if (!urn) return undefined;

  const type = asString(record['type']) ?? parseUrn(urn).type;
  if (isInternalPulumiType(type)) return undefined;

  const candidateResourceIds = extractPulumiCandidateIds(record, type);
  if (candidateResourceIds.length === 0) return undefined;

  return {
    id: urn,
    type,
    name: parseUrn(urn).name,
    operation: 'applied',
    candidateResourceIds,
  };
}

export function parsePulumiStackJson(content: string): ParsedIacResource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Pulumi stack export JSON: ${message}`);
  }

  const seen = new Set<string>();
  const resources: ParsedIacResource[] = [];
  for (const record of stackResourceRecords(parsed)) {
    const resource = extractResource(record);
    if (!resource || seen.has(resource.id)) continue;
    seen.add(resource.id);
    resources.push(resource);
  }
  return resources;
}

export async function correlatePulumiStack(params: {
  content: string;
  apiClient: ApiClient;
  cloudId?: string;
  severityFilters?: IssueSeverityEnum[];
  resourceTypeFilter?: string[];
}): Promise<TerraformResource[]> {
  const resources = parsePulumiStackJson(params.content);
  return analyzeParsedResources({
    resources,
    apiClient: params.apiClient,
    cloudId: params.cloudId,
    severityFilters: params.severityFilters,
    resourceTypeFilter: params.resourceTypeFilter,
    sourceName: 'Pulumi',
  });
}
