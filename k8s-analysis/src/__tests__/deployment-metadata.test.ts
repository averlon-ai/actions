import { describe, expect, test } from 'bun:test';
import { extractMetadataFromResources } from '../deployment-metadata';
import type { ParsedResource } from '../resource-parser';

describe('extractMetadataFromResources', () => {
  describe('ConfigMap extraction (highest priority)', () => {
    test('extracts region and cluster from ConfigMap data', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'app-config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': `
hub_region: us-west-2
cluster: production-eks
environment: prod
`,
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('us-west-2');
      expect(result.cluster).toBe('production-eks');
    });

    test('extracts cluster: secdi-dev correctly (not secdi)', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'secdi-etc',
          namespace: 'secdi',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'secdi-config-yaml': `
---
hub_region: us-west-2
region: \${SECDI_AWS_REGION}
environment: dev
service: secdi
cluster: secdi-dev

log_levels:
  - repo: "*"
    level: TRACE
`,
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('us-west-2');
      expect(result.cluster).toBe('secdi-dev'); // NOT "secdi"!
    });

    test('ConfigMap takes priority over labels', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'Deployment',
          name: 'my-app',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {
            'app.kubernetes.io/instance': 'wrong-cluster', // This should be ignored
          },
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'ConfigMap',
          name: 'app-config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': 'cluster: correct-cluster\nregion: us-east-1',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.cluster).toBe('correct-cluster'); // ConfigMap wins!
      expect(result.region).toBe('us-east-1');
    });

    test('extracts region and accountId from ARNs in ConfigMap', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'app-config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': `
certificate_arn: arn:aws:acm:eu-west-1:123456789012:certificate/abc123
waf_arn: arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/my-waf
`,
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('eu-west-1');
      expect(result.accountId).toBe('123456789012');
    });

    test('skips environment variables like ${VAR}', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'app-config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'env-template.yaml': `
# Environment variable placeholders (should be skipped)
region: \${AWS_REGION}
cluster: \${CLUSTER_NAME}
`,
            'actual-config.yaml': `
# Actual values (should be extracted)
region: ap-south-1
cluster: mumbai-prod
`,
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('ap-south-1'); // Not ${AWS_REGION}
      expect(result.cluster).toBe('mumbai-prod'); // Not ${CLUSTER_NAME}
    });
  });

  describe('Label extraction (fallback)', () => {
    test('extracts region from topology labels when no ConfigMap', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'Node',
          name: 'worker-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {
            'topology.kubernetes.io/region': 'us-west-2',
            'topology.kubernetes.io/zone': 'us-west-2a',
          },
          annotations: {},
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('us-west-2');
    });

    test('extracts region from zone label', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'Node',
          name: 'worker-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {
            'topology.kubernetes.io/zone': 'eu-central-1b',
          },
          annotations: {},
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('eu-central-1');
    });

    test('extracts cluster from app.kubernetes.io/instance label', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'Deployment',
          name: 'my-app',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {
            'app.kubernetes.io/instance': 'staging-cluster',
          },
          annotations: {},
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.cluster).toBe('staging-cluster');
    });
  });

  describe('Annotation extraction (fallback)', () => {
    test('extracts cluster from EKS annotations', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ServiceAccount',
          name: 'my-sa',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {
            'eks.amazonaws.com/cluster-name': 'prod-cluster',
          },
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.cluster).toBe('prod-cluster');
    });

    test('extracts region and accountId from IAM role ARN', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ServiceAccount',
          name: 'my-sa',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {
            'eks.amazonaws.com/role-arn': 'arn:aws:iam::987654321098:role/my-app-role',
          },
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.accountId).toBe('987654321098');
      // IAM ARNs don't have region (it's empty in the ARN)
    });

    test('extracts region from ACM certificate ARN in annotations', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'Ingress',
          name: 'my-ingress',
          namespace: 'default',
          apiVersion: 'networking.k8s.io/v1',
          labels: {},
          annotations: {
            'alb.ingress.kubernetes.io/certificate-arn':
              'arn:aws:acm:ap-southeast-1:555555555555:certificate/xyz789',
          },
          rawYaml: '',
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.region).toBe('ap-southeast-1');
      expect(result.accountId).toBe('555555555555');
    });
  });

  describe('Priority order verification', () => {
    test('ConfigMap > Labels > Annotations', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ServiceAccount',
          name: 'sa-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {
            'eks.amazonaws.com/cluster-name': 'cluster-from-annotation',
          },
          rawYaml: '',
        },
        {
          kind: 'Deployment',
          name: 'deploy-1',
          namespace: 'default',
          apiVersion: 'apps/v1',
          labels: {
            'app.kubernetes.io/instance': 'cluster-from-label',
          },
          annotations: {},
          rawYaml: '',
        },
        {
          kind: 'ConfigMap',
          name: 'config-1',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'app.yaml': 'cluster: cluster-from-configmap\nregion: us-west-2',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      expect(result.cluster).toBe('cluster-from-configmap'); // ConfigMap wins!
      expect(result.region).toBe('us-west-2');
    });
  });

  describe('Multiple pattern variations', () => {
    test('matches "cluster:" pattern', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': 'cluster: my-cluster',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);
      expect(result.cluster).toBe('my-cluster');
    });

    test('matches "cluster_name:" pattern', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': 'cluster_name: my-cluster',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);
      expect(result.cluster).toBe('my-cluster');
    });

    test('matches "eks_cluster:" pattern', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'config.yaml': 'eks_cluster: my-cluster',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);
      expect(result.cluster).toBe('my-cluster');
    });

    test('matches "CLUSTER_NAME=" pattern', () => {
      const resources: ParsedResource[] = [
        {
          kind: 'ConfigMap',
          name: 'config',
          namespace: 'default',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'env.sh': 'CLUSTER_NAME=my-cluster\nREGION=us-east-1',
          },
        },
      ];

      const result = extractMetadataFromResources(resources);
      expect(result.cluster).toBe('my-cluster');
    });
  });

  describe('Real-world secdi scenario', () => {
    test('extracts correct metadata from secdi manifests', () => {
      const resources: ParsedResource[] = [
        // First resource: ServiceAccount with instance label
        {
          kind: 'ServiceAccount',
          name: 'secdi-backend',
          namespace: 'secdi',
          apiVersion: 'v1',
          labels: {
            'app.kubernetes.io/instance': 'secdi', // This should NOT win!
          },
          annotations: {
            'eks.amazonaws.com/role-arn': 'arn:aws:iam::427296646876:role/secdi-dev-backend',
          },
          rawYaml: '',
        },
        // Second resource: ConfigMap with correct cluster name
        {
          kind: 'ConfigMap',
          name: 'secdi-etc',
          namespace: 'secdi',
          apiVersion: 'v1',
          labels: {},
          annotations: {},
          rawYaml: '',
          data: {
            'secdi-config-yaml': `---
hub_region: us-west-2
region: \${SECDI_AWS_REGION}
environment: dev
service: secdi
cluster: secdi-dev
auth_cognito_clients: true
auth_url: https://wfe.dev.averlon.io/v1/auth/authorize
`,
          },
        },
      ];

      const result = extractMetadataFromResources(resources);

      // Verify ConfigMap data wins over label
      expect(result.region).toBe('us-west-2');
      expect(result.cluster).toBe('secdi-dev'); // NOT "secdi"!
      expect(result.accountId).toBe('427296646876');
    });
  });
});
