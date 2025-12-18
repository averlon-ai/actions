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
    it('parses multi-document Helm template YAML', () => {
      const yamlInput = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: default
---
apiVersion: v1
kind: Service
metadata:
  name: test-service
  namespace: default`;

      const result = parseHelmDryRunOutput(yamlInput);

      expect(result.manifestYaml).toContain('kind: Pod');
      expect(result.manifestYaml).toContain('kind: Service');
      expect(result.manifestYaml).toContain('---');
      expect(result.userSuppliedValues).toBeUndefined();
      expect(result.releaseName).toBeUndefined();
      expect(result.namespace).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledWith('✓ Parsed 2 Kubernetes resources from YAML input');
    });

    it('filters out invalid documents without kind/apiVersion', () => {
      const yamlInput = `---
apiVersion: v1
kind: Pod
metadata:
  name: valid-pod
---
metadata:
  name: invalid-resource
---
apiVersion: v1
metadata:
  name: missing-kind`;

      const result = parseHelmDryRunOutput(yamlInput);

      expect(result.manifestYaml).toContain('kind: Pod');
      expect(result.manifestYaml).toContain('name: valid-pod');
      expect(result.manifestYaml).not.toContain('invalid-resource');
      expect(infoSpy).toHaveBeenCalledWith('✓ Parsed 1 Kubernetes resources from YAML input');
    });

    it('throws error for empty input', () => {
      expect(() => parseHelmDryRunOutput('')).toThrow('Input is empty');
      expect(() => parseHelmDryRunOutput('   ')).toThrow('Input is empty');
    });

    it('throws error for invalid YAML', () => {
      const badYaml = `apiVersion: v1
kind: Pod
metadata
  name: broken`;

      expect(() => parseHelmDryRunOutput(badYaml)).toThrow(/Failed to parse YAML input/);
    });

    it('throws when no valid Kubernetes resources found', () => {
      const yamlInput = `---
foo: bar
---
metadata:
  name: still-invalid`;

      expect(() => parseHelmDryRunOutput(yamlInput)).toThrow(
        'No valid Kubernetes resources found. Each resource must have "kind" and "apiVersion" fields'
      );
    });
  });
});
