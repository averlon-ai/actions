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
  if (options.verbose) {
    log('Base filters:', baseFilters);
  }
  const shouldClauses: Array<Record<string, unknown>> = [];

  if (options.severityValues.length > 0) {
    shouldClauses.push({
      bool: {
        filter: [
          ...baseFilters,
          {
            terms: {
              'issue.Severity': [...options.severityValues],
            },
          },
        ],
      },
    });
  }

  if (shouldClauses.length === 0) {
    shouldClauses.push({
      bool: {
        filter: baseFilters,
      },
    });
  }

  return JSON.stringify({
    bool: {
      should: shouldClauses,
    },
  });
}

function mapOpenSearchIssue(issue: OpenSearchIssue): ResourceIssue | null {
  if (!issue.ID) {
    return null;
  }

  return {
    id: issue.ID,
    severity: severityToString(issue.Severity),
    severityValue: issue.Severity,
    title: issue.Title,
    summary: issue.Summary,
    type: 'Misconfiguration', // We only query for misconfigurations
    classification: classificationNames(issue.Classification),
    status: issue.Status !== undefined ? issue.Status.toString() : undefined,
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
