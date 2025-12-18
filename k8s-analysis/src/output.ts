import * as core from '@actions/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DeploymentMetadata } from './deployment-metadata';
import { ParsedResource, ResourceIssue } from './resource-parser';

export interface AnalysisResult {
  chart: string;
  releaseName: string;
  namespace: string;
  totalResources: number;
  summary: Record<string, number>;
  metadata: DeploymentMetadata | null;
  filters: string;
  resources: Array<{
    kind: string;
    name: string;
    namespace: string;
    arn?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    issues: ResourceIssue[];
    resourceMetadata?: {
      region?: string;
      cluster?: string;
      accountId?: string;
      images?: string[];
      containerNames?: string[];
      replicas?: number;
      serviceType?: string;
      storageClass?: string;
      configMapRefs?: string[];
      secretRefs?: string[];
      volumeClaims?: string[];
      referencedArns?: string[];
    };
  }>;
}

export interface ConsolidatedIssue {
  id: string;
  severity: string;
  severityValue?: number;
  title?: string;
  summary?: string;
  type?: string;
  status?: string;
  affectedResources: Array<{
    kind: string;
    name: string;
    namespace: string;
    arn?: string;
  }>;
}

export interface ConsolidatedIssuesJson {
  metadata: {
    chart: string;
    releaseName: string;
    namespace: string;
    timestamp: string;
    filters: string;
    deploymentMetadata?: DeploymentMetadata;
  };
  summary: {
    totalResources: number;
    resourcesWithIssues: number;
    totalIssues: number;
    issuesBySeverity: Record<string, number>;
  };
  issues: ConsolidatedIssue[];
  resourcesWithIssues: Array<{
    kind: string;
    name: string;
    namespace: string;
    arn?: string;
    issueCount: number;
    issues: Array<{
      id: string;
      severity: string;
      title?: string;
      summary?: string;
    }>;
  }>;
}

export function buildAnalysisResult(args: {
  chartName: string;
  releaseName: string;
  namespace: string;
  summary: Record<string, number>;
  resources: ParsedResource[];
  deploymentMetadata: DeploymentMetadata | null;
  filtersRaw: string;
}): AnalysisResult {
  const { chartName, releaseName, namespace, summary, resources, deploymentMetadata, filtersRaw } =
    args;
  return {
    chart: chartName,
    releaseName,
    namespace,
    totalResources: resources.length,
    summary,
    metadata: deploymentMetadata,
    filters: filtersRaw,
    resources: resources.map(resource => ({
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      arn: resource.arn,
      labels: resource.labels,
      annotations: resource.annotations,
      issues: resource.issues ?? [],
      resourceMetadata: resource.metadata
        ? {
            region: resource.metadata.region,
            cluster: resource.metadata.cluster,
            accountId: resource.metadata.accountId,
            images: resource.metadata.images,
            containerNames: resource.metadata.containerNames,
            replicas: resource.metadata.replicas,
            serviceType: resource.metadata.serviceType,
            storageClass: resource.metadata.storageClass,
            configMapRefs: resource.metadata.configMapRefs,
            secretRefs: resource.metadata.secretRefs,
            volumeClaims: resource.metadata.volumeClaims,
            referencedArns: resource.metadata.referencedArns,
          }
        : undefined,
    })),
  };
}

export function writeJsonOutput(result: AnalysisResult): void {
  try {
    const outputPath =
      process.env['ANALYSIS_JSON_PATH'] || path.join(process.cwd(), 'k8s-analysis-output.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8' });
    core.info(`JSON analysis written to ${outputPath}`);
    core.setOutput('analysis-json-path', outputPath);
    const summaryPayload = {
      chart: result.chart,
      releaseName: result.releaseName,
      namespace: result.namespace,
      totalResources: result.totalResources,
      filters: result.filters,
      outputPath,
    };
    core.setOutput('analysis-json', JSON.stringify(summaryPayload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to write analysis JSON output: ${message}`);
  }
}

export function buildConsolidatedIssuesJson(args: {
  chartName: string;
  releaseName: string;
  namespace: string;
  resources: ParsedResource[];
  deploymentMetadata: DeploymentMetadata | null;
  filtersRaw: string;
}): ConsolidatedIssuesJson {
  const { chartName, releaseName, namespace, resources, deploymentMetadata, filtersRaw } = args;

  const issueMap = new Map<string, ConsolidatedIssue>();
  const issuesBySeverity: Record<string, number> = {};
  const resourcesWithIssuesArray: ConsolidatedIssuesJson['resourcesWithIssues'] = [];

  for (const resource of resources) {
    if (!resource.issues || resource.issues.length === 0) {
      continue;
    }

    resourcesWithIssuesArray.push({
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      arn: resource.arn,
      issueCount: resource.issues.length,
      issues: resource.issues.map(issue => ({
        id: issue.id,
        severity: issue.severity ?? 'Unknown',
        title: issue.title,
        summary: issue.summary,
      })),
    });

    for (const issue of resource.issues) {
      const severity = issue.severity ?? 'Unknown';
      issuesBySeverity[severity] = (issuesBySeverity[severity] || 0) + 1;

      if (issueMap.has(issue.id)) {
        const existingIssue = issueMap.get(issue.id)!;
        existingIssue.affectedResources.push({
          kind: resource.kind,
          name: resource.name,
          namespace: resource.namespace,
          arn: resource.arn,
        });
      } else {
        issueMap.set(issue.id, {
          id: issue.id,
          severity: issue.severity ?? 'Unknown',
          severityValue: issue.severityValue,
          title: issue.title,
          summary: issue.summary,
          type: issue.type,
          status: issue.status,
          affectedResources: [
            {
              kind: resource.kind,
              name: resource.name,
              namespace: resource.namespace,
              arn: resource.arn,
            },
          ],
        });
      }
    }
  }

  const consolidatedIssues = Array.from(issueMap.values());

  const severityOrder: Record<string, number> = {
    Critical: 0,
    High: 1,
    Medium: 2,
    Low: 3,
    Unknown: 4,
  };
  consolidatedIssues.sort((a, b) => {
    const orderA = severityOrder[a.severity] ?? 999;
    const orderB = severityOrder[b.severity] ?? 999;
    return orderA - orderB;
  });

  return {
    metadata: {
      chart: chartName,
      releaseName,
      namespace,
      timestamp: new Date().toISOString(),
      filters: filtersRaw,
      deploymentMetadata: deploymentMetadata || undefined,
    },
    summary: {
      totalResources: resources.length,
      resourcesWithIssues: resourcesWithIssuesArray.length,
      totalIssues: consolidatedIssues.length,
      issuesBySeverity,
    },
    issues: consolidatedIssues,
    resourcesWithIssues: resourcesWithIssuesArray,
  };
}

export function writeConsolidatedIssuesJson(consolidated: ConsolidatedIssuesJson): void {
  try {
    const outputPath =
      process.env['CONSOLIDATED_ISSUES_JSON_PATH'] ||
      path.join(process.cwd(), 'consolidated-issues.json');
    fs.writeFileSync(outputPath, JSON.stringify(consolidated, null, 2), { encoding: 'utf8' });
    core.info(`✓ Consolidated issues written to ${outputPath}`);
    core.setOutput('consolidated-issues-json-path', outputPath);
    const summaryPayload = {
      chart: consolidated.metadata.chart,
      releaseName: consolidated.metadata.releaseName,
      namespace: consolidated.metadata.namespace,
      totalIssues: consolidated.summary.totalIssues,
      resourcesWithIssues: consolidated.summary.resourcesWithIssues,
      outputPath,
    };
    core.setOutput('consolidated-issues-json', JSON.stringify(summaryPayload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to write consolidated issues JSON: ${message}`);
  }
}

export async function writeSummarySafe(): Promise<void> {
  try {
    await core.summary.write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Skipping step summary: ${message}`);
  }
}
