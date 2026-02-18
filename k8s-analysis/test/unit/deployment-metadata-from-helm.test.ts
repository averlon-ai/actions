/**
 * Tests that run the full parse pipeline on realistic helm template output (fixtures).
 * Ensures metadata extraction works on actual YAML structure produced by helm template.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseHelmDryRunOutput, parseHelmManifest } from '../../src/resource-parser';
import { extractMetadataFromResources } from '../../src/deployment-metadata';

const FIXTURES_DIR = path.join(import.meta.dir, '..', 'fixtures');

function loadFixture(name: string): string {
  const filePath = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

describe('extractMetadataFromResources (from helm template output fixtures)', () => {
  beforeEach(() => {
    spyOn(core, 'info').mockImplementation(() => {});
    spyOn(core, 'debug').mockImplementation(() => {});
    spyOn(core, 'warning').mockImplementation(() => {});
  });

  afterEach(() => {
    (core.info as ReturnType<typeof spyOn>).mockRestore();
    (core.debug as ReturnType<typeof spyOn>).mockRestore();
    (core.warning as ReturnType<typeof spyOn>).mockRestore();
  });

  test('AWS fixture: extracts region, cluster, accountId from helm-output-aws.yaml', () => {
    const content = loadFixture('helm-output-aws.yaml');
    const parsed = parseHelmDryRunOutput(content);
    const resources = parseHelmManifest(parsed.manifestYaml);
    const result = extractMetadataFromResources(resources);

    expect(result.region).toBe('us-west-2');
    expect(result.cluster).toBe('demo-prod-eks');
    expect(result.accountId).toBe('111222333444');
  });

  test('Azure fixture: extracts region, cluster, accountId from helm-output-azure.yaml', () => {
    const content = loadFixture('helm-output-azure.yaml');
    const parsed = parseHelmDryRunOutput(content);
    const resources = parseHelmManifest(parsed.manifestYaml);
    const result = extractMetadataFromResources(resources);

    expect(result.region).toBe('eastus');
    expect(result.cluster).toBe('demo-azure-prod');
    expect(result.accountId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  test('AWS fixture: parsed resource count and structure', () => {
    const content = loadFixture('helm-output-aws.yaml');
    const parsed = parseHelmDryRunOutput(content);
    const resources = parseHelmManifest(parsed.manifestYaml);

    expect(resources.length).toBeGreaterThanOrEqual(3);
    const kinds = resources.map(r => r.kind);
    expect(kinds).toContain('ConfigMap');
    expect(kinds).toContain('ServiceAccount');
    expect(kinds).toContain('Deployment');

    const configMap = resources.find(r => r.kind === 'ConfigMap');
    expect(configMap?.namespace).toBe('demo');
    expect(configMap?.data).toBeDefined();
    expect(
      Object.values(configMap?.data ?? {}).some(
        v => typeof v === 'string' && v.includes('demo-prod-eks')
      )
    ).toBe(true);
  });

  test('Azure fixture: parsed resource count and ConfigMap data', () => {
    const content = loadFixture('helm-output-azure.yaml');
    const parsed = parseHelmDryRunOutput(content);
    const resources = parseHelmManifest(parsed.manifestYaml);

    expect(resources.length).toBeGreaterThanOrEqual(2);
    const configMap = resources.find(r => r.kind === 'ConfigMap');
    expect(configMap?.name).toBe('demo-aks-config');
    expect(configMap?.data?.['config.yaml']).toContain('location: eastus');
    expect(configMap?.data?.['config.yaml']).toContain('/subscriptions/');
  });
});
