import { describe, it, expect } from 'bun:test';
import {
  parseHelmManifest,
  groupResourcesByKind,
  getResourceIdentifier,
  filterResourcesByKind,
  getResourceSummary,
  extractContainerImages,
} from '../../src/resource-parser';

describe('resource-parser', () => {
  describe('parseHelmManifest', () => {
    it('should parse a valid YAML manifest', () => {
      const yaml = `---
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

      const resources = parseHelmManifest(yaml);

      expect(resources.length).toBe(2);
      expect(resources[0].kind).toBe('Pod');
      expect(resources[0].name).toBe('test-pod');
      expect(resources[1].kind).toBe('Service');
      expect(resources[1].name).toBe('test-service');
    });

    it('should skip empty documents', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
---

---
apiVersion: v1
kind: Service
metadata:
  name: test-service`;

      const resources = parseHelmManifest(yaml);

      expect(resources.length).toBe(2);
    });

    it('should skip documents without required fields', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
---
apiVersion: v1
kind: Service
metadata:
  name: test-service`;

      const resources = parseHelmManifest(yaml);

      expect(resources.length).toBe(1);
      expect(resources[0].kind).toBe('Service');
    });

    it('should use default namespace when not specified', () => {
      const yaml = `---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].namespace).toBe('default');
    });
  });

  describe('groupResourcesByKind', () => {
    it('should group resources by kind', () => {
      const resources = [
        {
          kind: 'Pod',
          name: 'pod-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Pod',
          name: 'pod-2',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Service',
          name: 'svc-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
      ];

      const grouped = groupResourcesByKind(resources);

      expect(grouped.get('Pod')?.length).toBe(2);
      expect(grouped.get('Service')?.length).toBe(1);
    });
  });

  describe('getResourceIdentifier', () => {
    it('should generate correct resource identifier', () => {
      const resource = {
        kind: 'Pod',
        name: 'test-pod',
        namespace: 'default',
        apiVersion: 'v1',
        labels: {},
        annotations: {},
        rawYaml: '',
      };

      const identifier = getResourceIdentifier(resource);

      expect(identifier).toBe('Pod/default/test-pod');
    });
  });

  describe('filterResourcesByKind', () => {
    it('should filter resources by kind', () => {
      const resources = [
        {
          kind: 'Pod',
          name: 'pod-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Service',
          name: 'svc-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Deployment',
          name: 'dep-1',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
      ];

      const filtered = filterResourcesByKind(resources, ['Pod', 'Service']);

      expect(filtered.length).toBe(2);
      expect(filtered.some(r => r.kind === 'Deployment')).toBe(false);
    });
  });

  describe('getResourceSummary', () => {
    it('should generate resource summary', () => {
      const resources = [
        {
          kind: 'Pod',
          name: 'pod-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Pod',
          name: 'pod-2',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'Service',
          name: 'svc-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
        },
      ];

      const summary = getResourceSummary(resources);

      expect(summary['Pod']).toBe(2);
      expect(summary['Service']).toBe(1);
    });
  });

  describe('extractContainerImages', () => {
    it('should extract images from Deployment', () => {
      const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.19
        - name: sidecar
          image: busybox:latest
      initContainers:
        - name: init
          image: alpine:3.12`;

      const resource = {
        kind: 'Deployment',
        name: 'test-deployment',
        namespace: 'default',
        apiVersion: 'apps/v1',
        labels: {},
        annotations: {},
        rawYaml: yaml,
      };

      const images = extractContainerImages(resource);

      expect(images.length).toBe(3);
      expect(images).toContain('nginx:1.19');
      expect(images).toContain('busybox:latest');
      expect(images).toContain('alpine:3.12');
    });

    it('should extract images from Pod', () => {
      const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: app
      image: nginx:1.19`;

      const resource = {
        kind: 'Pod',
        name: 'test-pod',
        namespace: 'default',
        apiVersion: 'v1',
        labels: {},
        annotations: {},
        rawYaml: yaml,
      };

      const images = extractContainerImages(resource);

      expect(images.length).toBe(1);
      expect(images).toContain('nginx:1.19');
    });

    it('should return empty array for resources without containers', () => {
      const yaml = `apiVersion: v1
kind: Service
metadata:
  name: test-service`;

      const resource = {
        kind: 'Service',
        name: 'test-service',
        namespace: 'default',
        apiVersion: 'v1',
        labels: {},
        annotations: {},
        rawYaml: yaml,
      };

      const images = extractContainerImages(resource);

      expect(images.length).toBe(0);
    });
  });
});
