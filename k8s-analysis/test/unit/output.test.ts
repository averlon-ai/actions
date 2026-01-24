import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedResource, ResourceIssue } from '../../src/resource-parser';
import type { DeploymentMetadata } from '../../src/deployment-metadata';
import {
  buildAnalysisResult,
  writeJsonOutput,
  buildConsolidatedIssuesJson,
  writeConsolidatedIssuesJson,
  writeSummarySafe,
  type AnalysisResult,
  type ConsolidatedIssuesJson,
} from '../../src/output';

// Mock @actions/core
const mockCoreInfo = mock(() => {});
const mockCoreWarning = mock(() => {});
const mockCoreSetOutput = mock(() => {});
const mockSummaryWrite = mock(() => Promise.resolve());

spyOn(core, 'info').mockImplementation(mockCoreInfo);
spyOn(core, 'warning').mockImplementation(mockCoreWarning);
spyOn(core, 'setOutput').mockImplementation(mockCoreSetOutput);
spyOn(core.summary, 'write').mockImplementation(mockSummaryWrite);

// Mock fs
const mockWriteFileSync = mock(() => {});
spyOn(fs, 'writeFileSync').mockImplementation(mockWriteFileSync);

describe('output', () => {
  beforeEach(() => {
    mockCoreInfo.mockClear();
    mockCoreWarning.mockClear();
    mockCoreSetOutput.mockClear();
    mockWriteFileSync.mockClear();
    mockSummaryWrite.mockClear();
    delete process.env['ANALYSIS_JSON_PATH'];
    delete process.env['CONSOLIDATED_ISSUES_JSON_PATH'];
  });

  afterEach(() => {
    mockCoreInfo.mockClear();
    mockCoreWarning.mockClear();
    mockCoreSetOutput.mockClear();
    mockWriteFileSync.mockClear();
    mockSummaryWrite.mockClear();
  });

  describe('buildAnalysisResult', () => {
    const createResource = (
      kind: string,
      name: string,
      namespace: string = 'default',
      issues: ResourceIssue[] = [],
      metadata?: ParsedResource['metadata']
    ): ParsedResource => ({
      kind,
      name,
      namespace,
      apiVersion: 'v1',
      labels: { app: name },
      annotations: { 'deployment.kubernetes.io/revision': '1' },
      rawYaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
      issues,
      metadata,
    });

    it('should build analysis result with basic fields', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1'),
        createResource('Service', 'svc-1'),
      ];

      const result = buildAnalysisResult({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        summary: { total: 2, withIssues: 0 },
        resources,
        deploymentMetadata: null,
        filtersRaw: 'severity=High',
      });

      expect(result.chart).toBe('my-chart');
      expect(result.releaseName).toBe('my-release');
      expect(result.namespace).toBe('production');
      expect(result.totalResources).toBe(2);
      expect(result.summary).toEqual({ total: 2, withIssues: 0 });
      expect(result.filters).toBe('severity=High');
      expect(result.metadata).toBeNull();
      expect(result.resources).toHaveLength(2);
    });

    it('should map resources correctly', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1', 'production', [
          { id: 'issue-1', severity: 'High', title: 'Test Issue' },
        ]),
      ];

      const result = buildAnalysisResult({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        summary: {},
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.resources[0]).toEqual({
        kind: 'Deployment',
        name: 'app-1',
        namespace: 'production',
        arn: undefined,
        labels: { app: 'app-1' },
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        issues: [{ id: 'issue-1', severity: 'High', title: 'Test Issue' }],
        resourceMetadata: undefined,
      });
    });

    it('should include resource metadata when present', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1', 'production', [], {
          region: 'us-west-2',
          cluster: 'my-cluster',
          accountId: '123456789012',
          images: ['nginx:1.19'],
          containerNames: ['nginx'],
          replicas: 3,
        }),
      ];

      const result = buildAnalysisResult({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        summary: {},
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.resources[0].resourceMetadata).toEqual({
        region: 'us-west-2',
        cluster: 'my-cluster',
        accountId: '123456789012',
        images: ['nginx:1.19'],
        containerNames: ['nginx'],
        replicas: 3,
        serviceType: undefined,
        storageClass: undefined,
        configMapRefs: undefined,
        secretRefs: undefined,
        volumeClaims: undefined,
        referencedArns: undefined,
      });
    });

    it('should include ARN when present', () => {
      const resources: ParsedResource[] = [
        {
          ...createResource('Deployment', 'app-1'),
          arn: 'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/production/app-1',
        },
      ];

      const result = buildAnalysisResult({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        summary: {},
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.resources[0].arn).toBe(
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/production/app-1'
      );
    });

    it('should include deployment metadata when provided', () => {
      const deploymentMetadata: DeploymentMetadata = {
        region: 'us-west-2',
        cluster: 'my-cluster',
        accountId: '123456789012',
      };

      const resources: ParsedResource[] = [createResource('Deployment', 'app-1')];

      const result = buildAnalysisResult({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        summary: {},
        resources,
        deploymentMetadata,
        filtersRaw: '',
      });

      expect(result.metadata).toEqual(deploymentMetadata);
    });
  });

  describe('writeJsonOutput', () => {
    const createAnalysisResult = (): AnalysisResult => ({
      chart: 'test-chart',
      releaseName: 'test-release',
      namespace: 'default',
      totalResources: 1,
      summary: { total: 1, withIssues: 0 },
      metadata: null,
      filters: '',
      resources: [
        {
          kind: 'Deployment',
          name: 'app',
          namespace: 'default',
          labels: {},
          annotations: {},
          issues: [],
        },
      ],
    });

    it('should write JSON to default path when ANALYSIS_JSON_PATH not set', () => {
      const result = createAnalysisResult();

      writeJsonOutput(result);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const callArgs = mockWriteFileSync.mock.calls[0];
      expect(callArgs[0]).toContain('k8s-analysis-output.json');
      expect(JSON.parse(callArgs[1] as string)).toEqual(result);
      expect(callArgs[2]).toEqual({ encoding: 'utf8' });
    });

    it('should write JSON to custom path when ANALYSIS_JSON_PATH is set', () => {
      process.env['ANALYSIS_JSON_PATH'] = '/custom/path/output.json';
      const result = createAnalysisResult();

      writeJsonOutput(result);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/custom/path/output.json',
        expect.any(String),
        { encoding: 'utf8' }
      );
    });

    it('should set output variables', () => {
      const result = createAnalysisResult();

      writeJsonOutput(result);

      expect(mockCoreSetOutput).toHaveBeenCalledWith('analysis-json-path', expect.any(String));
      expect(mockCoreSetOutput).toHaveBeenCalledWith('analysis-json', expect.any(String));

      const jsonOutput = JSON.parse(
        mockCoreSetOutput.mock.calls.find(
          (call: any[]) => call[0] === 'analysis-json'
        )![1] as string
      );
      expect(jsonOutput.chart).toBe('test-chart');
      expect(jsonOutput.releaseName).toBe('test-release');
      expect(jsonOutput.namespace).toBe('default');
    });

    it('should handle write errors gracefully', () => {
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });

      const result = createAnalysisResult();

      writeJsonOutput(result);

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write analysis JSON output')
      );
    });
  });

  describe('buildConsolidatedIssuesJson', () => {
    const createResource = (
      kind: string,
      name: string,
      namespace: string = 'default',
      issues: ResourceIssue[] = []
    ): ParsedResource => ({
      kind,
      name,
      namespace,
      apiVersion: 'v1',
      labels: {},
      annotations: {},
      rawYaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}`,
      issues,
    });

    it('should build consolidated issues with metadata', () => {
      const resources: ParsedResource[] = [createResource('Deployment', 'app')];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'production',
        resources,
        deploymentMetadata: null,
        filtersRaw: 'severity=High',
      });

      expect(result.metadata.chart).toBe('my-chart');
      expect(result.metadata.releaseName).toBe('my-release');
      expect(result.metadata.namespace).toBe('production');
      expect(result.metadata.filters).toBe('severity=High');
      expect(result.metadata.timestamp).toBeDefined();
      expect(new Date(result.metadata.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should consolidate issues by ID across resources', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1', 'default', [
          { id: 'issue-1', severity: 'High', title: 'Issue 1' },
          { id: 'issue-2', severity: 'Medium', title: 'Issue 2' },
        ]),
        createResource('Deployment', 'app-2', 'default', [
          { id: 'issue-1', severity: 'High', title: 'Issue 1' }, // Duplicate issue-1
          { id: 'issue-3', severity: 'Low', title: 'Issue 3' },
        ]),
        createResource('Deployment', 'app-3', 'default', [
          { id: 'issue-1', severity: 'High', title: 'Issue 1' }, // Another duplicate
        ]),
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      // Should have 3 unique issues (issue-1 appears 3 times but is deduplicated)
      expect(result.issues).toHaveLength(3);

      const issue1 = result.issues.find(i => i.id === 'issue-1');
      expect(issue1).toBeDefined();
      expect(issue1!.affectedResources).toHaveLength(3); // Should appear in all 3 resources
      expect(issue1!.affectedResources.map(r => r.name).sort()).toEqual([
        'app-1',
        'app-2',
        'app-3',
      ]);

      expect(result.issues.find(i => i.id === 'issue-2')?.affectedResources).toHaveLength(1);
      expect(result.issues.find(i => i.id === 'issue-3')?.affectedResources).toHaveLength(1);
    });

    it('should calculate summary statistics', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1', 'default', [
          { id: 'issue-1', severity: 'High' },
          { id: 'issue-2', severity: 'Medium' },
        ]),
        createResource('Deployment', 'app-2', 'default', [{ id: 'issue-3', severity: 'Low' }]),
        createResource('Service', 'svc-1', 'default', []),
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.summary.totalResources).toBe(3);
      expect(result.summary.resourcesWithIssues).toBe(2);
      expect(result.summary.totalIssues).toBe(3);
      expect(result.summary.issuesBySeverity.High).toBe(1);
      expect(result.summary.issuesBySeverity.Medium).toBe(1);
      expect(result.summary.issuesBySeverity.Low).toBe(1);
    });

    it('should sort issues by severity', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app', 'default', [
          { id: 'issue-low', severity: 'Low' },
          { id: 'issue-critical', severity: 'Critical' },
          { id: 'issue-medium', severity: 'Medium' },
          { id: 'issue-high', severity: 'High' },
        ]),
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.issues[0].severity).toBe('Critical');
      expect(result.issues[1].severity).toBe('High');
      expect(result.issues[2].severity).toBe('Medium');
      expect(result.issues[3].severity).toBe('Low');
    });

    it('should include resources with issues', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app-1', 'default', [
          { id: 'issue-1', severity: 'High', title: 'Issue 1' },
          { id: 'issue-2', severity: 'Medium', title: 'Issue 2' },
        ]),
        createResource('Service', 'svc-1', 'default', []),
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.resourcesWithIssues).toHaveLength(1);
      expect(result.resourcesWithIssues[0].kind).toBe('Deployment');
      expect(result.resourcesWithIssues[0].name).toBe('app-1');
      expect(result.resourcesWithIssues[0].issueCount).toBe(2);
      expect(result.resourcesWithIssues[0].issues).toHaveLength(2);
    });

    it('should include ARN in affected resources when present', () => {
      const resources: ParsedResource[] = [
        {
          ...createResource('Deployment', 'app', 'default', [{ id: 'issue-1', severity: 'High' }]),
          arn: 'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app',
        },
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.issues[0].affectedResources[0].arn).toBe(
        'arn:aws:eks:us-west-2:123456789012:cluster/test-cluster/Deployment/default/app'
      );
    });

    it('should handle issues with missing severity', () => {
      const resources: ParsedResource[] = [
        createResource('Deployment', 'app', 'default', [
          { id: 'issue-1' }, // No severity
        ]),
      ];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata: null,
        filtersRaw: '',
      });

      expect(result.issues[0].severity).toBe('Unknown');
      expect(result.summary.issuesBySeverity.Unknown).toBe(1);
    });

    it('should include deployment metadata when provided', () => {
      const deploymentMetadata: DeploymentMetadata = {
        region: 'us-west-2',
        cluster: 'my-cluster',
        accountId: '123456789012',
      };

      const resources: ParsedResource[] = [createResource('Deployment', 'app')];

      const result = buildConsolidatedIssuesJson({
        chartName: 'my-chart',
        releaseName: 'my-release',
        namespace: 'default',
        resources,
        deploymentMetadata,
        filtersRaw: '',
      });

      expect(result.metadata.deploymentMetadata).toEqual(deploymentMetadata);
    });
  });

  describe('writeConsolidatedIssuesJson', () => {
    const createConsolidatedIssues = (): ConsolidatedIssuesJson => ({
      metadata: {
        chart: 'test-chart',
        releaseName: 'test-release',
        namespace: 'default',
        timestamp: new Date().toISOString(),
        filters: '',
      },
      summary: {
        totalResources: 1,
        resourcesWithIssues: 0,
        totalIssues: 0,
        issuesBySeverity: {},
      },
      issues: [],
      resourcesWithIssues: [],
    });

    it('should write JSON to default path when CONSOLIDATED_ISSUES_JSON_PATH not set', () => {
      const consolidated = createConsolidatedIssues();

      writeConsolidatedIssuesJson(consolidated);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const callArgs = mockWriteFileSync.mock.calls[0];
      expect(callArgs[0]).toContain('consolidated-issues.json');
      expect(JSON.parse(callArgs[1] as string)).toEqual(consolidated);
    });

    it('should write JSON to custom path when CONSOLIDATED_ISSUES_JSON_PATH is set', () => {
      process.env['CONSOLIDATED_ISSUES_JSON_PATH'] = '/custom/path/consolidated.json';
      const consolidated = createConsolidatedIssues();

      writeConsolidatedIssuesJson(consolidated);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/custom/path/consolidated.json',
        expect.any(String),
        { encoding: 'utf8' }
      );
    });

    it('should set output variables', () => {
      const consolidated = createConsolidatedIssues();

      writeConsolidatedIssuesJson(consolidated);

      expect(mockCoreSetOutput).toHaveBeenCalledWith(
        'consolidated-issues-json-path',
        expect.any(String)
      );
      expect(mockCoreSetOutput).toHaveBeenCalledWith(
        'consolidated-issues-json',
        expect.any(String)
      );

      const jsonOutput = JSON.parse(
        mockCoreSetOutput.mock.calls.find(
          (call: any[]) => call[0] === 'consolidated-issues-json'
        )![1] as string
      );
      expect(jsonOutput.chart).toBe('test-chart');
      expect(jsonOutput.totalIssues).toBe(0);
    });

    it('should handle write errors gracefully', () => {
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error('Disk full');
      });

      const consolidated = createConsolidatedIssues();

      writeConsolidatedIssuesJson(consolidated);

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write consolidated issues JSON')
      );
    });
  });

  describe('writeSummarySafe', () => {
    it('should write summary successfully', async () => {
      mockSummaryWrite.mockResolvedValueOnce(undefined);

      await writeSummarySafe();

      expect(mockSummaryWrite).toHaveBeenCalled();
      expect(mockCoreWarning).not.toHaveBeenCalled();
    });

    it('should handle summary write errors gracefully', async () => {
      mockSummaryWrite.mockRejectedValueOnce(new Error('Summary write failed'));

      await writeSummarySafe();

      expect(mockCoreWarning).toHaveBeenCalledWith(
        expect.stringContaining('Skipping step summary')
      );
    });
  });
});
