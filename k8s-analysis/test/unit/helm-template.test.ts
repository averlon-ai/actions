import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as core from '@actions/core';
import { parseHelmDryRunOutput } from '../../src/resource-parser';

describe('helm-template', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let warningSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(core, 'info').mockImplementation(() => {});
    warningSpy = spyOn(core, 'warning').mockImplementation(() => {});
    errorSpy = spyOn(core, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('parseHelmDryRunOutput', () => {
    it('should parse valid JSON array of Kubernetes resources', () => {
      const jsonInput = JSON.stringify([
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'test-pod',
            namespace: 'default',
          },
          spec: {
            containers: [
              {
                name: 'test-container',
                image: 'nginx:latest',
              },
            ],
          },
        },
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'test-service',
            namespace: 'default',
          },
          spec: {
            selector: {
              app: 'test',
            },
            ports: [
              {
                port: 80,
                targetPort: 80,
              },
            ],
          },
        },
      ]);

      const result = parseHelmDryRunOutput(jsonInput);

      expect(result.manifestYaml).toContain('apiVersion: v1');
      expect(result.manifestYaml).toContain('kind: Pod');
      expect(result.manifestYaml).toContain('kind: Service');
      expect(result.manifestYaml).toContain('---');
      expect(result.userSuppliedValues).toBeUndefined();
      expect(result.releaseName).toBeUndefined();
      expect(result.namespace).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledWith('✓ Parsed 2 Kubernetes resources from JSON input');
    });

    it('should parse single Kubernetes resource object', () => {
      const jsonInput = JSON.stringify({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'single-pod',
          namespace: 'default',
        },
        spec: {
          containers: [
            {
              name: 'test-container',
              image: 'nginx:latest',
            },
          ],
        },
      });

      const result = parseHelmDryRunOutput(jsonInput);

      expect(result.manifestYaml).toContain('apiVersion: v1');
      expect(result.manifestYaml).toContain('kind: Pod');
      expect(result.manifestYaml).toContain('name: single-pod');
      expect(infoSpy).toHaveBeenCalledWith('✓ Parsed 1 Kubernetes resources from JSON input');
    });

    it('should filter out invalid resources without kind and apiVersion', () => {
      const jsonInput = JSON.stringify([
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'valid-pod',
          },
        },
        {
          // Missing apiVersion and kind
          metadata: {
            name: 'invalid-resource',
          },
        },
        {
          apiVersion: 'v1',
          // Missing kind
          metadata: {
            name: 'invalid-resource-2',
          },
        },
      ]);

      const result = parseHelmDryRunOutput(jsonInput);

      expect(result.manifestYaml).toContain('kind: Pod');
      expect(result.manifestYaml).toContain('name: valid-pod');
      expect(result.manifestYaml).not.toContain('invalid-resource');
      expect(infoSpy).toHaveBeenCalledWith('✓ Parsed 1 Kubernetes resources from JSON input');
    });

    it('should throw error for empty input', () => {
      expect(() => parseHelmDryRunOutput('')).toThrow('Input is empty');
      expect(() => parseHelmDryRunOutput('   ')).toThrow('Input is empty');
    });

    it('should throw error for invalid JSON', () => {
      expect(() => parseHelmDryRunOutput('invalid json')).toThrow(
        'Invalid JSON format. Please provide valid JSON array of Kubernetes resources.'
      );
    });

    it('should throw error when no valid Kubernetes resources found', () => {
      const jsonInput = JSON.stringify([
        { metadata: { name: 'no-kind' } },
        { kind: 'Pod' }, // Missing apiVersion
      ]);

      expect(() => parseHelmDryRunOutput(jsonInput)).toThrow(
        'No valid Kubernetes resources found. Each resource must have "kind" and "apiVersion" fields'
      );
    });

    it('should throw error for non-object input', () => {
      expect(() => parseHelmDryRunOutput('"just a string"')).toThrow(
        'JSON input must be an object or array of objects'
      );
      expect(() => parseHelmDryRunOutput('123')).toThrow(
        'JSON input must be an object or array of objects'
      );
    });

    it('should parse raw helm dry-run output with user values', () => {
      const helmOutput = `
NAME: demo-release
LAST DEPLOYED: Tue Jan  2 12:34:56 2024
NAMESPACE: staging
STATUS: pending-install
REVISION: 1
TEST SUITE: None

USER-SUPPLIED VALUES:
app:
  account_id: "123456789012"
  region: us-west-2

COMPUTED VALUES:
replicaCount: 2

MANIFEST:
---
# Source: demo/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
`;

      const result = parseHelmDryRunOutput(helmOutput);
      expect(result.releaseName).toBe('demo-release');
      expect(result.namespace).toBe('staging');
      expect(result.userSuppliedValues).toContain('account_id');
      expect(result.manifestYaml).toContain('kind: Deployment');
    });

    it('should throw when MANIFEST section is missing in text output', () => {
      const invalidOutput = `
NAME: missing-manifest
NAMESPACE: default
USER-SUPPLIED VALUES:
foo: bar
`;
      expect(() => parseHelmDryRunOutput(invalidOutput)).toThrow(
        'MANIFEST section not found in Helm dry-run output. Provide full helm output.'
      );
    });
  });
});
