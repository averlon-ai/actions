import * as core from '@actions/core';
import {
  IssueSeverityEnum,
  IssueTypeEnum,
  OpenSearchNamedQueryEnum,
  type ApiClient,
  type OpenSearchIssue,
  type TerraformResource,
} from '@averlon/shared';
import { dedupeResourceIds, type ParsedIacResource } from './iac-resource';

function severityValues(severities?: IssueSeverityEnum[]): string[] {
  return severities && severities.length > 0 ? severities.map(severity => severity.toString()) : [];
}

function buildOpenSearchFilter(params: {
  cloudId: string;
  resourceIds: string[];
  severities?: IssueSeverityEnum[];
}): string {
  const filter: unknown[] = [
    { term: { 'issue.Type': IssueTypeEnum.Misconfiguration } },
    { terms: { 'issue.ResourceID': params.resourceIds } },
    { terms: { 'issue.CloudID': [params.cloudId] } },
  ];
  const severities = severityValues(params.severities);
  if (severities.length > 0) {
    filter.push({ terms: { 'issue.SeverityV2.Severity': severities } });
  }
  return JSON.stringify({ bool: { should: [{ bool: { filter } }] } });
}

function logCorrelationCandidates(params: {
  sourceName: string;
  cloudId: string;
  resources: ParsedIacResource[];
  resourceIds: string[];
  severities?: IssueSeverityEnum[];
}): void {
  const severityLabel =
    params.severities && params.severities.length > 0
      ? params.severities.map(severity => severity.toString()).join(', ')
      : 'any';

  core.info(
    `${params.sourceName} correlation input: ${params.resources.length} parsed resource(s), ${params.resourceIds.length} unique candidate ID(s), cloud-id=${params.cloudId}, severity=${severityLabel}`
  );

  for (const resource of params.resources) {
    core.info(
      `  ${resource.type} (${resource.name}): ${resource.candidateResourceIds.join(', ') || '<none>'}`
    );
  }

  core.info('Unique candidate IDs sent to OpenSearch:');
  for (const resourceId of params.resourceIds) {
    core.info(`  ${resourceId}`);
  }
}

function logOpenSearchQueryRequest(request: {
  QueryID: OpenSearchNamedQueryEnum;
  FilterQuery: string;
  Limit: number;
  IncludeFields: string[];
  Aggregations: string;
}): void {
  core.info('OpenSearch query request:');
  core.info(`  QueryID: ${request.QueryID}`);
  core.info(`  Limit: ${request.Limit}`);
  core.info(`  IncludeFields: ${request.IncludeFields.join(', ')}`);
  core.info(`  Aggregations: ${request.Aggregations}`);
  core.info('  FilterQuery:');
  try {
    core.info(JSON.stringify(JSON.parse(request.FilterQuery), null, 2));
  } catch {
    core.info(request.FilterQuery);
  }
}

function logOpenSearchCorrelationResult(params: {
  issueCount: number;
  issues: OpenSearchIssue[];
  parsedCount: number;
  matchedCount: number;
}): void {
  core.info(`OpenSearch returned ${params.issueCount} issue(s) for candidate resource IDs`);
  if (params.issueCount > 0) {
    for (const issue of params.issues) {
      if (!issue.ID || !issue.ResourceID) continue;
      core.info(`  issue ${issue.ID}: ResourceID=${issue.ResourceID}`);
    }
  }

  core.info(
    `Correlation matched ${params.matchedCount} of ${params.parsedCount} parsed resource(s) with issues`
  );
  if (params.matchedCount === 0 && params.issueCount > 0) {
    core.warning(
      'OpenSearch returned issues but none matched parsed candidate IDs — check ResourceID format alignment'
    );
  } else if (params.matchedCount === 0) {
    core.info(
      'No correlated resources — verify cloud-id, severity filters, and that Averlon has scanned these assets'
    );
  }
}

function attachIssues(
  resources: TerraformResource[],
  candidateIndex: Map<string, ParsedIacResource>,
  issues: OpenSearchIssue[],
  cloudId: string
): void {
  const resourceById = new Map(resources.map(resource => [resource.ID, resource]));

  for (const issue of issues) {
    if (!issue.ResourceID || !issue.ID) continue;
    const parsed = candidateIndex.get(issue.ResourceID);
    if (!parsed) continue;

    const resource = resourceById.get(parsed.id);
    if (!resource) continue;

    resource.Asset ??= {};
    resource.Asset.CloudID = cloudId;
    resource.Asset.ResourceID = issue.ResourceID;

    resource.Issues ??= [];
    if (!resource.Issues.some(existing => existing.ID === issue.ID)) {
      resource.Issues.push({ ID: issue.ID, CloudID: cloudId });
    }
  }
}

export async function correlateExistingIssues(params: {
  resources: ParsedIacResource[];
  apiClient: ApiClient;
  cloudId?: string;
  severityFilters?: IssueSeverityEnum[];
  sourceName: string;
  toTerraformResource: (
    resource: ParsedIacResource,
    matchedResourceId?: string
  ) => TerraformResource;
}): Promise<TerraformResource[]> {
  const identifiable = params.resources.filter(
    resource => resource.candidateResourceIds.length > 0
  );

  if (identifiable.length === 0) {
    core.warning(`No ${params.sourceName} cloud resource IDs found; issue correlation skipped`);
    return [];
  }

  if (!params.cloudId) {
    core.warning(`cloud-id not provided; ${params.sourceName} issue correlation skipped`);
    return [];
  }

  const candidateIndex = new Map<string, ParsedIacResource>();
  for (const resource of identifiable) {
    for (const candidateId of resource.candidateResourceIds) {
      candidateIndex.set(candidateId, resource);
    }
  }

  const resourceIds = dedupeResourceIds(
    identifiable.flatMap(resource => resource.candidateResourceIds)
  );

  logCorrelationCandidates({
    sourceName: params.sourceName,
    cloudId: params.cloudId,
    resources: identifiable,
    resourceIds,
    severities: params.severityFilters,
  });

  const filterQuery = buildOpenSearchFilter({
    cloudId: params.cloudId,
    resourceIds,
    severities: params.severityFilters,
  });

  const limit = Math.min(resourceIds.length * 20, 1000);
  const openSearchRequest = {
    QueryID: OpenSearchNamedQueryEnum.Issue,
    FilterQuery: filterQuery,
    Limit: limit,
    IncludeFields: ['issue.ID', 'issue.ResourceID', 'issue.SeverityV2.Severity'],
    Aggregations: 'default',
  };

  logOpenSearchQueryRequest(openSearchRequest);

  const response = await params.apiClient.orgOpenSearchQuery(openSearchRequest);

  const issues = response.Issues ?? [];
  const correlated = identifiable.map(resource => params.toTerraformResource(resource));
  attachIssues(correlated, candidateIndex, issues, params.cloudId);

  const matched = correlated.filter(resource => (resource.Issues?.length ?? 0) > 0);
  logOpenSearchCorrelationResult({
    issueCount: issues.length,
    issues,
    parsedCount: identifiable.length,
    matchedCount: matched.length,
  });

  return matched;
}
