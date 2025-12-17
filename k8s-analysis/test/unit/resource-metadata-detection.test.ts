import { describe, it, expect } from 'bun:test';
import { parseHelmManifest, type ParsedResource } from '../../src/resource-parser';

describe('Resource-Level Metadata Detection', () => {
  describe('extractMetadataFromResources', () => {
    /**
     * Helper function to simulate the extractMetadataFromResources logic
     * This is tested indirectly through the action's main flow
     */
    function extractMetadataFromResources(resources: ParsedResource[]): {
      region?: string;
      cluster?: string;
      accountId?: string;
    } {
      let region: string | undefined;
      let cluster: string | undefined;
      let accountId: string | undefined;

      for (const resource of resources) {
        if (region && cluster && accountId) {
          break;
        }

        if (resource.metadata) {
          if (!region) {
            region = resource.metadata.region || resource.metadata.awsRegion;
          }
          if (!cluster) {
            cluster = resource.metadata.cluster;
          }
          if (!accountId) {
            accountId = resource.metadata.accountId;
          }
        }

        // Fallback: Check labels directly
        if (!region && resource.labels) {
          region =
            resource.labels['topology.kubernetes.io/region'] ||
            resource.labels['failure-domain.beta.kubernetes.io/region'];

          if (!region) {
            const zone =
              resource.labels['topology.kubernetes.io/zone'] ||
              resource.labels['failure-domain.beta.kubernetes.io/zone'];
            if (zone) {
              const match = zone.match(/^(.+)[a-z]$/);
              if (match) {
                region = match[1];
              }
            }
          }
        }

        // Fallback: Check annotations
        if (resource.annotations) {
          if (!cluster) {
            cluster = resource.annotations['eks.amazonaws.com/cluster-name'];
          }
          if (!region) {
            region = resource.annotations['aws.amazon.com/region'];
          }
          if (!accountId) {
            accountId = resource.annotations['aws.amazon.com/account-id'];
          }
        }

        // Fallback: Check labels for cluster
        if (!cluster && resource.labels) {
          cluster = resource.labels['cluster'] || resource.labels['eks.amazonaws.com/cluster'];
        }
      }

      return { region, cluster, accountId };
    }

    it('should detect region from first resource with topology label', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app2
  labels:
    topology.kubernetes.io/region: us-east-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBe('us-west-2');
    });

    it('should detect cluster from any resource', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: svc1
spec:
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    cluster: prod-cluster
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.cluster).toBe('prod-cluster');
    });

    it('should detect account ID from annotations', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  annotations:
    aws.amazon.com/account-id: "123456789012"
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.accountId).toBe('123456789012');
    });

    it('should detect account ID from ARNs in environment variables', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          env:
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::987654321098:role/app-role"`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.accountId).toBe('987654321098');
    });

    it('should detect all metadata from multiple resources', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: svc1
  labels:
    topology.kubernetes.io/region: eu-central-1
spec:
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    cluster: staging-cluster
  annotations:
    aws.amazon.com/account-id: "111222333444"
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBe('eu-central-1');
      expect(detected.cluster).toBe('staging-cluster');
      expect(detected.accountId).toBe('111222333444');
    });

    it('should extract region from zone when region label not present', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    topology.kubernetes.io/zone: ap-south-1b
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBe('ap-south-1');
    });

    it('should prioritize region label over zone extraction', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    topology.kubernetes.io/region: us-east-1
    topology.kubernetes.io/zone: us-west-2a
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBe('us-east-1');
    });

    it('should stop searching after finding all metadata', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    topology.kubernetes.io/region: us-west-2
    cluster: prod-cluster
  annotations:
    aws.amazon.com/account-id: "123456789012"
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app2
  labels:
    topology.kubernetes.io/region: eu-central-1
    cluster: test-cluster
  annotations:
    aws.amazon.com/account-id: "999888777666"
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      // Should use first resource's metadata
      expect(detected.region).toBe('us-west-2');
      expect(detected.cluster).toBe('prod-cluster');
      expect(detected.accountId).toBe('123456789012');
    });

    it('should use EKS cluster annotation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  annotations:
    eks.amazonaws.com/cluster-name: my-eks-cluster
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.cluster).toBe('my-eks-cluster');
    });

    it('should handle resources with no metadata', () => {
      const yaml = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: config1
data:
  key: value`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBeUndefined();
      expect(detected.cluster).toBeUndefined();
      expect(detected.accountId).toBeUndefined();
    });

    it('should handle empty resource list', () => {
      const resources: ParsedResource[] = [];
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBeUndefined();
      expect(detected.cluster).toBeUndefined();
      expect(detected.accountId).toBeUndefined();
    });

    it('should detect metadata across different resource types', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: web-service
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  type: LoadBalancer
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
  labels:
    cluster: prod-db-cluster
spec:
  replicas: 3
---
apiVersion: v1
kind: Pod
metadata:
  name: job-pod
  annotations:
    aws.amazon.com/account-id: "555666777888"
spec:
  containers:
    - name: job
      image: alpine:latest`;

      const resources = parseHelmManifest(yaml);
      const detected = extractMetadataFromResources(resources);

      expect(detected.region).toBe('us-west-2');
      expect(detected.cluster).toBe('prod-db-cluster');
      expect(detected.accountId).toBe('555666777888');
    });
  });

  describe('ARN Building with Metadata', () => {
    it('should use detected metadata for ARN formation', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
  labels:
    topology.kubernetes.io/region: us-west-2
    cluster: prod-cluster
spec:
  replicas: 3`;

      const resources = parseHelmManifest(yaml);
      const resource = resources[0];

      // Simulate ARN building
      const region = resource.metadata?.region || 'unknown';
      const cluster = resource.metadata?.cluster || 'unknown';
      const namespace = resource.namespace || 'default';
      const arn = `${region}:${cluster}:${namespace}:${resource.kind}:${resource.name}`;

      expect(arn).toBe('us-west-2:prod-cluster:production:Deployment:web-app');
    });

    it('should handle missing metadata gracefully in ARN building', () => {
      const yaml = `---
apiVersion: v1
kind: Service
metadata:
  name: simple-service
spec:
  type: ClusterIP`;

      const resources = parseHelmManifest(yaml);
      const resource = resources[0];

      const region = resource.metadata?.region || 'unknown';
      const cluster = resource.metadata?.cluster || 'unknown';
      const namespace = resource.namespace || 'default';
      const arn = `${region}:${cluster}:${namespace}:${resource.kind}:${resource.name}`;

      expect(arn).toBe('unknown:unknown:default:Service:simple-service');
    });
  });

  describe('Metadata Priority and Fallbacks', () => {
    it('should use metadata from resource metadata object first', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    topology.kubernetes.io/region: us-west-2
    custom-region: eu-central-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      // Should use standard topology label
      expect(resources[0].metadata?.region).toBe('us-west-2');
    });

    it('should fallback to legacy labels when standard not present', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  labels:
    failure-domain.beta.kubernetes.io/region: ap-south-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.region).toBe('ap-south-1');
    });

    it('should use annotation when label not present', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  annotations:
    aws.amazon.com/region: sa-east-1
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);

      expect(resources[0].metadata?.awsRegion).toBe('sa-east-1');
    });
  });

  describe('Multiple Resources Metadata Aggregation', () => {
    it('should collect unique regions from all resources', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app2
  labels:
    topology.kubernetes.io/region: eu-central-1
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app3
  labels:
    topology.kubernetes.io/region: us-west-2
spec:
  replicas: 1`;

      const resources = parseHelmManifest(yaml);
      const uniqueRegions = new Set(
        resources.map(r => r.metadata?.region).filter(r => r !== undefined)
      );

      expect(uniqueRegions.size).toBe(2);
      expect(uniqueRegions).toContain('us-west-2');
      expect(uniqueRegions).toContain('eu-central-1');
    });

    it('should collect all ConfigMap references across resources', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
          envFrom:
            - configMapRef:
                name: config1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app2
spec:
  template:
    spec:
      volumes:
        - name: config
          configMap:
            name: config2
      containers:
        - name: app
          image: nginx:latest`;

      const resources = parseHelmManifest(yaml);
      const allConfigMaps = resources.flatMap(r => r.metadata?.configMapRefs || []);

      expect(allConfigMaps).toContain('config1');
      expect(allConfigMaps).toContain('config2');
    });

    it('should collect all container images across resources', () => {
      const yaml = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app1
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.19
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:14
---
apiVersion: batch/v1
kind: Job
metadata:
  name: migration
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: migrate:latest`;

      const resources = parseHelmManifest(yaml);
      const allImages = resources.flatMap(r => r.metadata?.images || []);

      expect(allImages).toContain('nginx:1.19');
      expect(allImages).toContain('postgres:14');
      expect(allImages).toContain('migrate:latest');
    });
  });
});
