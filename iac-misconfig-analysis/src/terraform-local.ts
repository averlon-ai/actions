import { IssueSeverityEnum, type ApiClient, type TerraformResource } from '@averlon/shared';
import {
  analyzeParsedResources,
  asString,
  extractTerraformCandidateIds,
  isRecord,
  type ParsedIacResource,
} from './iac-resource';
import { buildProjectNumberMap } from './gcp-resource-id';

type JsonRecord = Record<string, unknown>;

function parsePlan(content: string): JsonRecord {
  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) throw new Error('root value must be an object');
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Terraform plan JSON: ${message}`);
  }
}

function operationFromChange(record: JsonRecord): string {
  const change = isRecord(record['change']) ? record['change'] : undefined;
  const actions = Array.isArray(change?.['actions']) ? change['actions'] : [];
  return actions.map(action => String(action)).join(',') || 'unknown';
}

function getStateResourceAttributes(record: JsonRecord): JsonRecord | undefined {
  if (isRecord(record['values'])) return record['values'];
  const instances = record['instances'];
  if (Array.isArray(instances) && isRecord(instances[0])) {
    const attributes = instances[0]['attributes'];
    return isRecord(attributes) ? attributes : undefined;
  }
  return undefined;
}

function collectStateModuleResources(
  module: JsonRecord,
  moduleAddress: string,
  items: Array<{ type?: string; change?: JsonRecord; address?: string; name?: string }>
): void {
  const resources = Array.isArray(module['resources']) ? module['resources'] : [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const type = asString(resource['type']);
    const name = asString(resource['name']);
    const address =
      asString(resource['address']) ?? (moduleAddress && name ? `${moduleAddress}.${name}` : name);
    const after = getStateResourceAttributes(resource);
    if (!type || !after) continue;
    items.push({ type, name, address, change: { after } });
  }

  const childModules = Array.isArray(module['child_modules']) ? module['child_modules'] : [];
  for (const child of childModules) {
    if (!isRecord(child)) continue;
    const childAddress = asString(child['address']) ?? moduleAddress;
    collectStateModuleResources(child, childAddress, items);
  }
}

function collectStateJsonItems(parsed: JsonRecord): Array<{
  type?: string;
  change?: JsonRecord;
  address?: string;
  name?: string;
}> {
  const items: Array<{ type?: string; change?: JsonRecord; address?: string; name?: string }> = [];

  const values = parsed['values'];
  if (isRecord(values) && isRecord(values['root_module'])) {
    collectStateModuleResources(values['root_module'], '', items);
    return items;
  }

  const resources = Array.isArray(parsed['resources']) ? parsed['resources'] : [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const type = asString(resource['type']);
    const name = asString(resource['name']);
    const after = getStateResourceAttributes(resource);
    if (!type || !after) continue;
    items.push({ type, name, address: name, change: { after } });
  }

  return items;
}

function parsedResourcesFromStateItems(
  items: Array<{ type?: string; change?: JsonRecord; address?: string; name?: string }>,
  operation: string
): ParsedIacResource[] {
  const projectNumbers = buildProjectNumberMap(
    items.map(item => ({ type: item.type, change: item.change }))
  );
  const gcpContext = { projectNumbers };
  const resources: ParsedIacResource[] = [];

  for (const item of items) {
    const type = item.type;
    const address = item.address;
    if (!type || !address) continue;

    const candidateResourceIds = extractTerraformCandidateIds(type, item.change, gcpContext);
    if (candidateResourceIds.length === 0) continue;

    resources.push({
      id: address,
      type,
      name: item.name || address,
      operation,
      candidateResourceIds,
    });
  }

  return resources;
}

export function parseTerraformStateJson(content: string): ParsedIacResource[] {
  const parsed = parsePlan(content);
  const items = collectStateJsonItems(parsed);
  return parsedResourcesFromStateItems(items, 'state');
}

export function parseTerraformJson(content: string): ParsedIacResource[] {
  const parsed = parsePlan(content);
  if (Array.isArray(parsed['resource_changes'])) {
    return parseTerraformPlanJson(content);
  }
  return parseTerraformStateJson(content);
}

export function parseTerraformPlanJson(content: string): ParsedIacResource[] {
  const plan = parsePlan(content);
  const resourceChanges = Array.isArray(plan['resource_changes']) ? plan['resource_changes'] : [];
  const projectNumbers = buildProjectNumberMap(
    resourceChanges.filter(isRecord).map(item => ({
      type: asString(item['type']),
      change: isRecord(item['change']) ? item['change'] : undefined,
    }))
  );
  const gcpContext = { projectNumbers };
  const resources: ParsedIacResource[] = [];

  for (const item of resourceChanges) {
    if (!isRecord(item)) continue;
    const address = asString(item['address']);
    const type = asString(item['type']);
    const name = asString(item['name']);
    if (!address || !type) continue;

    const operation = operationFromChange(item);
    const change = isRecord(item['change']) ? item['change'] : undefined;
    const candidateResourceIds = extractTerraformCandidateIds(type, change, gcpContext);
    if (candidateResourceIds.length === 0) continue;

    resources.push({
      id: address,
      type,
      name: name || address,
      operation,
      candidateResourceIds,
    });
  }

  return resources;
}

export async function correlateTerraformPlan(params: {
  content: string;
  apiClient: ApiClient;
  cloudId?: string;
  severityFilters?: IssueSeverityEnum[];
  resourceTypeFilter?: string[];
}): Promise<TerraformResource[]> {
  const resources = parseTerraformJson(params.content);
  return analyzeParsedResources({
    resources,
    apiClient: params.apiClient,
    cloudId: params.cloudId,
    severityFilters: params.severityFilters,
    resourceTypeFilter: params.resourceTypeFilter,
    sourceName: 'Terraform',
  });
}
